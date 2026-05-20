import User from "../../models/User.js";
import HybridWithdrawal from "../models/HybridWithdrawal.js";
import { addHybridLedgerEntries } from "./ledgerService.js";

const WITHDRAW_BALANCE_EPSILON = 0.00000001;
export const HYBRID_WITHDRAW_OPEN_STATUSES = ["pending", "review", "claimable", "approved"];

const toFixedMoney = (value) => Number(Number(value || 0).toFixed(8));

/** Withdrawable / stakeable active USDT: deposits, internal admin credits, and rewards (trial excluded). */
export const getSpendableHybridBalance = (user) =>
  toFixedMoney(Number(user?.depositBalance || 0) + Number(user?.rewardBalance || 0));

export const getActiveHybridWithdrawal = async (userId, session = null) => {
  const query = HybridWithdrawal.findOne({
    userId,
    paidAt: null,
    status: { $in: HYBRID_WITHDRAW_OPEN_STATUSES },
  })
    .sort({ createdAt: -1 })
    .select("status payoutStatus payoutLockedUntil grossAmount createdAt")
    .lean();

  if (session) query.session(session);

  return query;
};

export const getHybridWithdrawReason = (user, activeWithdrawal = null) => {
  const pendingWithdraw = Number(user?.pendingWithdraw || 0);
  if (pendingWithdraw <= WITHDRAW_BALANCE_EPSILON && !activeWithdrawal) {
    return null;
  }

  const payoutStatus = String(activeWithdrawal?.payoutStatus || "");
  if (payoutStatus === "sending" || payoutStatus === "verifying") {
    return "payout_lock";
  }

  return "pending_withdrawal";
};

export const getWithdrawableHybridBalance = (user, activeWithdrawal = null) => {
  const reason = getHybridWithdrawReason(user, activeWithdrawal);
  return reason ? 0 : getSpendableHybridBalance(user);
};

export const getHybridWithdrawalAvailability = async ({ userId, user, session = null, trace = null }) => {
  const activeStart = Date.now();
  const activeWithdrawal = await getActiveHybridWithdrawal(userId, session);
  if (trace && typeof trace === "object") {
    trace.activeWithdrawalQueryMs = Date.now() - activeStart;
  }
  const withdrawReason = getHybridWithdrawReason(user, activeWithdrawal);
  const spendableUSDT = getSpendableHybridBalance(user);
  const withdrawableUSDT = withdrawReason ? 0 : spendableUSDT;

  return {
    depositBalance: toFixedMoney(user?.depositBalance),
    rewardBalance: toFixedMoney(user?.rewardBalance),
    pendingWithdraw: toFixedMoney(user?.pendingWithdraw),
    spendableUSDT,
    withdrawableUSDT,
    canWithdraw: !withdrawReason,
    withdrawReason,
    activeWithdrawal: activeWithdrawal
      ? {
          status: activeWithdrawal.status,
          payoutStatus: activeWithdrawal.payoutStatus || "idle",
          payoutLockedUntil: activeWithdrawal.payoutLockedUntil || null,
          grossAmount: toFixedMoney(activeWithdrawal.grossAmount),
          createdAt: activeWithdrawal.createdAt || null,
        }
      : null,
  };
};

export const splitHybridBalance = (user, amount) => {
  const targetAmount = Number(amount || 0);
  const rewardBalance = Number(user?.rewardBalance || 0);
  const depositBalance = Number(user?.depositBalance || 0);

  if (targetAmount <= 0) {
    return {
      rewardBalance: 0,
      depositBalance: 0,
    };
  }

  const rewardPart = Math.min(rewardBalance, targetAmount);
  const depositPart = Number((targetAmount - rewardPart).toFixed(8));

  if (rewardPart + depositPart > rewardBalance + depositBalance + 0.0000001) {
    throw new Error("Insufficient Hybrid balance");
  }

  return {
    rewardBalance: Number(rewardPart.toFixed(8)),
    depositBalance: Number(depositPart.toFixed(8)),
  };
};

export const creditActiveUsdtBalance = async ({
  userId,
  amount,
  source,
  referenceId = null,
  meta = null,
  session = null,
}) => {
  const numericAmount = Number(amount || 0);

  if (!userId || !Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Invalid active USDT credit payload");
  }

  const [ledgerEntry] = await addHybridLedgerEntries(
    [
      {
        userId,
        entryType: "credit",
        balanceType: "depositBalance",
        amount: numericAmount,
        source,
        referenceId,
        meta,
      },
    ],
    session
  );

  const updatedUser = await User.findOneAndUpdate(
    {
      _id: userId,
      isBlocked: { $ne: true },
      adminFraudFlag: { $ne: true },
    },
    {
      $inc: {
        depositBalance: numericAmount,
        totalEarnings: numericAmount,
      },
    },
    {
      returnDocument: "after",
      ...(session ? { session } : {}),
    }
  ).select("username email balance depositBalance rewardBalance totalEarnings");

  if (!updatedUser) {
    const err = new Error("User balance state changed; credit aborted");
    err.statusCode = 409;
    throw err;
  }

  return { ledgerEntry, updatedUser };
};
