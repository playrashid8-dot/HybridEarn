/**
 * Central VIP toast bus — one visible toast at a time; replaces previous immediately.
 * Use only from explicit user-action handlers (not axios interceptors).
 * Pass plain strings or use `getMessage(err)`; avoid passing arbitrary objects as the message.
 */

export type VipToastType = "success" | "error";

export type VipToastPayload = { type: VipToastType; message: string; durationMs: number };

type Listener = (state: VipToastPayload | null) => void;

let listener: Listener | null = null;
let dismissTimer: number | null = null;

export const DEFAULT_TOAST_MS = 4000;

function looksAxiosLike(x: unknown): x is object {
  return (
    !!x &&
    typeof x === "object" &&
    ("response" in x || ("isAxiosError" in x && (x as { isAxiosError?: unknown }).isAxiosError === true))
  );
}

/** Single-line snippet from primitives only — avoids "[object Object]" in UI */
function snippet(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return "";
  return "";
}

function humanizeTechnical(msg: string): string {
  const m = msg.trim();
  const lower = m.toLowerCase();

  if (!m) return "Something went wrong";

  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("network error") ||
    lower === "network error"
  ) {
    return "Network error, try again.";
  }

  if (
    lower.includes("internal server error") ||
    lower.includes("failed to fetch") ||
    /^request failed with status code 5\d\d$/.test(lower)
  ) {
    return "Service temporarily unavailable. Try again shortly.";
  }

  if (/^request failed with status code 4\d/i.test(lower)) {
    if (lower.includes("401")) return m;
    return "Request could not be completed.";
  }

  if (lower.includes("timeout")) return "Request timed out. Try again.";

  return m;
}

/** Normalize errors / stray API payload fields into user-facing toast copy. */
export function getMessage(error: unknown, fallback = "Something went wrong"): string {
  if (error == null) return humanizeTechnical(fallback);

  const direct = snippet(error);
  if (direct) return humanizeTechnical(direct);

  if (error instanceof Error) {
    const em = snippet(error.message);
    if (em) return humanizeTechnical(em);
  }

  if (!looksAxiosLike(error)) return humanizeTechnical(fallback);

  const rec = error as {
    response?: { data?: { msg?: unknown; message?: unknown }; status?: number };
    code?: string;
  };

  if (!rec.response) {
    if (rec.code === "ECONNABORTED" || rec.code === "TIMEOUT") {
      return "Request timed out. Try again.";
    }
    return "Network error, try again";
  }

  const status = rec.response.status;
  if (status != null && status >= 500) return "Service temporarily unavailable. Try again shortly.";

  const fromBody =
    snippet(rec.response.data?.msg) ||
    snippet(rec.response.data?.message);

  return humanizeTechnical(fromBody || fallback);
}

export function registerVipToastListener(fn: Listener) {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

/**
 * @param type — success | error
 * @param message — user-facing copy (string preferred); non-strings are safely coerced, never serialized objects.
 * @param durationMs — visible duration before auto-dismiss
 */
export function showToast(
  type: VipToastType,
  message: unknown,
  durationMs: number = DEFAULT_TOAST_MS,
) {
  if (typeof window === "undefined") return;

  let trimmed = "";
  if (typeof message === "string") trimmed = humanizeTechnical(message);
  else if (typeof message === "number" && Number.isFinite(message)) trimmed = String(message);
  else if (typeof message === "boolean") trimmed = "";
  else if (message instanceof Error) trimmed = humanizeTechnical(message.message?.trim() ?? "");
  else if (looksAxiosLike(message)) trimmed = getMessage(message, "");
  // Deliberately ignore arbitrary objects → no accidental object dumps.

  if (!trimmed) return;

  const ms = Number.isFinite(durationMs) && durationMs > 800 ? durationMs : DEFAULT_TOAST_MS;

  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }

  listener?.({ type, message: trimmed, durationMs: ms });

  dismissTimer = window.setTimeout(() => {
    listener?.(null);
    dismissTimer = null;
  }, ms);
}
