/**
 * Central tuning for realtime listener, recovery, and BullMQ deposit worker.
 */

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** @type {readonly string[]} */
const DEFAULT_DLQ_TAGS = ["deposit_fatal"];

export default {
  get depositQueueConcurrency() {
    const n = num(process.env.HYBRID_DEPOSIT_QUEUE_CONCURRENCY, 3);
    return Math.min(64, Math.max(1, Math.floor(n)));
  },
  get depositJobAttempts() {
    const n = num(process.env.HYBRID_DEPOSIT_JOB_ATTEMPTS, 4);
    return Math.min(20, Math.max(1, Math.floor(n)));
  },
  get depositJobBackoffMs() {
    const n = num(process.env.HYBRID_DEPOSIT_JOB_BACKOFF_MS, 3500);
    return Math.min(600_000, Math.max(500, Math.floor(n)));
  },
  get depositTxLockMs() {
    const n = num(process.env.HYBRID_DEPOSIT_TX_LOCK_MS, 180_000);
    return Math.min(900_000, Math.max(30_000, Math.floor(n)));
  },
  get recoveryMinBatchBlocks() {
    return Math.min(500, Math.max(5, Math.floor(num(process.env.HYBRID_RECOVERY_MIN_BATCH, 25))));
  },
  get recoveryMaxBatchBlocks() {
    return Math.min(500, Math.max(10, Math.floor(num(process.env.HYBRID_RECOVERY_MAX_BATCH, 120))));
  },
  /** Periodic HTTP tail recovery sweep (backup to WS) — avoids overlapping 60s storms with tail rescan. */
  get recoveryPeriodicIntervalMs() {
    const n = num(process.env.HYBRID_RECOVERY_PERIODIC_MS, 180_000);
    return Math.min(1_800_000, Math.max(60_000, Math.floor(n)));
  },
  /** Deeper reconciliation sweep interval (fewer RPC spikes than former 10m cadence defaults). */
  get recoveryDeepIntervalMs() {
    const n = num(process.env.HYBRID_RECOVERY_DEEP_MS, 900_000);
    return Math.min(7_200_000, Math.max(300_000, Math.floor(n)));
  },
  get recoveryPeriodicTailBlocks() {
    return Math.min(5_000, Math.max(20, Math.floor(num(process.env.HYBRID_RECOVERY_PERIODIC_BLOCKS, 100))));
  },
  get recoveryDeepTailBlocks() {
    return Math.min(50_000, Math.max(200, Math.floor(num(process.env.HYBRID_RECOVERY_DEEP_BLOCKS, 1200))));
  },
  /** WebSocket-head cache for realtime confirmation gate (fewer RPCs per Transfer burst). */
  get realtimeChainHeadCacheMs() {
    const n = num(process.env.HYBRID_REALTIME_HEAD_CACHE_MS, 2800);
    return Math.min(15_000, Math.max(800, Math.floor(n)));
  },
  get tailSafetyRescanIntervalMs() {
    const n = num(process.env.HYBRID_TAIL_RESCAN_INTERVAL_MS, 120_000);
    return Math.min(600_000, Math.max(45_000, Math.floor(n)));
  },
  get tailSafetyRescanBlocks() {
    return Math.min(500, Math.max(6, Math.floor(num(process.env.HYBRID_TAIL_RESCAN_BLOCKS, 14))));
  },
  get redisEnqueueHealthCacheMs() {
    const n = num(process.env.HYBRID_REDIS_ENQUEUE_HEALTH_MS, 8000);
    return Math.min(120_000, Math.max(2000, Math.floor(n)));
  },
  /** In-memory wallet registry refresh cadence — larger = fewer full User scans. */
  get userMapRefreshMs() {
    const n = num(process.env.HYBRID_USER_MAP_REFRESH_MS, 600_000);
    return Math.min(3_600_000, Math.max(120_000, Math.floor(n)));
  },
  get wsHeartbeatIntervalMs() {
    const n = num(process.env.HYBRID_WS_HEARTBEAT_MS, 45_000);
    return Math.min(300_000, Math.max(15_000, Math.floor(n)));
  },
  get wsStaleMs() {
    const n = num(process.env.HYBRID_WS_STALE_MS, 120_000);
    return Math.min(600_000, Math.max(45_000, Math.floor(n)));
  },
  get wsReconnectBackoffBaseMs() {
    const n = num(process.env.HYBRID_WS_RECONNECT_BASE_MS, 900);
    return Math.min(60_000, Math.max(250, Math.floor(n)));
  },
  get wsReconnectBackoffMaxMs() {
    const n = num(process.env.HYBRID_WS_RECONNECT_CAP_MS, 60_000);
    return Math.min(300_000, Math.max(2000, Math.floor(n)));
  },
  get monitorIntervalMs() {
    const n = num(process.env.HYBRID_PIPELINE_MONITOR_MS, 60_000);
    return Math.min(300_000, Math.max(15_000, Math.floor(n)));
  },
  get depositDlqTag() {
    return String(process.env.HYBRID_DEPOSIT_DLQ_TAG || "deposit_dlq_final").trim() || "deposit_dlq_final";
  },
  getDlqLabels() {
    const raw = String(process.env.HYBRID_DEPOSIT_DLQ_LABELS || DEFAULT_DLQ_TAGS.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return raw.length > 0 ? raw : [...DEFAULT_DLQ_TAGS];
  },
};
