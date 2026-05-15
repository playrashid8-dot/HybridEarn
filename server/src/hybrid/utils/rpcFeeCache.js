/**
 * Short TTL caches for fee data and block number — lowers JSON-RPC load during payout/sweep bursts.
 */
import payoutPipelineConfig from "../../config/payoutPipelineConfig.js";
import { withProviderRetry } from "./provider.js";

let feeCache = { atMs: 0, data: null };
let headCache = { atMs: 0, block: null };

export async function getCachedFeeData(provider) {
  const ttl = payoutPipelineConfig.feeDataCacheMs;
  const now = Date.now();
  if (feeCache.data && now - feeCache.atMs < ttl) {
    return feeCache.data;
  }
  const data = await withProviderRetry((p) => p.getFeeData());
  feeCache = { atMs: now, data };
  return data;
}

export async function getCachedBlockNumber(provider) {
  const ttl = payoutPipelineConfig.chainHeadCacheMs;
  const now = Date.now();
  if (headCache.block != null && now - headCache.atMs < ttl) {
    return headCache.block;
  }
  const block = await withProviderRetry((p) => p.getBlockNumber());
  headCache = { atMs: now, block };
  return block;
}

export function invalidateHeadCache() {
  headCache = { atMs: 0, block: null };
}
