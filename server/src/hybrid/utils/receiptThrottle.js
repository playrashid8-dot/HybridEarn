/**
 * Coalesce concurrent getTransactionReceipt calls for the same hash (short window).
 */
import payoutPipelineConfig from "../../config/payoutPipelineConfig.js";

/** @type {Map<string, { atMs: number, promise: Promise<import('ethers').TransactionReceipt | null> }>} */
const inflight = new Map();

/**
 * @param {() => Promise<import('ethers').TransactionReceipt | null>} fetcher
 */
export function getReceiptDeduped(hash, fetcher) {
  const h = String(hash || "").trim().toLowerCase();
  if (!h.startsWith("0x")) {
    return fetcher();
  }
  const now = Date.now();
  const ttl = payoutPipelineConfig.receiptInflightDedupeMs;
  const hit = inflight.get(h);
  if (hit && now - hit.atMs < ttl) {
    return hit.promise;
  }
  const promise = fetcher().finally(() => {
    setTimeout(() => {
      const cur = inflight.get(h);
      if (cur?.promise === promise) {
        inflight.delete(h);
      }
    }, ttl);
  });
  inflight.set(h, { atMs: now, promise });
  return promise;
}
