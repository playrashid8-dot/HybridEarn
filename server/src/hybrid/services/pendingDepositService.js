import PendingDeposit from "../models/PendingDeposit.js";
import HybridDeposit from "../models/HybridDeposit.js";
import { creditHybridDeposit } from "./depositService.js";

const RETRY_DELAY_MS = 60 * 1000;

export async function recordPendingDepositFailure(payload = {}) {
  const txHash = String(payload.txHash || payload.serializedLog?.transactionHash || "")
    .trim()
    .toLowerCase();
  const walletAddress = String(payload.walletAddress || "")
    .trim()
    .toLowerCase();

  if (!txHash || !walletAddress) {
    return null;
  }

  const errorMessage = String(payload.error?.message || payload.error || "Deposit processing failed")
    .slice(0, 500);

  return PendingDeposit.findOneAndUpdate(
    { txHash },
    {
      $set: {
        userId: payload.userId || null,
        walletAddress,
        amount: Number.isFinite(Number(payload.amount)) ? Number(payload.amount) : null,
        blockNumber: Number.isFinite(Number(payload.blockNumber)) ? Number(payload.blockNumber) : null,
        fromAddress: String(payload.fromAddress || "").toLowerCase(),
        tokenAddress: String(payload.tokenAddress || "").toLowerCase(),
        serializedLog: payload.serializedLog || null,
        status: "pending",
        lastError: errorMessage,
        nextRetryAt: new Date(Date.now() + RETRY_DELAY_MS),
      },
      $inc: { attempts: 1 },
    },
    { upsert: true, new: true }
  );
}

export async function markPendingDepositCredited(txHash) {
  const normalized = String(txHash || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return PendingDeposit.findOneAndUpdate(
    { txHash: normalized },
    {
      $set: {
        status: "credited",
        creditedAt: new Date(),
        lastError: "",
      },
    },
    { new: true }
  );
}

export async function retryPendingDeposits(limit = 25) {
  const pending = await PendingDeposit.find({
    status: "pending",
    nextRetryAt: { $lte: new Date() },
  })
    .sort({ createdAt: 1 })
    .limit(Math.max(1, Number(limit) || 25))
    .lean();

  let credited = 0;
  let failed = 0;

  for (const item of pending) {
    try {
      const existing = await HybridDeposit.findOne({ txHash: item.txHash })
        .select("_id status")
        .lean();

      if (["credited", "swept"].includes(existing?.status)) {
        await markPendingDepositCredited(item.txHash);
        credited += 1;
        continue;
      }

      await creditHybridDeposit({
        userId: item.userId,
        walletAddress: item.walletAddress,
        txHash: item.txHash,
        amount: item.amount,
        blockNumber: item.blockNumber,
        fromAddress: item.fromAddress,
        tokenAddress: item.tokenAddress,
      });
      await markPendingDepositCredited(item.txHash);
      credited += 1;
    } catch (err) {
      failed += 1;
      await recordPendingDepositFailure({
        txHash: item.txHash,
        userId: item.userId,
        walletAddress: item.walletAddress,
        amount: item.amount,
        blockNumber: item.blockNumber,
        fromAddress: item.fromAddress,
        tokenAddress: item.tokenAddress,
        serializedLog: item.serializedLog,
        error: err,
      });
    }
  }

  return { scanned: pending.length, credited, failed };
}
