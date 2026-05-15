/**
 * Lightweight Mongo mutex for concurrent deposit workers — complements BullMQ jobId uniqueness.
 */
import HybridDepositTxLock from "../models/HybridDepositTxLock.js";
import depositPipelineConfig from "../../config/depositPipelineConfig.js";
import logger from "../../utils/logger.js";

const normalized = (txHash) =>
  String(txHash || "")
    .trim()
    .toLowerCase();

export async function tryAcquireHybridDepositTxLock(txHash, options = {}) {
  const tx = normalized(txHash);
  if (!tx) {
    return { acquired: false, reason: "missing_tx" };
  }

  const ttlMs =
    typeof options.ttlMs === "number" && Number.isFinite(options.ttlMs)
      ? options.ttlMs
      : depositPipelineConfig.depositTxLockMs;
  const pid = typeof process.pid === "number" ? process.pid : null;
  const now = Date.now();
  const deadline = new Date(now + Math.min(900_000, Math.max(10_000, ttlMs)));

  const attempts = 4;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const doc = await HybridDepositTxLock.findOne({ txHash: tx }).lean();
      const activeUntilMs =
        doc?.lockedUntil != null ? new Date(doc.lockedUntil).getTime() : NaN;
      const sameHolder =
        doc &&
        pid != null &&
        doc.holderPid != null &&
        Number(doc.holderPid) === Number(pid);

      if (
        doc &&
        Number.isFinite(activeUntilMs) &&
        activeUntilMs > now &&
        !sameHolder
      ) {
        return {
          acquired: false,
          reason: "locked",
          holderPid: doc.holderPid ?? null,
        };
      }

      await HybridDepositTxLock.updateOne(
        { txHash: tx },
        {
          $set: {
            lockedUntil: deadline,
            holderPid: pid,
          },
        },
        { upsert: true },
      );

      return { acquired: true, until: deadline };
    } catch (err) {
      if (err?.code === 11000) {
        await new Promise((r) => setTimeout(r, 25 + attempt * 25));
        continue;
      }
      logger.warn("deposit tx lock acquisition degraded", {
        txHashPreview: `${tx.slice(0, 10)}…`,
        attempt: attempt + 1,
        error: err?.message || String(err),
      });
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }

  return { acquired: false, reason: "busy" };
}

export async function releaseHybridDepositTxLock(txHash, options = {}) {
  const tx = normalized(txHash);
  if (!tx) return;

  const pid = typeof process.pid === "number" ? process.pid : null;
  const force = Boolean(options.force);

  try {
    await HybridDepositTxLock.deleteMany(
      force
        ? { txHash: tx }
        : {
            txHash: tx,
            $or: [{ holderPid: pid }, { holderPid: null }],
          },
    );
  } catch (_) {
    /* defensive */
  }
}
