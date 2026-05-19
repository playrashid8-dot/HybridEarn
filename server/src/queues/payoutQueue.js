import { Queue } from "bullmq";
import { getRedis, isRedisReady } from "../config/redis.js";
import payoutPipelineConfig from "../config/payoutPipelineConfig.js";
import { registerShutdownHook } from "../infra/processLifecycle.js";
import logger from "../utils/logger.js";

const connection = getRedis();

export const HYBRID_PAYOUT_QUEUE_NAME = "hybridPayout";
export const HYBRID_PAYOUT_QUEUE_PREFIX = "bull";
export const HYBRID_PAYOUT_JOB_PRIORITIES = Object.freeze({
  roiClaim: 1,
  withdrawBatch: 5,
});
const ROI_JOB_STATUSES = new Set(["queued", "processing", "broadcasting", "completed", "failed"]);

export const PAYOUT_JOB_OPTIONS = {
  attempts: payoutPipelineConfig.payoutJobAttempts,
  backoff: {
    type: "exponential",
    delay: payoutPipelineConfig.payoutJobBackoffMs,
  },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: payoutPipelineConfig.payoutKeepFailedCount },
};

function getPayoutJobPriority(jobName) {
  if (jobName === "roi_claim") return HYBRID_PAYOUT_JOB_PRIORITIES.roiClaim;
  if (jobName === "withdraw_batch") return HYBRID_PAYOUT_JOB_PRIORITIES.withdrawBatch;
  return null;
}

function createPayoutQueue() {
  if (!connection) {
    return null;
  }
  try {
    return new Queue(HYBRID_PAYOUT_QUEUE_NAME, {
      connection,
      prefix: HYBRID_PAYOUT_QUEUE_PREFIX,
      limiter: {
        max: payoutPipelineConfig.payoutQueueLimiterMax,
        duration: payoutPipelineConfig.payoutQueueLimiterMs,
      },
      defaultJobOptions: PAYOUT_JOB_OPTIONS,
    });
  } catch (err) {
    logger.error("hybrid payout queue bootstrap failed", { error: err?.message || String(err) });
    return null;
  }
}

export const payoutQueue = createPayoutQueue();

if (payoutQueue) {
  registerShutdownHook("hybrid_payout_queue_producer", async () => {
    await payoutQueue.close().catch(() => {});
  });
}

function parseRedisUrlIdentity() {
  const url = String(process.env.REDIS_URL || "").trim();
  if (!url) return {};
  try {
    const parsed = new URL(url);
    return {
      redisHost: parsed.hostname || "unknown",
      redisPort: parsed.port || "6379",
      redisDb: String(parsed.pathname || "/0").replace("/", "") || "0",
    };
  } catch {
    return {};
  }
}

export function getPayoutBullMqRuntimeIdentity(redis = connection) {
  const fallback = parseRedisUrlIdentity();
  const opts = redis?.options || {};
  const redisHost = String(opts.host || fallback.redisHost || "unknown");
  const redisPort = String(opts.port || fallback.redisPort || "6379");
  const redisDb = String(opts.db ?? fallback.redisDb ?? "0");
  return {
    queueName: HYBRID_PAYOUT_QUEUE_NAME,
    prefix: HYBRID_PAYOUT_QUEUE_PREFIX,
    bullmqNamespace: `${HYBRID_PAYOUT_QUEUE_PREFIX}:${HYBRID_PAYOUT_QUEUE_NAME}`,
    redisHost,
    redisPort,
    redisDb,
    redisStatus: redis?.status || "missing",
  };
}

payoutQueue?.on("error", (err) => {
  logger.error("Hybrid payout queue connection error", {
    ...getPayoutBullMqRuntimeIdentity(),
    error: err?.message || String(err),
  });
});

/**
 * Enqueue a withdraw-executor batch (serialized by worker concurrency).
 * @returns {Promise<{ ok: boolean; reason?: string; depth?: number }>}
 */
