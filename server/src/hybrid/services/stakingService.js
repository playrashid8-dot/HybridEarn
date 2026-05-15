import mongoose from "mongoose";
import User from "../../models/User.js";
import HybridStake from "../models/HybridStake.js";
import { STAKE_PLANS } from "../utils/constants.js";
import { ONE_DAY_MS } from "../utils/time.js";
import { addHybridLedgerEntries } from "./ledgerService.js";
import { getSpendableHybridBalance, splitHybridBalance } from "./balanceService.js";

export const createStake = async (userId, amount, planDays) => {
  const session = await mongoose.startSession();

  try {
    let result = null;
    const numericAmount = Number(amount || 0);
    const numericPlanDays = Number(planDays || 0);
    const plan = STAKE_PLANS[numericPlanDays];

    if (!plan) {
      throw new Error("Invalid staking plan");
    }

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      throw new Error("Amount must be greater than 0");
    }

    await session.withTransaction(async () => {
      const user = await User.findById(userId)
        .select("depositBalance rewardBalance")
        .session(session);

      if (!user) {
        throw new Error("User not found");
      }

      if (getSpendableHybridBalance(user) < numericAmount) {
        throw new Error("Insufficient Hybrid balance");
      }

      const sourceBreakdown = splitHybridBalance(user, numericAmount);
      const now = new Date();
      const endAt = new Date(now.getTime() + plan.days * ONE_DAY_MS);
      const totalReward = Number((numericAmount * plan.dailyRate * plan.days).toFixed(8));

      const [stake] = await HybridStake.create(
        [
          {
            userId,
            amount: numericAmount,
            planDays: plan.days,
            dailyRate: plan.dailyRate,
            totalReward,
            startAt: now,
            endAt,
            sourceBreakdown,
          },
        ],
        { session }
      );

      const updatedUser = await User.findOneAndUpdate(
        {
          _id: userId,
          rewardBalance: { $gte: sourceBreakdown.rewardBalance },
          depositBalance: { $gte: sourceBreakdown.depositBalance },
        },
        {
          $inc: {
            rewardBalance: -sourceBreakdown.rewardBalance,
            depositBalance: -sourceBreakdown.depositBalance,
          },
        },
        {
          new: true,
          session,
        }
      );

      if (!updatedUser) {
        throw new Error("Insufficient Hybrid balance");
      }

      const ledgerEntries = [];

      if (sourceBreakdown.rewardBalance > 0) {
        ledgerEntries.push({
          userId,
          entryType: "debit",
          balanceType: "rewardBalance",
          amount: sourceBreakdown.rewardBalance,
          source: "stake_create",
          referenceId: stake._id,
          meta: {
            planDays: plan.days,
          },
        });
      }

      if (sourceBreakdown.depositBalance > 0) {
        ledgerEntries.push({
          userId,
          entryType: "debit",
          balanceType: "depositBalance",
          amount: sourceBreakdown.depositBalance,
          source: "stake_create",
          referenceId: stake._id,
          meta: {
            planDays: plan.days,
          },
        });
      }

      await addHybridLedgerEntries(ledgerEntries, session);

      result = stake;
    });

    return result;
  } finally {
    session.endSession();
  }
};

export const claimStake = async (userId, stakeId) => {
  const session = await mongoose.startSession();

  try {
    let result = null;

    await session.withTransaction(async () => {
      const stake = await HybridStake.findOne({
        _id: stakeId,
        userId,
        status: "active",
      }).session(session);

      if (!stake) {
        throw new Error("Stake not found");
      }

      if (new Date(stake.endAt).getTime() > Date.now()) {
        throw new Error("Stake is still active");
      }

      const payout = Number((Number(stake.amount) + Number(stake.totalReward)).toFixed(8));

      const claimedStake = await HybridStake.findOneAndUpdate(
        {
          _id: stake._id,
          userId,
          status: "active",
          endAt: { $lte: new Date() },
        },
        {
          $set: {
            status: "claimed",
            claimedAt: new Date(),
          },
        },
        {
          new: true,
          session,
        }
      );

      if (!claimedStake) {
        throw new Error("Stake already claimed");
      }

      await User.findByIdAndUpdate(
        userId,
        {
          $inc: {
            rewardBalance: payout,
            totalEarnings: Number(stake.totalReward || 0),
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
            balanceType: "rewardBalance",
            amount: payout,
            source: "stake_claim",
            referenceId: stake._id,
            meta: {
              principal: Number(stake.amount || 0),
              reward: Number(stake.totalReward || 0),
              planDays: stake.planDays,
            },
          },
        ],
        session
      );

      result = {
        stakeId: stake._id,
        payout,
        reward: Number(stake.totalReward || 0),
      };
    });

    return result;
  } finally {
    session.endSession();
  }
};

export const getUserStakes = async (userId) =>
  HybridStake.find({ userId }).sort({ createdAt: -1 });
