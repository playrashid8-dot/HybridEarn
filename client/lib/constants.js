/**
 * Shared UI/backend string values — use for comparisons against API fields only when values match backend.
 */
export const STATUS = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  FAILED: "failed",
};

/** Display-only fee fallback for withdraw preview; mirrors server WITHDRAW_FEE_RATE when no history. */
export const UI_WITHDRAW_FEE_RATE_FALLBACK = 0.05;
