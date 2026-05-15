import { Queue } from "bullmq";
import { getRedis, isRedisReady } from "../config/redis.js";
import payoutPipelineConfig from "../config/payoutPipelineConfig.js";
import logger from "../utils/logger.js";

const connection = getRedis();

export const HYBRID_PAYOUT_QUEUE_NAME = "hybridPayout";

export const PAYOUT_JOB_OPTIONS = {
  attempts: payoutPipelineConfig.payoutJobAttempts,
  backoff: {
    type: "exponential",
    delay: payoutPipelineConfig.payoutJobBackoffMs,
  },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: payoutPipelineConfig.payoutKeepFailedCount },
};

function createPayoutQueue() {
  if (!connection) {
    return null;
  }
  try {
    return new Queue(HYBRID_PAYOUT_QUEUE_NAME, {
      connection,
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

/**
 * Enqueue a withdraw-executor batch (serialized by worker concurrency).
 * @returns {Promise<{ ok: boolean; reason?: string; depth?: number }>}
 */
export async function enqueuePayoutWithdrawBatch(limit = 1) {
  if (!payoutQueue || !isRedisReady(connection)) {
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
    await payoutQueue.add(
      "withdraw_batch",
      { limit: Math.max(1, Number(limit) || 1), enqueuedAt: Date.now() },
      {
        ...PAYOUT_JOB_OPTIONS,
        jobId: `wb:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`,
      },
    );
    return { ok: true, depth };
  } catch (err) {
    logger.error("hybrid payout queue add failed", { error: err?.message || String(err) });
    return { ok: false, reason: err?.message || "enqueue_failed" };
  }
}

/**
 * Queue-backed ROI claim with BullMQ job idempotency per PKT claim window.
 * Requires worker with `HYBRID_PAYOUT_QUEUE_WORKER=true` (or hybrid-service flag).
 */
export async function enqueueRoiClaimJob(userId, claimWindowStartMs) {
  if (!payoutQueue || !isRedisReady(connection)) {
    return { ok: false, reason: "no_queue" };
  }
  const wid = String(userId || "").trim();
  const ck = Number(claimWindowStartMs);
  if (!wid || !Number.isFinite(ck)) {
    return { ok: false, reason: "invalid_payload" };
  }
  try {
    await payoutQueue.add(
      "roi_claim",
      { userId: wid, claimWindowStartMs: ck },
      {
        ...PAYOUT_JOB_OPTIONS,
        jobId: `roi:${wid}:${ck}`,
      },
    );
    return { ok: true };
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (/already exists|duplicate|JobId/i.test(msg)) {
      return { ok: true, deduped: true };
    }
    logger.error("ROI claim queue add failed", { error: msg });
    return { ok: false, reason: msg };
  }
}
