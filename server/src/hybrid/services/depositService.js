import User from "../../models/User.js";
import HybridDeposit from "../models/HybridDeposit.js";
import HybridSetting from "../models/HybridSetting.js";
import {
  HYBRID_SETTING_LAST_PROCESSED_DEPOSIT_AT,
  HYBRID_SETTING_LAST_PROCESSED_DEPOSIT_TX,
} from "../utils/depositTelemetry.js";
import { withProviderRetry } from "../utils/provider.js";
import { addHybridLedgerEntries } from "./ledgerService.js";
import { syncUserLevel } from "./levelService.js";
import {
  invalidateSalaryCountCacheForUplineOfUser,
} from "./salaryService.js";
import {
  distributeFirstDepositBonus,
  getDirectHybridSponsorId,
  MIN_FIRST_DEPOSIT_BONUS_DEPOSIT_USDT,
} from "./firstDepositBonusService.js";
import {
  completeIdempotency,
  failIdempotency,
  getCompletedIdempotency,
  markIdempotencyProcessing,
} from "./idempotencyService.js";
import { shouldSkipDepositForDuplicateTx } from "../utils/hybridDepositTxDuplicate.js";
import logger from "../../utils/logger.js";
import { runMongoTransaction } from "../../config/mongoTransactions.js";
export const creditHybridDeposit = async ({
  userId,
  walletAddress,
  txHash,
  amount,
  blockNumber = null,
  fromAddress = "",
  tokenAddress = "",
  traceId = "",
}) => {
  const normalizedTxHash = String(txHash || "").trim().toLowerCase();
  const normalizedWallet = String(walletAddress || "").trim().toLowerCase();
  const numericAmount = Number(amount || 0);

  if (!normalizedTxHash || !normalizedWallet || !Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Invalid deposit payload");
  }

  const storedResponse = await getCompletedIdempotency("deposit", normalizedTxHash);
  if (storedResponse?.depositId) {
    const storedDeposit = await HybridDeposit.findById(storedResponse.depositId);
    if (storedDeposit && ["credited", "swept"].includes(storedDeposit.status)) {
      return storedDeposit;
    }
  }

  try {
    let deposit = null;
    let creditedNew = false;

    await runMongoTransaction("hybrid.deposit.credit", async (session) => {
      await markIdempotencyProcessing("deposit", normalizedTxHash, session);

      const dupEarly = await shouldSkipDepositForDuplicateTx(normalizedTxHash, session);
      if (dupEarly.skip && dupEarly.reason === "deposit") {
        const creditedDeposit = await HybridDeposit.findOne({
          txHash: normalizedTxHash,
          status: { $in: ["credited", "swept"] },
        }).session(session);

        if (!creditedDeposit) {
          throw new Error(
            "Inconsistent duplicate state: expected credited HybridDeposit for tx"
          );
        }
        logger.warn(
          "DUPLICATE SAFETY: HybridDeposit finalized — skipping double credit ledger path",
          {
            traceId: traceId || undefined,
            txHash: normalizedTxHash,
            status: creditedDeposit.status,
          }
        );
        deposit = creditedDeposit;
        await completeIdempotency(
          "deposit",
          normalizedTxHash,
          {
            depositId: String(creditedDeposit._id),
            status: creditedDeposit.status,
            amount: Number(creditedDeposit.amount || 0),
          },
          session
        );
        return;
      }

      if (dupEarly.skip && dupEarly.reason === "ledger") {
        const depRow = await HybridDeposit.findOne({
          txHash: normalizedTxHash,
        }).session(session);

        if (depRow) {
          logger.warn("deposit ledger duplicate guard triggered — using existing HybridDeposit row", {
            traceId: traceId || undefined,
            txHashPartial: `${normalizedTxHash.slice(0, 14)}…`,
            reason: "ledger",
          });
          deposit = depRow;
          await completeIdempotency(
            "deposit",
            normalizedTxHash,
            {
              depositId: String(depRow._id),
              status: depRow.status,
              amount: Number(depRow.amount || 0),
            },
            session
          );
          return;
        }

        throw new Error(
          "Ledger credit exists for tx without HybridDeposit row — manual reconcile required"
        );
      }

      const user = await User.findById(userId)
        .select("depositBalance hasQualifiedDeposit referredBy referrer")
        .session(session);

      if (!user) {
        throw new Error("User not found");
      }

      const existing = await HybridDeposit.findOne({
        txHash: normalizedTxHash,
      }).session(session);

      if (existing) {
        deposit = await HybridDeposit.findOneAndUpdate(
          {
            _id: existing._id,
            status: { $nin: ["credited", "swept"] },
          },
          {
            $set: {
              status: "credited",
              sweeped: false,
              walletAddress: normalizedWallet,
              amount: numericAmount,
              blockNumber,
              fromAddress: String(fromAddress || "").toLowerCase(),
              tokenAddress: String(tokenAddress || "").toLowerCase(),
              errorMessage: "",
            },
          },
          {
            new: true,
            session,
          }
        );

        if (!deposit) {
          deposit = await HybridDeposit.findOne({
            txHash: normalizedTxHash,
          }).session(session);
          return;
        }
      } else {
        [deposit] = await HybridDeposit.create(
          [
            {
              userId,
              walletAddress: normalizedWallet,
              amount: numericAmount,
              txHash: normalizedTxHash,
              blockNumber,
              fromAddress: String(fromAddress || "").toLowerCase(),
              tokenAddress: String(tokenAddress || "").toLowerCase(),
              status: "credited",
              sweeped: false,
            },
          ],
          { session }
        );
      }

      creditedNew = true;

      await User.findByIdAndUpdate(
        userId,
        {
          $inc: {
            depositBalance: numericAmount,
          },
          $unset: {
            withdrawLockUntil: "",
          },
        },
        {
          new: true,
          session,
        }
      );

      await User.findOneAndUpdate(
        {
          _id: userId,
          hasQualifiedDeposit: { $ne: true },
        },
        {
          $set: {
            hasQualifiedDeposit: true,
          },
        },
        {
          new: true,
          session,
        }
      );

      await addHybridLedgerEntries(
        [
          {
            userId,
            entryType: "credit",
            balanceType: "depositBalance",
            amount: numericAmount,
            source: "hybrid_deposit",
            referenceId: deposit._id,
            meta: {
              txHash: normalizedTxHash,
            },
          },
        ],
        session
      );

      if (numericAmount >= MIN_FIRST_DEPOSIT_BONUS_DEPOSIT_USDT) {
        const sponsorId = getDirectHybridSponsorId(user);
        if (sponsorId) {
          await distributeFirstDepositBonus(
            {
              depositorUserId: userId,
              sponsorUserId: sponsorId,
              depositAmountUsdt: numericAmount,
              depositReferenceId: deposit._id,
              depositTxHash: normalizedTxHash,
            },
            session
          );
        }
      }

      await syncUserLevel(userId, session);

      await completeIdempotency(
        "deposit",
        normalizedTxHash,
        {
          depositId: String(deposit._id),
          status: deposit.status,
          amount: numericAmount,
        },
        session
      );
    });

    if (creditedNew && deposit) {
      logger.info("DEPOSIT_CREDITED", {
        traceId: traceId || undefined,
        txHashPartial: `${normalizedTxHash.slice(0, 14)}…`,
        walletTail: `${normalizedWallet.slice(-8)}`,
        userTail: `${String(userId).slice(-8)}`,
        amount: numericAmount,
        depositId: String(deposit._id),
      });
      logger.debug?.("hybrid deposit credit finalized downstream hooks", {
        traceId: traceId || undefined,
        txHashPartial: `${normalizedTxHash.slice(0, 14)}…`,
        userTail: `${String(userId).slice(-10)}`,
        amount: numericAmount,
      });

      void invalidateSalaryCountCacheForUplineOfUser(userId).catch(() => {});

      try {
        const now = Date.now();
        await Promise.all([
          HybridSetting.findOneAndUpdate(
            { key: HYBRID_SETTING_LAST_PROCESSED_DEPOSIT_AT },
            { $set: { value: now } },
            { upsert: true, new: true }
          ),
          HybridSetting.findOneAndUpdate(
            { key: HYBRID_SETTING_LAST_PROCESSED_DEPOSIT_TX },
            { $set: { value: normalizedTxHash } },
            { upsert: true, new: true }
          ),
        ]);
      } catch (persistErr) {
        logger.error("Deposit telemetry settings persist failed — non-blocking", {
          traceId: traceId || undefined,
          txHashPartial: `${normalizedTxHash.slice(0, 14)}…`,
          error: persistErr?.message || String(persistErr),
        });
      }
    }

    return deposit;
  } catch (error) {
    logger.error("creditHybridDeposit failed — aborting transactional credit", {
      traceId: traceId || undefined,
      txHashPartial: `${normalizedTxHash.slice(0, 14)}…`,
      error: error?.message || String(error),
    });
    if (error?.code === 11000) {
      const existing = await HybridDeposit.findOne({ txHash: normalizedTxHash });

      if (existing && ["credited", "swept"].includes(existing.status)) {
        return existing;
      }
    }

    await failIdempotency("deposit", normalizedTxHash, error);
    throw error;
  }
};

