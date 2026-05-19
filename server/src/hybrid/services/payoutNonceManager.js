/**
 * Central nonce authority for payout wallet — Redis mirror + chain resync under wallet mutex.
 * Call only while {@link withPayoutWalletExclusive} holds the hot wallet.
 */
import { getAddress } from "ethers";
import payoutPipelineConfig from "../../config/payoutPipelineConfig.js";
import {
  recordNonceDiagnostics,
  withPayoutRpcTimeout,
} from "../utils/payoutObservability.js";
import { withProviderRetry } from "../utils/provider.js";

const HYBRID_PAYOUT_RPC_TIMEOUT_MS = Number(process.env.HYBRID_PAYOUT_RPC_TIMEOUT_MS || 28000);

function walletKey(addr) {
  return String(addr || "")
    .trim()
    .toLowerCase();
}

function mirrorKey(addr) {
  return `hybrid:payout_nonce_mirror:${walletKey(addr)}`;
}

/**
 * @param {import('ioredis').Redis | null} redis
 * @param {string} address checksum or lowercase
 */
export async function syncNonceMirrorFromChain(redis, address, provider) {
  const checksum = getAddress(String(address));
  const [pending, latest] = await Promise.all([
    withProviderRetry((p) =>
      withPayoutRpcTimeout(
        () => p.getTransactionCount(checksum, "pending"),
        HYBRID_PAYOUT_RPC_TIMEOUT_MS,
        "nonce_pending_sync",
      ),
    ),
    withProviderRetry((p) =>
      withPayoutRpcTimeout(
        () => p.getTransactionCount(checksum, "latest"),
        HYBRID_PAYOUT_RPC_TIMEOUT_MS,
        "nonce_latest_sync",
      ),
    ),
  ]);
  const pN = Number(pending);
  const lN = Number(latest);
  if (redis) {
    const payload = JSON.stringify({
      pendingNext: pN,
      latest: lN,
      atMs: Date.now(),
    });
    try {
      await redis.set(
        mirrorKey(checksum),
        payload,
        "EX",
        payoutPipelineConfig.nonceRedisMirrorTtlSec,
      );
    } catch {
      /* ignore */
    }
  }
  recordNonceDiagnostics({
    locked: -1,
    pendingNext: Number.isFinite(pN) ? pN : -1,
    latest: Number.isFinite(lN) ? lN : null,
    mismatchedRecovery: false,
  });
  return { pendingNext: pN, latest: lN };
}

/**
 * Pick the next nonce for an ERC20 payout, reconciling chain head, Redis mirror, and optional DB-persisted nonce.
 * @param {object} opts
 * @param {import('ioredis').Redis | null} opts.redis
 * @param {import('ethers').Provider} opts.provider
 * @param {string} opts.payoutWalletAddress
 * @param {number|null|undefined} opts.persistedNonce — HybridWithdrawal.payoutNonce
 */
export async function reservePayoutNonce({ redis, provider, payoutWalletAddress, persistedNonce }) {
  const checksum = getAddress(String(payoutWalletAddress));
  const { pendingNext, latest } = await syncNonceMirrorFromChain(redis, checksum, provider);

  let mirrorPending = NaN;
  if (redis) {
    try {
      const raw = await redis.get(mirrorKey(checksum));
      if (raw) {
        const j = JSON.parse(raw);
        mirrorPending = Number(j.pendingNext);
      }
    } catch {
      mirrorPending = NaN;
    }
  }

  let next = Number.isFinite(pendingNext) ? pendingNext : 0;
  if (Number.isFinite(mirrorPending) && mirrorPending > next) {
    next = mirrorPending;
  }

  const persisted = Number(persistedNonce);
  if (Number.isInteger(persisted) && persisted >= next) {
    next = persisted;
  }

  if (!Number.isInteger(next) || next < 0) {
    throw new Error("Unable to derive payout nonce");
  }

  const assigned = next;

  recordNonceDiagnostics({
    locked: assigned,
    pendingNext: Number.isFinite(pendingNext) ? pendingNext : -1,
    latest: Number.isFinite(latest) ? latest : null,
    mismatchedRecovery:
      Number.isFinite(pendingNext) && Number.isInteger(persisted) ? pendingNext > persisted : false,
  });

  return assigned;
}

/** Call after tx hash is persisted — keeps Redis mirror aligned without relying on the next chain poll. */
export async function advanceNonceMirrorAfterBroadcast(redis, address, usedNonce, provider) {
  const checksum = getAddress(String(address));
  let latest = null;
  try {
    latest = await withProviderRetry((p) =>
      withPayoutRpcTimeout(
        () => p.getTransactionCount(checksum, "latest"),
        HYBRID_PAYOUT_RPC_TIMEOUT_MS,
        "nonce_latest_after_broadcast",
      ),
    );
  } catch {
    latest = null;
  }
  const lN = Number(latest);
  if (redis) {
    try {
      await redis.set(
        mirrorKey(checksum),
        JSON.stringify({
          pendingNext: usedNonce + 1,
          latest: Number.isFinite(lN) ? lN : null,
          atMs: Date.now(),
        }),
        "EX",
        payoutPipelineConfig.nonceRedisMirrorTtlSec,
      );
    } catch {
      /* ignore */
    }
  }
}

/**
 * After a failed attempt (no tx mined), roll mirror back toward chain pending to avoid long gaps.
 * @param {import('ioredis').Redis | null} redis
 */
export async function reconcileNonceMirrorAfterFailure(redis, provider, payoutWalletAddress) {
  await syncNonceMirrorFromChain(redis, payoutWalletAddress, provider);
}