export async function enqueuePayoutWithdrawBatch(limit = 1) {
  if (!payoutQueue || !isRedisReady(connection)) {
    logger.throttledWarn(
      "payout_enqueue_no_queue",
      "Payout enqueue skipped — BullMQ payout queue unavailable",
      {
        ...getPayoutBullMqRuntimeIdentity(),
      },
      45_000,
    );
    return { ok: false, reason: "no_queue" };
  }
  try {
    const counts = await payoutQueue.getJobCounts("waiting", "delayed", "active");
    const depth =
      Number(counts.waiting || 0) + Number(counts.delayed || 0) + Number(counts.active || 0);
    if (depth >= payoutPipelineConfig.payoutQueueDepthWarn) {
      logger.throttledWarn(
        "payout_queue_backpressure",
        "Payout enqueue skipped — backlog at cap (backpressure)",
        { depth, cap: payoutPipelineConfig.payoutQueueDepthWarn },
        45_000,
      );
      return { ok: false, reason: "backpressure", depth };
    }
    const job = await payoutQueue.add(
      "withdraw_batch",
      { limit: Math.max(1, Number(limit) || 1), enqueuedAt: Date.now() },
      {
        ...PAYOUT_JOB_OPTIONS,
        priority: HYBRID_PAYOUT_JOB_PRIORITIES.withdrawBatch,
        jobId: `wb:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`,
      },
    );
    logger.info("Hybrid payout withdraw batch enqueued", {
      ...getPayoutBullMqRuntimeIdentity(),
      jobId: job?.id,
      limit: Math.max(1, Number(limit) || 1),
      priority: HYBRID_PAYOUT_JOB_PRIORITIES.withdrawBatch,
      depthBeforeEnqueue: depth,
    });
    return { ok: true, depth };
  } catch (err) {
    logger.error("hybrid payout queue add failed", { error: err?.message || String(err) });
    return { ok: false, reason: err?.message || "enqueue_failed" };
  }
}

/**
 * Re-prioritize legacy waiting jobs created before priorities were introduced.
 * BullMQ treats old no-priority jobs ahead of prioritized jobs, so startup normalization
 * is required to clear an existing production backlog without orphaning jobs.
 */
export async function normalizePayoutQueueJobPriorities(limit = 250) {
  if (!payoutQueue || !isRedisReady(connection)) {
    return { ok: false, reason: "no_queue", scanned: 0, updated: 0, failed: 0 };
  }

  const cap = Math.min(1000, Math.max(1, Number(limit) || 250));
  const waitingJobs = await payoutQueue.getWaiting(0, cap - 1);
  let updated = 0;
  let failed = 0;

  for (const job of waitingJobs) {
    const desiredPriority = getPayoutJobPriority(job?.name);
    if (!desiredPriority || typeof job?.changePriority !== "function") {
      continue;
    }

    try {
      await job.changePriority({ priority: desiredPriority });
      updated += 1;
    } catch (err) {
      failed += 1;
      logger.warn("Hybrid payout queue priority normalization skipped job", {
        ...getPayoutBullMqRuntimeIdentity(),
        jobId: job?.id,
        jobName: job?.name,
        desiredPriority,
        error: err?.message || String(err),
      });
    }
  }

  if (updated > 0 || failed > 0) {
    logger.info("Hybrid payout queue priority normalization completed", {
      ...getPayoutBullMqRuntimeIdentity(),
      scanned: waitingJobs.length,
      updated,
      failed,
      priorities: HYBRID_PAYOUT_JOB_PRIORITIES,
    });
  }

  return { ok: true, scanned: waitingJobs.length, updated, failed };
}

/**
 * Queue-backed ROI claim with BullMQ job idempotency per PKT claim window.
 * Requires worker with `HYBRID_PAYOUT_QUEUE_WORKER=true` (or hybrid-service flag).
 */
