/**
 * BSC JSON-RPC failover: primary envs first, then hybrid chain URLs.
 * Compatible with RPC_URL / RPC_URL_BACKUP (Railway) and HYBRID_BSC_* / BSC_RPC_URL.
 */

export function getRpcUrls() {
  const raw = [
    String(process.env.RPC_URL || "").trim(),
    String(process.env.RPC_URL_BACKUP || "").trim(),
    String(process.env.HYBRID_BSC_RPC_URL || process.env.BSC_RPC_URL || "").trim(),
    String(process.env.HYBRID_BSC_RPC_FALLBACK || "").trim(),
    String(process.env.HYBRID_BSC_RPC_BACKUP || "").trim(),
  ].filter(Boolean);
  return [...new Set(raw)];
}

let current = 0;

export function getRPC() {
  const urls = getRpcUrls();
  if (urls.length === 0) return "";
  return urls[current % urls.length];
}

export function switchRPC() {
  const urls = getRpcUrls();
  if (urls.length === 0) return;
  current = (current + 1) % urls.length;
}

/** @param {number} index */
export function setRPCIndex(index) {
  const urls = getRpcUrls();
  if (urls.length === 0) return;
  const n = Number(index);
  const idx = Number.isFinite(n) ? n : 0;
  current = (((idx % urls.length) + urls.length) % urls.length);
}

export function getRPCIndex() {
  const urls = getRpcUrls();
  if (urls.length === 0) return 0;
  return current % urls.length;
}
