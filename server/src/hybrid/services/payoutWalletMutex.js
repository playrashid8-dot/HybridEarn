/**
 * Serialize all on-chain sends from a hot payout wallet (Redis NX lock + in-process fallback).
 */
import crypto from "crypto";
import { isRedisReady } from "../../config/redis.js";
import logger from "../../utils/logger.js";
import payoutPipelineConfig from "../../config/payoutPipelineConfig.js";

/** @type {Map<string, Promise<void>>} */
const localTails = new Map();

function normalizeWallet(wallet) {
  return String(wallet || "")
    .trim()
    .toLowerCase();
}

async function acquireRedisLock(redis, key, token, ttlMs) {
  try {
    const ok = await redis.set(key, token, "PX", ttlMs, "NX");
    return ok === "OK";
  } catch (err) {
    logger.throttledWarn(
      "payout_wallet_lock_redis",
      "Payout wallet mutex Redis error — falling back to local serialization",
      { error: err?.message || String(err) },
      60_000,
    );
    return false;
  }
}

async function releaseRedisLock(redis, key, token) {
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  try {
    await redis.eval(script, 1, key, token);
  } catch {
    /* non-fatal */
  }
}

/**
 * @param {import('ioredis').Redis | null} redis
 * @param {string} walletAddress
 * @param {number} [ttlMs]
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withPayoutWalletExclusive(redis, walletAddress, ttlMs, fn) {
  const walletLower = normalizeWallet(walletAddress);
  if (!walletLower.startsWith("0x")) {
    throw new Error("Invalid payout wallet for mutex");
  }
  const lockMs = ttlMs ?? payoutPipelineConfig.payoutWalletLockMs;
  const key = `hybrid:payout_wallet_lock:${walletLower}`;
  const token = crypto.randomBytes(16).toString("hex");

  if (redis && isRedisReady(redis)) {
    const locked = await acquireRedisLock(redis, key, token, lockMs);
    if (locked) {
      try {
        return await fn();
      } finally {
        await releaseRedisLock(redis, key, token);
      }
    }
    logger.throttledWarn(
      "payout_wallet_busy_redis",
      "Another replica holds payout wallet lock — caller should retry later",
      { walletPreview: `${walletLower.slice(0, 10)}…` },
      45_000,
    );
    throw Object.assign(new Error("PAYOUT_WALLET_BUSY"), { code: "PAYOUT_WALLET_BUSY", statusCode: 409 });
  }

  const prev = localTails.get(walletLower) || Promise.resolve();
  /** @type {(v?: void) => void} */
  let resolveTail;
  const tailGate = new Promise((r) => {
    resolveTail = r;
  });
  const run = prev
    .then(() => fn())
    .finally(() => {
      resolveTail?.();
    });
  localTails.set(walletLower, tailGate);
  return run;
}
