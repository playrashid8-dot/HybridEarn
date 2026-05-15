import mongoose from "mongoose";
import User from "../../models/User.js";
import { ROI_RATES } from "../utils/constants.js";
import {
  alreadyClaimedToday,
  getClaimWindowStartUtc,
  isAfter5AM,
} from "../utils/roiPktTime.js";
import { addHybridLedgerEntries } from "./ledgerService.js";
import { distributeRoiReferralRewards } from "./referralService.js";
import { expireTrialIfNeeded } from "./trialService.js";
import logger from "../../utils/logger.js";
import { bumpClaimRoi } from "../utils/payoutObservability.js";
import { getReadyRedis, isRedisReady } from "../../config/redis.js";

const isTransientRoiTxnError = (err) => {
  const labels = err?.errorLabels;
  if (labels instanceof Set && labels.has("TransientTransactionError")) {
    return true;
  }
  if (Array.isArray(labels) && labels.includes("TransientTransactionError")) {
    return true;
  }
  if (labels instanceof Set && labels.has("UnknownTransactionCommitResult")) {
    return true;
  }
  if (Array.isArray(labels) && labels.includes("UnknownTransactionCommitResult")) {
    return true;
  }
  const msg = String(err?.message || "").toLowerCase();
  return (
    msg.includes("transienttransactionerror") ||
    msg.includes("has been aborted") ||
    msg.includes("write conflict")
  );
};

export const getCurrentRoiRate = (level) => ROI_RATES[Number(level || 0)] || 0;

/** ROI rate from Hybrid VIP tier (`level` → ROI_RATES). */
export const getEffectiveRoiRate = (user) => getCurrentRoiRate(user?.level);

/**
 * Pure rounding for Hybrid daily ROI principal: spendable balances only (deposit + reward).
 * Mirrors {@link getRoiPrincipalBase}; exposed for deterministic tests without MongoDB.
 */
export const roiPrincipalTotalFromBalances = (depositBalance, rewardBalance) => {
  const deposit = Number(depositBalance || 0);
  const reward = Number(rewardBalance || 0);
  return Number((deposit + reward).toFixed(8));
};

export const getRoiPrincipalBase = async (userId, session = null) => {
  /**
   ROI base includes:

   depositBalance

   rewardBalance

   Excludes:

   pendingWithdraw

   active stakes

   expired trial balances */

  await expireTrialIfNeeded(userId, session);
  const balanceQuery = User.findById(userId).select("depositBalance rewardBalance");
  if (session) {
    balanceQuery.session(session);
  }
  const user = await balanceQuery.lean();
  return roiPrincipalTotalFromBalances(user?.depositBalance, user?.rewardBalance);
};

export const claimDailyRoi = async (userId) => {
  const redis = getReadyRedis();
  const inflightKey = `hybrid:roi_claim_inflight:${String(userId)}`;
  const inflightTtl = Math.max(4, Number(process.env.HYBRID_ROI_INFLIGHT_SEC || 12));
  let inflightHeld = false;

  if (redis && isRedisReady(redis)) {
    try {
      const ok = await redis.set(inflightKey, String(Date.now()), "NX", "EX", inflightTtl);
      inflightHeld = ok === "OK";
      if (!inflightHeld) {
        throw new Error("ROI claim already in progress — please wait a few seconds");
      }
    } catch (err) {
      if (String(err?.message || "").includes("already in progress")) {
        throw err;
      }
      /* Redis degraded — continue without inflight gate */
    }
  }

  const releaseInflight = async () => {
    if (inflightHeld && redis && isRedisReady(redis)) {
      await redis.del(inflightKey).catch(() => {});
    }
  };

  const MAX_ATTEMPTS = Math.max(1, Number(process.env.HYBRID_ROI_CLAIM_MAX_ATTEMPTS || 3));
  /** @type {Error|null} */
  let lastErr = null;

  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const session = await mongoose.startSession();

      try {
        /** @type {null | { amount: number; roiRate: number; totalBase: number }} */
        let result = null;

        await session.withTransaction(async () => {
          await expireTrialIfNeeded(userId, session);

          const user = await User.findById(userId)
            .select(
              "depositBalance rewardBalance pendingWithdraw lastDailyClaim level totalEarnings todayProfit",
            )
            .session(session);

          if (!user) {
            throw new Error("User not found");
          }

          if (!isAfter5AM()) {
            throw new Error("ROI claim available after 5:00 AM (PKT)");
          }

          if (alreadyClaimedToday(user.lastDailyClaim)) {
            throw new Error("ROI already claimed today");
          }

          const now = new Date();
          const claimWindowStart = getClaimWindowStartUtc(now);

          const roiRate = getEffectiveRoiRate(user);

          if (roiRate <= 0) {
            throw new Error("Reach Hybrid level 1 to claim ROI");
          }

          const totalBase = await getRoiPrincipalBase(userId, session);

          if (totalBase <= 0) {
            throw new Error("No eligible balance for ROI");
          }

          const reward = Number((totalBase * roiRate).toFixed(8));

          const updatedUser = await User.findOneAndUpdate(
            {
              _id: userId,
              $or: [
                { lastDailyClaim: null },
                { lastDailyClaim: { $lt: claimWindowStart } },
                { lastDailyClaim: { $exists: false } },
              ],
            },
            {
              $inc: {
                rewardBalance: reward,
                totalEarnings: reward,
                todayProfit: reward,
              },
              $set: {
                lastDailyClaim: now,
              },
            },
            {
              new: true,
              session,
            },
          );

          if (!updatedUser) {
            throw new Error("ROI already claimed today");
          }

          const [roiLedgerDoc] = await addHybridLedgerEntries(
            [
              {
                userId,
                entryType: "credit",
                balanceType: "rewardBalance",
                amount: reward,
                source: "roi_claim",
                meta: {
                  level: user.level,
                  roiRate,
                  totalBase,
                },
              },
            ],
            session,
          );

          await distributeRoiReferralRewards(userId, reward, session, {
            roiClaimLedgerId: roiLedgerDoc._id,
          });

          result = {
            amount: reward,
            roiRate,
            totalBase,
          };
        });

        bumpClaimRoi(true);
        logger.debug?.("Hybrid ROI claim committed", { userId: String(userId) });
        return result;
      } catch (error) {
        lastErr = error;
        logger.debug?.("Hybrid ROI claim attempt failed", {
          userId: String(userId),
          attempt: attempt + 1,
          error: error?.message || String(error),
        });

        const canRetry = attempt < MAX_ATTEMPTS - 1 && isTransientRoiTxnError(error);
        if (canRetry) {
          await new Promise((r) => setTimeout(r, 35 * (attempt + 1)));
          continue;
        }
        bumpClaimRoi(false);
        throw new Error(error?.message || "Failed to claim ROI");
      } finally {
        session.endSession();
      }
    }

    bumpClaimRoi(false);
    throw new Error(lastErr?.message || "Failed to claim ROI");
  } finally {
    await releaseInflight();
  }
};
