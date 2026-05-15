import "./config/loadEnv.js";

import connectDB from "./config/db.js";
import depositPipelineConfig from "./config/depositPipelineConfig.js";
import { Worker, QueueEvents } from "bullmq";
import {
  connectRedisInBackground,
  getRedis,
  isRedisReady,
} from "./config/redis.js";
import logger from "./utils/logger.js";
import { depositQueue } from "./queues/depositQueue.js";
import {
  registerDepositWorkerInstance,
  registerGlobalProcessHandlers,
  registerPayoutWorkerInstance,
  registerShutdownHook,
} from "./infra/processLifecycle.js";
import {
  WORKER_HEARTBEAT_ALT_KEY,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_SECONDS,
  PAYOUT_WORKER_HEARTBEAT_KEY,
  PAYOUT_WORKER_HEARTBEAT_TTL_SECONDS,
} from "./queues/workerSignals.js";
import { HYBRID_PAYOUT_QUEUE_NAME } from "./queues/payoutQueue.js";
import { startDepositPipelineMonitor } from "./infra/runtimeDepositMonitor.js";

registerGlobalProcessHandlers("deposit-worker");

await connectDB();

try {
  await connectRedisInBackground();
} catch (err) {
  logger.error("Worker Redis handshake failed — idle", {
    error: err?.message || String(err),
  });
}

/** Recovery remains opt-in — API/hybrid replicas still orchestrate checkpoints by default */
const workerWantsFullRecoveryOnStart =
  String(process.env.HYBRID_WORKER_FULL_RECOVERY_ON_START || "").trim().toLowerCase() === "true";

const skipWorkerFullRecovery =
  String(process.env.HYBRID_WORKER_SKIP_FULL_RECOVERY_ON_START || "").trim().toLowerCase() === "true";

if (workerWantsFullRecoveryOnStart && !skipWorkerFullRecovery) {
  logger.warn("Hybrid worker opting into full-chain recovery bootstrap", {});
  try {
    const { runFullRecoveryScan } = await import("./hybrid/services/depositBackfill.js");
    await runFullRecoveryScan();
  } catch (err) {
    logger.error("Worker synchronous recovery boot failed — continuing Bull worker", {
      error: err?.message || String(err),
    });
  }
}

const connection = getRedis();

