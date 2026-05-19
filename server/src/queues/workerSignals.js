/** Canonical heartbeat keys consumed by BullMQ deposit worker replicas. */
export const WORKER_HEARTBEAT_KEY = "depositQueue:worker:heartbeat";

/** Mirrors secondary key historically used by admin dashboards. */
export const WORKER_HEARTBEAT_ALT_KEY = "worker:heartbeat";

/** Deposit worker heartbeat TTL */
export const WORKER_HEARTBEAT_TTL_SECONDS = 90;

/** Payout worker heartbeat for Railway ops (optional second worker). */
export const PAYOUT_WORKER_HEARTBEAT_KEY = "hybridPayout:worker:heartbeat";

export const PAYOUT_WORKER_HEARTBEAT_TTL_SECONDS = 90;