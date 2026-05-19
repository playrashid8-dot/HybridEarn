import { Queue } from "bullmq";
import depositPipelineConfig from "../config/depositPipelineConfig.js";
import logger from "../utils/logger.js";
import { getRedis, isRedisReady } from "../config/redis.js";
import { registerShutdownHook } from "../infra/processLifecycle.js";
import { WORKER_HEARTBEAT_KEY } from "./workerSignals.js";

const connection = getRedis();

/** Cached Redis ping + heartbeat to avoid redundant round-trips during WS bursts */
let enqueueGateCache = {
  touchedAtMs: 0,
  pingOk: false,
  heartbeatOk: false,
};

async function redisEnqueuePrecheck({
  redis,
  skipWorkerHeartbeatCheck = false,
}) {
  const now = Date.now();
  const ttl = depositPipelineConfig.redisEnqueueHealthCacheMs;

  if (
    now - enqueueGateCache.touchedAtMs < ttl &&
    enqueueGateCache.pingOk &&
    (skipWorkerHeartbeatCheck === true || enqueueGateCache.heartbeatOk)
  ) {
    return { redisOk: true, deferHeartbeat: false };
  }

  const pingOk = Boolean(await redis.ping().catch(() => null));
  if (!pingOk) {
    enqueueGateCache = { touchedAtMs: now, pingOk: false, heartbeatOk: false };
    return { redisOk: false };
  }

  enqueueGateCache.pingOk = true;

  if (skipWorkerHeartbeatCheck === true) {
    enqueueGateCache = { touchedAtMs: now, pingOk: true, heartbeatOk: true };
    return { redisOk: true, deferHeartbeat: false };
  }

  try {
    const heartbeat = await redis.get(WORKER_HEARTBEAT_KEY);
    if (!heartbeat) {
      enqueueGateCache = { touchedAtMs: now, pingOk: true, heartbeatOk: false };
      return { redisOk: true, deferHeartbeat: true };
    }

    enqueueGateCache = { touchedAtMs: now, pingOk: true, heartbeatOk: true };
    return { redisOk: true, deferHeartbeat: false };
  } catch (err) {
    enqueueGateCache = { touchedAtMs: now, pingOk: true, heartbeatOk: false };
    return { redisOk: true, deferHeartbeat: false, heartbeatErr: err };
  }
}

/** Shared BullMQ worker / queue tuning: max jobs started per duration (global per queue in Redis). */
export const DEPOSIT_QUEUE_LIMITER = {
  max: Number(process.env.HYBRID_DEPOSIT_QUEUE_LIMITER_MAX || 50),
  duration: Number(process.env.HYBRID_DEPOSIT_QUEUE_LIMITER_MS || 1000),
};

function createDepositQueue() {
  if (!connection) {
    return null;
  }

  try {
    return new Queue("depositQueue", {
      connection,
      limiter: DEPOSIT_QUEUE_LIMITER,
      defaultJobOptions: DEPOSIT_JOB_OPTIONS,
    });
  } catch (err) {
    logger.error("deposit queue bootstrap failed", { error: err?.message || String(err) });
    return null;
  }
}

/** Shared BullMQ options for deposit jobs (retries / backoff / BullMQ-enforced uniqueness via jobId = tx hash). */
export const DEPOSIT_JOB_OPTIONS = {
  attempts: depositPipelineConfig.depositJobAttempts,
  backoff: {
    type: "exponential",
    delay: depositPipelineConfig.depositJobBackoffMs,
  },
  /** Frees BullMQ bookkeeping after success — duplicate chain hash can enqueue again intentionally if ledger cleared manually. */
  removeOnComplete: true,
  removeOnFail: {
    count: Number(process.env.HYBRID_DEPOSIT_KEEP_FAILED_COUNT || 2000),
  },
};

export const depositQueue = createDepositQueue();

if (depositQueue) {
  registerShutdownHook("deposit_queue_producer", async () => {
    await depositQueue.close().catch(() => {});
  });
}

let depositQueueErrorLogged = false;

