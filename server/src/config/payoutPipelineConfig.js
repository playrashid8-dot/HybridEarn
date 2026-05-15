/**
 * Central tuning for payout / withdraw executor, sweep hardening, and optional BullMQ payout queue.
 * Keeps deposit pipeline env names untouched.
 */

function num(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const payoutPipelineConfig = {
  get payoutWalletLockMs() {
    return Math.min(900_000, Math.max(30_000, num(process.env.HYBRID_PAYOUT_WALLET_LOCK_MS, 240_000)));
  },
  get payoutQueueLimiterMax() {
    return Math.min(200, Math.max(1, num(process.env.HYBRID_PAYOUT_QUEUE_LIMITER_MAX, 12)));
  },
  get payoutQueueLimiterMs() {
    return Math.max(500, num(process.env.HYBRID_PAYOUT_QUEUE_LIMITER_MS, 1000));
  },
  get payoutJobAttempts() {
    return Math.min(20, Math.max(1, num(process.env.HYBRID_PAYOUT_JOB_ATTEMPTS, 5)));
  },
  get payoutJobBackoffMs() {
    return Math.max(1000, num(process.env.HYBRID_PAYOUT_JOB_BACKOFF_MS, 8000));
  },
  get payoutKeepFailedCount() {
    return Math.min(5000, Math.max(50, num(process.env.HYBRID_PAYOUT_KEEP_FAILED_COUNT, 500)));
  },
  get payoutQueueDepthWarn() {
    return Math.max(5, num(process.env.HYBRID_PAYOUT_QUEUE_BACKPRESSURE_AT, 24));
  },
  get nonceRedisMirrorTtlSec() {
    return Math.min(86_400, Math.max(300, num(process.env.HYBRID_NONCE_REDIS_MIRROR_TTL_SEC, 7200)));
  },
  get feeDataCacheMs() {
    return Math.min(120_000, Math.max(2000, num(process.env.HYBRID_FEE_DATA_CACHE_MS, 12_000)));
  },
  get chainHeadCacheMs() {
    return Math.min(60_000, Math.max(500, num(process.env.HYBRID_CHAIN_HEAD_CACHE_MS, 4500)));
  },
  get receiptInflightDedupeMs() {
    return Math.min(30_000, Math.max(200, num(process.env.HYBRID_RECEIPT_INFLIGHT_MS, 800)));
  },
};

export default payoutPipelineConfig;