if (!isRedisReady(connection)) {
  logger.warn("Redis missing — deposit worker idle (queue jobs will accumulate)", {});
} else {
  const writeWorkerHeartbeat = async () => {
    if (!isRedisReady(connection)) {
      return;
    }

    try {
      const ts = String(Date.now());
      await Promise.all([
        connection.set(WORKER_HEARTBEAT_KEY, ts, "EX", WORKER_HEARTBEAT_TTL_SECONDS),
        connection.set(WORKER_HEARTBEAT_ALT_KEY, ts, "EX", WORKER_HEARTBEAT_TTL_SECONDS),
      ]);
    } catch (err) {
      logger.error("Worker heartbeat write failed — operators should inspect Redis coupling", {
        error: err?.message || String(err),
      });
    }
  };

  const workerConcurrency = depositPipelineConfig.depositQueueConcurrency;
  const stalledInterval = Number(process.env.HYBRID_QUEUE_STALLED_INTERVAL_MS || 30_000);
  const maxStalledCount = Number(process.env.HYBRID_QUEUE_MAX_STALLED_COUNT || 2);
  const lockDurationMs = Number(
    process.env.HYBRID_DEPOSIT_JOB_LOCK_DURATION_MS ||
      depositPipelineConfig.depositTxLockMs + 120_000,
  );

  const worker = new Worker(
    "depositQueue",
    async (job) => {
      const { processDepositJob } = await import("./hybrid/services/depositService.js");
      return processDepositJob(job.data);
    },
    {
      connection,
      concurrency: workerConcurrency,
      autorun: true,
      lockDuration: Math.min(720_000, Math.max(15_000, lockDurationMs)),
      stalledInterval: Math.min(180_000, Math.max(5000, stalledInterval)),
      maxStalledCount: Math.min(10, Math.max(1, maxStalledCount)),
    },
  );

  registerDepositWorkerInstance(worker);

  const queueEvents =
    depositQueue &&
    connection &&
    new QueueEvents("depositQueue", {
      connection,
      autorun: true,
    });

  if (queueEvents) {
    try {
      await queueEvents.waitUntilReady();
      queueEvents.on("stalled", ({ jobId }) => {
        logger.warn("Deposit queue stalled job detected — watchdog will reschedule", {
          jobIdPreview: sanitizeJobId(jobId),
        });
      });
      queueEvents.on("failed", ({ jobId, failedReason }) => {
        logger.warn("Deposit queue job transitioned to failure state", {
          jobIdPreview: sanitizeJobId(jobId),
          reason: sanitizeMetaReason(failedReason),
        });
      });
    } catch (err) {
      logger.warn("Deposit queue telemetry channel unavailable", {
        error: err?.message || String(err),
      });
    }

    registerShutdownHook("deposit_queue_events", async () => {
      try {
        await queueEvents.close();
      } catch (_) {
        /* intentionally quiet */
      }
    });
  }

  await writeWorkerHeartbeat();
  const heartbeatIntervalMs = Number(process.env.WORKER_HEARTBEAT_WRITE_MS || 30_000);
  global.setInterval(() => {
    void writeWorkerHeartbeat();
  }, Math.min(120_000, Math.max(10_000, heartbeatIntervalMs)));

  worker.on("completed", (job, result) => {
    if (global.gc) {
      global.gc();
    }

    const txHash = sanitizeTx(job, result).txHash;

    const processedDelta = Number(result?.processedDelta);
    if (!txHash || !Number.isFinite(processedDelta) || processedDelta <= 0) {
      return;
    }

    logger.debug?.("deposit job completed cleanly", {
      txHashPartial: `${txHash.slice(0, 12)}…`,
      userPreview: `${String(result?.userId || "").slice(0, 8)}`,
    });
  });

  worker.on("failed", (job, err) => {
    const { txHash, traceFallback } = sanitizeTx(job);

    logger.error("Deposit worker job marked failed after BullMQ bookkeeping", {
      traceId: traceFallback,
      txHashPartial: txHash ? `${txHash.slice(0, 16)}…` : txHash || "(unknown)",
      error: err?.message || String(err),
      attemptsMade: job?.attemptsMade,
      attemptsBudget: job?.opts?.attempts,
      phase: "worker.failed_event",
    });

    const attemptsBudget = Number(job?.opts?.attempts || 1);
    const exhausted =
      attemptsBudget <= 1
        ? true
        : Number(job?.attemptsMade || 0) >= attemptsBudget;

    if (exhausted) {
      logger.error(`${depositPipelineConfig.depositDlqTag.toUpperCase()}_OBSERVED`, {
        labels: depositPipelineConfig.getDlqLabels(),
        txHashPartial: txHash ? `${txHash.slice(0, 18)}…` : txHash,
        reason: err?.message || String(err || "deposit fatal"),
      });
    }
  });

  logger.info(`Worker running (concurrency ${workerConcurrency}, lock=${lockDurationMs}ms)`);

  const payoutQueueWanted =
    String(process.env.HYBRID_PAYOUT_QUEUE_WORKER || "").toLowerCase() === "true";
  if (payoutQueueWanted) {
    const payoutConc = Math.max(1, Math.min(4, Number(process.env.HYBRID_PAYOUT_WORKER_CONCURRENCY || 1)));
    const payoutWorker = new Worker(
      HYBRID_PAYOUT_QUEUE_NAME,
      async (job) => {
        const { processHybridPayoutJob } = await import("./hybrid/services/payoutQueueProcessor.js");
        return processHybridPayoutJob({ name: job.name, data: job.data });
      },
      {
        connection,
        concurrency: payoutConc,
        autorun: true,
        lockDuration: Math.min(600_000, Math.max(60_000, Number(process.env.HYBRID_PAYOUT_JOB_LOCK_MS || 240000))),
        stalledInterval: Math.min(180_000, Math.max(15_000, Number(process.env.HYBRID_PAYOUT_STALLED_INTERVAL_MS || 45000))),
        maxStalledCount: Math.min(8, Math.max(1, Number(process.env.HYBRID_PAYOUT_MAX_STALLED_COUNT || 2))),
      },
    );
    registerPayoutWorkerInstance(payoutWorker);
    const writePayoutHb = async () => {
      if (!isRedisReady(connection)) return;
      try {
        await connection.set(
          PAYOUT_WORKER_HEARTBEAT_KEY,
          String(Date.now()),
          "EX",
          PAYOUT_WORKER_HEARTBEAT_TTL_SECONDS,
        );
      } catch (err) {
        logger.error("Payout worker heartbeat write failed", {
          error: err?.message || String(err),
        });
      }
    };
    await writePayoutHb();
    global.setInterval(() => {
      void writePayoutHb();
    }, Math.min(120_000, Math.max(10_000, Number(process.env.HYBRID_PAYOUT_WORKER_HEARTBEAT_MS || 25_000))));

    payoutWorker.on("failed", (job, err) => {
      logger.error("Hybrid payout worker job failed", {
        jobName: job?.name,
        error: err?.message || String(err),
        attemptsMade: job?.attemptsMade,
      });
    });

    logger.info(`Hybrid payout worker running (concurrency ${payoutConc})`);
  }

  if (process.env.DISABLE_PAYOUT_INFRA_MONITOR?.toLowerCase() !== "true") {
    try {
      const { startPayoutInfrastructureMonitor } = await import("./hybrid/utils/payoutInfraMonitor.js");
      startPayoutInfrastructureMonitor();
    } catch (err) {
      logger.warn("Payout infra monitor not started", { error: err?.message || String(err) });
    }
  }

  if (process.env.DISABLE_WORKER_PIPELINE_MONITOR?.toLowerCase() !== "true") {
    startDepositPipelineMonitor({ role: `deposit-worker#${workerConcurrency}`, forceWorkerAssumeAlive: true });
  }
}

global.setInterval(() => {
  if (logger.isMinimalProd === false && process.env.NODE_ENV !== "production") {
    logger.debug?.("deposit worker ticker — alive", {});
  }
}, 300_000);

function sanitizeTx(job, result = null) {
  const extracted = String(job?.data?.log?.transactionHash || job?.id || result?.txHash || "")
    .trim()
    .toLowerCase();
  const fallbackTrace = extracted ? `${extracted}_${Date.now()}` : `unknown_${Date.now()}`;
  return { txHash: extracted, traceFallback: fallbackTrace };
}

function sanitizeJobId(jobId) {
  if (jobId == null) return "unknown_job";
  const text = String(jobId);
  if (text.startsWith("0x")) {
    return `${text.slice(0, 10)}…${text.slice(-4)}`;
  }
  return text.length > 32 ? `${text.slice(0, 18)}…` : text;
}

function sanitizeMetaReason(reason) {
  const text = typeof reason === "string" ? reason : String(reason ?? "");
  if (text.length > 380) return `${text.slice(0, 380)}…`;
  return text;
}