const HYBRID_DEPOSIT_CONFIRMATIONS_REQUIRED = 3;
const HYBRID_CONFIRMATION_SNAPSHOT_TIMEOUT_MS = Math.min(
  5000,
  Math.max(1000, Number(process.env.HYBRID_CONFIRMATION_SNAPSHOT_TIMEOUT_MS || 2500))
);

export const enrichHybridDepositsWithConfirmations = async (deposits) => {
  if (!Array.isArray(deposits) || deposits.length === 0) {
    return deposits;
  }

  try {
    const currentBlock = await withProviderRetry((p) => p.getBlockNumber(), 1, {
      purpose: "hybrid_deposit_confirmation_snapshot",
      timeoutMs: HYBRID_CONFIRMATION_SNAPSHOT_TIMEOUT_MS,
    });
    return deposits.map((d) => {
      const bn = d.blockNumber;
      let confirmations =
        bn != null && Number.isFinite(Number(bn))
          ? Math.max(0, currentBlock - Number(bn))
          : 0;
      confirmations = confirmations || 0;
      const confirmationStatus =
        confirmations >= HYBRID_DEPOSIT_CONFIRMATIONS_REQUIRED ? "confirmed" : "confirming";
      return {
        ...d,
        currentBlock,
        confirmations,
        confirmationStatus,
      };
    });
  } catch (err) {
    logger.error("deposit confirmation enrichment failed — returning raw rows", {
      error: err?.message || String(err),
    });
    return deposits.map((d) => ({
      ...d,
      currentBlock: null,
      confirmations: 0,
      confirmationStatus: "unknown",
    }));
  }
};

export const getUserHybridDeposits = async (userId) => {
  const deposits = await HybridDeposit.find({ userId }).sort({ createdAt: -1 }).lean();
  return enrichHybridDepositsWithConfirmations(deposits);
};

/** BullMQ worker entry — dynamic import avoids circular static imports with depositListener. */
export async function processDepositJob(jobData) {
  const { processDepositJob: run } = await import("./depositQueueProcessor.js");
  return run(jobData);
}
