/**
 * Centralized structured logging — production uses minimal tiers; development is verbose.
 * Never logs raw private keys or common secret env patterns.
 */

const isProdLike =
  process.env.NODE_ENV === "production" ||
  String(process.env.RAILWAY_ENVIRONMENT || "").toLowerCase() === "production";

const LOG_LEVEL_RAW = String(
  process.env.LOG_LEVEL ||
    process.env.APP_LOG_LEVEL ||
    (isProdLike ? "info" : "debug")
).toLowerCase();

const LEVEL_WEIGHT = Object.freeze({
  error: 0,
  warn: 1,
  info: 2,
  http: 2,
  debug: 3,
});

const CURRENT_WEIGHT =
  LEVEL_WEIGHT[LOG_LEVEL_RAW] != null ? LEVEL_WEIGHT[LOG_LEVEL_RAW] : LEVEL_WEIGHT.info;

const SECRET_PATTERNS =
  /\b(mnemonic|private\s*key|PRIVATE\b|JWT_SECRET\b|encryption[_-]?secret|authorization:\s*bearer|BEGIN\s+PRIVATE\s+KEY)\b/i;

/** Reduces accidental leakage — keeps messages readable for ops. */
export function sanitizeForLog(value, maxLen = 2000) {
  if (value == null) {
    return value;
  }
  let text;
  try {
    if (typeof value === "string") {
      text = value;
    } else if (value instanceof Error) {
      text = `${value.name}: ${value.message}`;
    } else {
      text = JSON.stringify(value);
    }
  } catch {
    text = String(value);
  }
  if (text.length > maxLen) {
    text = `${text.slice(0, maxLen)}…(truncated)`;
  }
  if (SECRET_PATTERNS.test(text)) {
    return "[redacted]";
  }
  return text;
}

export function sanitizeMeta(meta, maxDeep = 3) {
  if (meta == null || maxDeep <= 0) {
    return meta;
  }
  if (typeof meta !== "object" || meta instanceof Error) {
    return sanitizeForLog(meta, 1600);
  }
  if (Array.isArray(meta)) {
    return meta.map((item) =>
      typeof item === "object" && item != null
        ? sanitizeMeta(item, maxDeep - 1)
        : sanitizeForLog(item)
    );
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, v] of Object.entries(meta)) {
    if (/key|secret|mnemonic|private|password|authorization|jwt/i.test(String(key))) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] =
      v != null && typeof v === "object" && !(v instanceof Error)
        ? sanitizeMeta(v, maxDeep - 1)
        : sanitizeForLog(v);
  }
  return out;
}

function emit(level, message, meta) {
  const linePrefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
  const safeMsg = sanitizeForLog(String(message || ""));
  const hasMeta =
    meta != null &&
    typeof meta === "object" &&
    !Array.isArray(meta) &&
    Object.keys(meta).length > 0;
  /** @type {unknown} */
  const payload =
    hasMeta === true ? { msg: safeMsg, ...sanitizeMeta(/** @type {Record<string, unknown>} */(meta)) } : safeMsg;
  const printer =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;
  printer(linePrefix, payload);
}

const shouldLog = (level) =>
  LEVEL_WEIGHT[level] != null &&
  LEVEL_WEIGHT[level] <= CURRENT_WEIGHT &&
  !(isProdLike && level === "debug");

/** Suppress repetitive operational noise in production (per-key leaky bucket). */
const THROTTLE_MS = Math.min(
  3_600_000,
  Math.max(
    10_000,
    Number(process.env.LOG_THROTTLE_REPEAT_MS || (isProdLike ? 180_000 : 30_000)),
  ),
);
const throttleLast = new Map();

function passThrottle(bucketKey, intervalMs = THROTTLE_MS) {
  const key = String(bucketKey || "global");
  const now = Date.now();
  const prev = throttleLast.get(key) || 0;
  if (now - prev < intervalMs) {
    return false;
  }
  throttleLast.set(key, now);
  return true;
}

export const logger = {
  isMinimalProd: isProdLike && CURRENT_WEIGHT <= LEVEL_WEIGHT.info,
  /** @param {number} [intervalMs] defaults to LOG_THROTTLE_REPEAT_MS */
  throttledWarn(bucketKey, message, meta, intervalMs) {
    if (!passThrottle(`w:${bucketKey}`, intervalMs ?? THROTTLE_MS)) {
      return;
    }
    if (!shouldLog("warn")) {
      return;
    }
    emit("warn", message, meta);
  },
  /** @param {number} [intervalMs] */
  throttledInfo(bucketKey, message, meta, intervalMs) {
    if (!passThrottle(`i:${bucketKey}`, intervalMs ?? THROTTLE_MS)) {
      return;
    }
    if (!shouldLog("info")) {
      return;
    }
    emit("info", message, meta);
  },
  error(message, meta) {
    emit("error", message, meta);
  },
  warn(message, meta) {
    if (!shouldLog("warn")) {
      return;
    }
    emit("warn", message, meta);
  },
  /** Default production channel for operational signals (deposit detected, worker boot, etc.). */
  info(message, meta) {
    if (!shouldLog("info")) {
      return;
    }
    emit("info", message, meta);
  },
  /** Verbose troubleshooting — disabled in minimal production configs. */
  debug(message, meta) {
    if (!shouldLog("debug")) {
      return;
    }
    emit("debug", message, meta);
  },
  /** Compatibility alias — routes to warn in prod, debug in verbose dev. */
  http(message, meta) {
    if (isProdLike && CURRENT_WEIGHT <= LEVEL_WEIGHT.info) {
      return;
    }
    emit("info", `[http] ${message}`, meta);
  },
};

export default logger;
