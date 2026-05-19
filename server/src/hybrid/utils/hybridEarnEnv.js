import logger from "../../utils/logger.js";

/**
 * Single definition for HYBRID_EARN_ENABLED — trim + lowercase match to "true".
 */
export function isHybridEarnEnabled() {
  return (
    String(process.env.HYBRID_EARN_ENABLED ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}

export function describeHybridEarnDisabledReason() {
  const raw = process.env.HYBRID_EARN_ENABLED;
  const s = raw === undefined || raw === null ? "" : String(raw).trim();
  if (!s) {
    return 'HYBRID_EARN_ENABLED is unset (set to "true" to enable)';
  }
  if (!isHybridEarnEnabled()) {
    return `HYBRID_EARN_ENABLED="${s}" is not enabled (must be exactly "true" after trim)`;
  }
  return "";
}

/** Warn once per process when the variable is set but not interpretable as enabled. */
let warnedInvalidEarnEnv = false;

export function warnIfHybridEarnEnvInvalid() {
  const raw = process.env.HYBRID_EARN_ENABLED;
  const s = raw === undefined || raw === null ? "" : String(raw).trim();
  if (!s || warnedInvalidEarnEnv) {
    return;
  }
  if (!isHybridEarnEnabled()) {
    warnedInvalidEarnEnv = true;
    logger.warn(`HYBRID_EARN_ENABLED="${s}" does not enable Hybrid listeners`, {
      hint: 'use exactly "true" after trim',
    });
  }
}
