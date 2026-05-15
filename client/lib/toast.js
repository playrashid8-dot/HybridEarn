/**
 * Shared toast DOM.
 * showToast — short-window dedupe for direct UI calls.
 * showSafeToast — collapses identical bursts; different messages show immediately; same message can show again after 1.5s.
 */

let lastToastMsg = "";
let lastToastAt = 0;

const DEDUPE_MS = 800;

/** @type {string} last normalized message shown via showSafeToast */
let lastToast = "";
let lastTime = 0;

/**
 * @param {string} [rawMessage]
 * @param {{ fallback?: string }} [opts]
 */
function normalizeMessage(rawMessage, opts = {}) {
  let message =
    typeof rawMessage === "string"
      ? rawMessage.trim()
      : String(rawMessage ?? "").trim();

  if (!message) {
    message =
      opts.fallback && String(opts.fallback).trim()
        ? String(opts.fallback).trim()
        : "Something went wrong";
  }
  return message;
}

/**
 * @param {string} [rawMessage]
 * @param {{ force?: boolean, fallback?: string }} [opts]
 */
export function showToast(rawMessage, opts = {}) {
  if (typeof window === "undefined") return;

  const message = normalizeMessage(rawMessage, opts);

  const now = Date.now();
  if (!opts.force && message === lastToastMsg && now - lastToastAt < DEDUPE_MS) {
    return;
  }
  lastToastMsg = message;
  lastToastAt = now;

  const div = document.createElement("div");
  div.innerText = message;
  div.className =
    "fixed top-5 left-1/2 -translate-x-1/2 bg-purple-600 text-white px-4 py-2 rounded-lg text-sm shadow-lg z-50 animate-fade-in";
  document.body.appendChild(div);

  setTimeout(() => div.remove(), 2500);
}

/**
 * For axios interceptor and other global/error paths: avoids spam while allowing
 * distinct errors back-to-back and repeating the same message after 1.5s.
 * @param {string} [rawMessage]
 * @param {{ fallback?: string }} [opts]
 */
export function showSafeToast(rawMessage, opts = {}) {
  if (typeof window === "undefined") return;

  const message = normalizeMessage(rawMessage, opts);
  if (!message) return;

  const now = Date.now();

  // Allow different message instantly; same message again only after 1.5s
  if (message !== lastToast || now - lastTime > 1500) {
    showToast(rawMessage, { ...opts, force: true });

    lastToast = message;
    lastTime = now;
  }
}

/** Success / error / warning styling for admin actions */
let lastAdminToastKey = "";
let lastAdminToastAt = 0;

/**
 * @param {string} rawMessage
 * @param {"success" | "error" | "warning"} [variant]
 * @param {{ fallback?: string }} [opts]
 */
export function showAdminToast(rawMessage, variant = "success", opts = {}) {
  if (typeof window === "undefined") return;

  const message = normalizeMessage(rawMessage, opts);
  if (!message) return;

  const now = Date.now();
  const key = `${variant}::${message}`;
  if (key === lastAdminToastKey && now - lastAdminToastAt < 1200) return;
  lastAdminToastKey = key;
  lastAdminToastAt = now;

  const base =
    "fixed top-5 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-sm shadow-lg z-[60] animate-fade-in text-white max-w-[min(90vw,420px)] text-center";
  const variantCls =
    variant === "error"
      ? "bg-red-600"
      : variant === "warning"
        ? "bg-amber-600"
        : "bg-emerald-600";

  const div = document.createElement("div");
  div.innerText = message;
  div.className = `${base} ${variantCls}`;
  document.body.appendChild(div);

  setTimeout(() => div.remove(), 2800);
}