depositQueue?.on("error", (err) => {
  if (!isRedisReady(connection)) {
    return;
  }

  enqueueGateCache = {
    touchedAtMs: 0,
    pingOk: false,
    heartbeatOk: false,
  };

  if (!depositQueueErrorLogged) {
    depositQueueErrorLogged = true;
    logger.error("deposit queue emitter error", { error: err?.message || String(err) });
  }
});

/** JSON-serializable copy of an ethers Transfer log for Redis / BullMQ */
export function toSerializableTransferLog(log) {
  if (!log?.transactionHash) return null;
  const bn = log.blockNumber;
  const blockNumber =
    bn != null && Number.isFinite(Number(bn))
      ? Number(bn)
      : undefined;

  return {
    transactionHash: log.transactionHash,
    topics: [...(log.topics || [])],
    data: log.data,
    blockNumber,
    ...(log.address != null && String(log.address).trim() !== ""
      ? { address: String(log.address).trim() }
      : {}),
  };
}

/**
 * @param {{ log: object, blockNumber?: number, skipWorkerHeartbeatCheck?: boolean, traceId?: string }} payload
 * @returns {Promise<
 *   | { kind: "queued"; job: import("bullmq").Job | null }
 *   | { kind: "defer" }
 *   | { kind: "direct" }
 * >}
 */
export async function enqueueDepositJob({
  log,
  blockNumber,
  skipWorkerHeartbeatCheck = false,
  traceId: traceIdOpt,
}) {
  const redis = connection;
  if (!redis || redis.status !== "ready" || !depositQueue) {
    return { kind: "direct" };
  }

  const pre = await redisEnqueuePrecheck({
    redis,
    skipWorkerHeartbeatCheck,
  });

  if (!pre.redisOk) {
    logger.throttledWarn(
      "redis_ping_deposit_enqueue",
      "Redis ping failed — direct deposit fallback path MAY activate",
      {},
    );
    return { kind: "direct" };
  }

  if (pre.deferHeartbeat) {
    logger.throttledWarn(
      "deposit_queue_heartbeat_miss",
      "deposit queue warmup — heartbeat missing yet",
      {},
      Math.min(depositPipelineConfig.redisEnqueueHealthCacheMs, 12_000),
    );
    return { kind: "defer" };
  }

  if (pre.heartbeatErr) {
    logger.throttledWarn(
      "deposit_heartbeat_redis_io",
      "deposit heartbeat read failed — defer queue path",
      {
        error: pre.heartbeatErr?.message || String(pre.heartbeatErr),
      },
    );
    return { kind: "defer" };
  }

  const merged = {
    ...log,
    blockNumber: blockNumber !== undefined ? blockNumber : log?.blockNumber,
  };

  const txHash = String(merged.transactionHash || "").trim().toLowerCase();
  if (!txHash) {
    logger.error("enqueueDepositJob missing transaction hash", {});
    throw new Error("enqueueDepositJob: transactionHash required");
  }

  const traceId =
    typeof traceIdOpt === "string" && traceIdOpt.length > 0
      ? traceIdOpt
      : `${txHash}_${Date.now()}`;

  const addOpts = {
    ...DEPOSIT_JOB_OPTIONS,
    jobId: txHash,
  };

  try {
    const job = await depositQueue.add(
      "deposit",
      {
        log: merged,
        blockNumber: merged.blockNumber,
      },
      addOpts,
    );
    logger.debug?.("deposit job enqueued", { traceId, txHashPartial: `${txHash.slice(0, 12)}…` });
    return { kind: "queued", job };
  } catch (err) {
    if (!redis || redis.status !== "ready") {
      return { kind: "direct" };
    }

    const msg = err?.message || String(err);
    if (/already exists|duplicate|JobId/i.test(msg)) {
      logger.debug?.("deposit job enqueue dedup hit", {
        traceId,
        txHashPartial: `${txHash.slice(0, 12)}…`,
      });
      return { kind: "queued", job: null };
    }
    logger.error("deposit queue add failed fatally", { error: msg, traceId });
    throw err;
  }
}
