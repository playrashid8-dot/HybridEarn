import logger, { sanitizeForLog } from "./logger.js";

const TRANSIENT_NETWORK_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const TRANSIENT_NETWORK_MESSAGE =
  /(?:ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network timeout|fetch failed|connect timeout|headers timeout|connection reset|temporary failure|timed out)/i;

const DEFAULT_EXTERNAL_TIMEOUT_MS = Math.min(
  120_000,
  Math.max(2_000, Number(process.env.EXTERNAL_NETWORK_TIMEOUT_MS || 30_000)),
);

export function getExternalHost(value) {
  const direct = String(value || "").trim();
  if (direct) {
    try {
      return new URL(direct).host || "unknown";
    } catch {
      if (/^[a-z0-9.-]+(?::\d+)?$/i.test(direct)) {
        return direct;
      }
    }
  }

  return "unknown";
}

function errorChain(err) {
  const out = [];
  const seen = new Set();
  let cur = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = cur.cause;
  }
  return out;
}

export function getNetworkErrorCode(err) {
  for (const item of errorChain(err)) {
    const code = String(item?.code || item?.error?.code || "").trim();
    if (code) {
      return code;
    }
  }
  return "";
}

export function getNetworkErrorMessage(err) {
  const parts = [];
  for (const item of errorChain(err)) {
    const msg = String(item?.message || item?.reason || "").trim();
    if (msg) parts.push(msg);
  }
  if (parts.length === 0) {
    parts.push(String(err || ""));
  }
  return parts.join(" | ");
}

export function getNetworkErrorHost(err, fallbackHost = "unknown") {
  for (const item of errorChain(err)) {
    const host = String(item?.hostname || item?.host || item?.address || "").trim();
    const port = String(item?.port || "").trim();
    if (host) {
      return port && !host.includes(":") ? `${host}:${port}` : host;
    }
  }

  const msg = getNetworkErrorMessage(err);
  const connectMatch = msg.match(/connect\s+(?:ETIMEDOUT|ECONNRESET)\s+([a-z0-9.-]+:\d+)/i);
  if (connectMatch?.[1]) {
    return connectMatch[1];
  }
  const urlMatch = msg.match(/https?:\/\/([^/\s)]+)/i);
  if (urlMatch?.[1]) {
    return urlMatch[1];
  }
  return getExternalHost(fallbackHost);
}

export function isTransientExternalNetworkError(err) {
  const code = getNetworkErrorCode(err);
  if (code && TRANSIENT_NETWORK_CODES.has(code)) {
    return true;
  }

  return TRANSIENT_NETWORK_MESSAGE.test(getNetworkErrorMessage(err));
}

export function makeExternalNetworkTimeoutError({
  purpose = "external_request",
  timeoutMs = DEFAULT_EXTERNAL_TIMEOUT_MS,
  host = "unknown",
} = {}) {
  const err = new Error(`external network timeout (${timeoutMs}ms) ${purpose}`);
  err.code = "ETIMEDOUT";
  err.externalNetwork = true;
  err.externalHost = getExternalHost(host);
  err.timeoutMs = Number(timeoutMs);
  err.requestPurpose = String(purpose || "external_request");
  return err;
}

export function logExternalNetworkFailure({
  level = "warn",
  message = "External network request failed",
  error,
  host = "unknown",
  timeoutMs = DEFAULT_EXTERNAL_TIMEOUT_MS,
  retryCount = 0,
  purpose = "external_request",
  degradedNetworkMode = true,
  skippedRetryReason = "",
  throttleKey = "",
  throttleMs = 45_000,
} = {}) {
  const meta = {
    externalHost: getNetworkErrorHost(error, host),
    timeoutMs: Number(timeoutMs) || 0,
    retryCount: Number(retryCount) || 0,
    requestPurpose: String(purpose || "external_request"),
    degradedNetworkMode: Boolean(degradedNetworkMode),
    skippedRetryReason: String(skippedRetryReason || ""),
    errorCode: String(getNetworkErrorCode(error) || ""),
    error: sanitizeForLog(getNetworkErrorMessage(error), 500),
  };

  if (level === "error") {
    if (throttleKey) {
      logger.throttledError(throttleKey, message, meta, throttleMs);
      return;
    }
    logger.error(message, meta);
    return;
  }

  if (throttleKey) {
    logger.throttledWarn(throttleKey, message, meta, throttleMs);
    return;
  }

  logger.warn(message, meta);
}

export async function withExternalNetworkDeadline(fn, {
  purpose = "external_request",
  host = "unknown",
  timeoutMs = DEFAULT_EXTERNAL_TIMEOUT_MS,
} = {}) {
  const cap = Math.min(300_000, Math.max(250, Number(timeoutMs) || DEFAULT_EXTERNAL_TIMEOUT_MS));
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(makeExternalNetworkTimeoutError({ purpose, timeoutMs: cap, host }));
    }, cap);
    timer?.unref?.();
  });

  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function withExternalNetworkRetry(fn, {
  purpose = "external_request",
  host = "unknown",
  timeoutMs = DEFAULT_EXTERNAL_TIMEOUT_MS,
  retries = 1,
  baseDelayMs = 400,
  idempotent = true,
} = {}) {
  const maxAttempts = Math.max(1, Number(retries) + 1 || 1);
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withExternalNetworkDeadline(fn, { purpose, host, timeoutMs });
    } catch (err) {
      lastError = err;
      const canRetry =
        idempotent === true &&
        attempt < maxAttempts &&
        isTransientExternalNetworkError(err);

      logExternalNetworkFailure({
        message: "External network request failed — contained by safety wrapper",
        error: err,
        host,
        timeoutMs,
        retryCount: attempt - 1,
        purpose,
        degradedNetworkMode: true,
        skippedRetryReason: canRetry ? "" : idempotent ? "retry_budget_exhausted_or_non_transient" : "non_idempotent",
        throttleKey: `external_network_${purpose}_${getNetworkErrorHost(err, host)}`,
      });

      if (!canRetry) {
        throw err;
      }

      const delay = Math.min(10_000, Math.max(100, baseDelayMs) * 2 ** Math.min(attempt - 1, 8));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}