export async function enqueueRoiClaimJob(userId, claimWindowStartMs) {
  if (!payoutQueue || !isRedisReady(connection)) {
    logger.throttledWarn(
      "roi_enqueue_no_queue",
      "ROI claim enqueue skipped — BullMQ payout queue unavailable",
      {
        ...getPayoutBullMqRuntimeIdentity(),
      },
      45_000,
    );
    return { ok: false, reason: "no_queue" };
  }
  const wid = String(userId || "").trim();
  const ck = Number(claimWindowStartMs);
  if (!wid || !Number.isFinite(ck)) {
    return { ok: false, reason: "invalid_payload" };
  }
  const jobId = `roi:${wid}:${ck}`;
  try {
    const existing = await payoutQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState().catch(() => "unknown");
      logger.warn("Hybrid ROI existing job detected", {
        ...getPayoutBullMqRuntimeIdentity(),
        jobId,
        userId: wid,
        jobName: existing.name,
        existingState: state,
        attemptsMade: existing.attemptsMade,
        returnvalue: existing.returnvalue ?? null,
        failedReason: existing.failedReason ?? null,
      });

      if (state === "failed") {
        logger.warn("Removing stale failed ROI job before requeue", {
          ...getPayoutBullMqRuntimeIdentity(),
          jobId,
          userId: wid,
          jobName: existing.name,
          failedReason: existing.failedReason ?? null,
        });
        await existing.remove();
      } else {
        return { ok: true, deduped: true, jobId, job: existing };
      }
    }

    const job = await payoutQueue.add(
      "roi_claim",
      { userId: wid, claimWindowStartMs: ck },
      {
        ...PAYOUT_JOB_OPTIONS,
        priority: HYBRID_PAYOUT_JOB_PRIORITIES.roiClaim,
        jobId,
      },
    );
    logger.info("Hybrid ROI claim job enqueued", {
      ...getPayoutBullMqRuntimeIdentity(),
      jobId: job?.id || jobId,
      jobName: "roi_claim",
      userId: wid,
      claimWindowStartMs: ck,
      priority: HYBRID_PAYOUT_JOB_PRIORITIES.roiClaim,
      attemptsMade: job?.attemptsMade ?? 0,
    });
    return { ok: true, jobId: job?.id || jobId, job };
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (/already exists|duplicate|JobId/i.test(msg)) {
      logger.warn("Hybrid ROI claim duplicate job detected during enqueue", {
        ...getPayoutBullMqRuntimeIdentity(),
        jobId,
        userId: wid,
        failedReason: msg,
      });
      return { ok: true, deduped: true, jobId };
    }
    logger.error("ROI claim queue add failed", {
      ...getPayoutBullMqRuntimeIdentity(),
      jobId,
      userId: wid,
      failedReason: msg,
    });
    return { ok: false, reason: msg };
  }
}

function normalizeRoiJobStatus(state, progress) {
  if (state === "completed") return "completed";
  if (state === "failed") return "failed";

  if (progress && typeof progress === "object") {
    const progressStatus = String(progress.status || "").toLowerCase();
    if (ROI_JOB_STATUSES.has(progressStatus)) {
      return progressStatus;
    }
  }

  if (state === "active") return "processing";
  return "queued";
}

function safeReturnValue(returnvalue) {
  if (!returnvalue || typeof returnvalue !== "object") {
    return null;
  }
  return returnvalue;
}

export async function getRoiClaimJobStatus(userId, claimWindowStartMs, requestedJobId = null) {
  if (!payoutQueue || !isRedisReady(connection)) {
    return { ok: false, reason: "no_queue" };
  }

  const wid = String(userId || "").trim();
  const ck = Number(claimWindowStartMs);
  if (!wid || !Number.isFinite(ck)) {
    return { ok: false, reason: "invalid_payload" };
  }

  const expectedJobId = `roi:${wid}:${ck}`;
  const jobId = String(requestedJobId || expectedJobId).trim();
  if (jobId !== expectedJobId) {
    return { ok: false, reason: "invalid_job", jobId: expectedJobId };
  }

  const job = await payoutQueue.getJob(jobId);
  if (!job) {
    return {
      ok: true,
      exists: false,
      jobId,
      status: "queued",
      state: "missing",
      returnvalue: null,
      failedReason: null,
    };
  }

  const state = await job.getState().catch(() => "unknown");
  const progress = job.progress && typeof job.progress === "object" ? job.progress : {};
  const status = normalizeRoiJobStatus(state, progress);

  return {
    ok: true,
    exists: true,
    jobId: job.id,
    status,
    state,
    progress,
    attemptsMade: job.attemptsMade,
    processedOn: job.processedOn || null,
    finishedOn: job.finishedOn || null,
    returnvalue: safeReturnValue(job.returnvalue),
    failedReason: job.failedReason || null,
  };
}
