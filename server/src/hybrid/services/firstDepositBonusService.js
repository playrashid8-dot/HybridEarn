import mongoose from "mongoose";
import User from "../../models/User.js";
import HybridLedger from "../models/HybridLedger.js";
import { addHybridLedgerEntries } from "./ledgerService.js";

/** Match order: greatest min deposit wins (300+ capped at highest slab). */
const SLABS_DESC = [
  { minDeposit: 300, rewardUsdt: 35, rewardTier: "300_plus" },
  { minDeposit: 200, rewardUsdt: 25, rewardTier: "200" },
  { minDeposit: 150, rewardUsdt: 18, rewardTier: "150" },
  { minDeposit: 100, rewardUsdt: 13, rewardTier: "100" },
  { minDeposit: 50, rewardUsdt: 7, rewardTier: "50" },
];

export const FIRST_DEPOSIT_BONUS_LEDGER_SOURCE = "first_deposit_bonus";

/** Lowest deposit amount USDT eligible for any fixed bonus slab. */
export const MIN_FIRST_DEPOSIT_BONUS_DEPOSIT_USDT = SLABS_DESC[SLABS_DESC.length - 1].minDeposit;

export const getDirectHybridSponsorId = (user) =>
  user?.referrer ?? user?.referredBy ?? null;

/**
 * Fixed USDT reward for direct sponsor on downline first qualified hybrid deposit slab.
 */
export function resolveFirstDepositBonusTier(depositAmountUsdt) {
  const amt = Number(depositAmountUsdt);
  if (!Number.isFinite(amt) || amt < SLABS_DESC[SLABS_DESC.length - 1].minDeposit) {
    return { rewardUsdt: 0, rewardTier: null };
  }
  const hit = SLABS_DESC.find((s) => amt >= s.minDeposit);
  return hit
    ? { rewardUsdt: hit.rewardUsdt, rewardTier: hit.rewardTier }
    : { rewardUsdt: 0, rewardTier: null };
}

/**
 * Sum hybrid referral rewards from ledger credits (immutable — good for splits vs live User.referralEarnings).
 */
export async function getHybridReferralIncomeBreakdown(userId) {
  const oid =
    userId instanceof mongoose.Types.ObjectId
      ? userId
      : new mongoose.Types.ObjectId(String(userId));

  const rows = await HybridLedger.aggregate([
    {
      $match: {
        userId: oid,
        entryType: "credit",
        balanceType: "rewardBalance",
        source: { $in: ["roi_referral_bonus", "first_deposit_bonus", "referral_bonus"] },
      },
    },
    { $group: { _id: "$source", total: { $sum: "$amount" } } },
  ]);

  const by = Object.fromEntries(
    rows.map((r) => [String(r._id), Number(r.total || 0)]),
  );

  const teamRoiIncome =
    Number(by.roi_referral_bonus || 0) + Number(by.referral_bonus || 0);

  const firstDepositBonusEarned = Number(by.first_deposit_bonus || 0);

  return {
    teamRoiIncome,
    firstDepositBonusEarned,
  };
}

/**
 * Pays L1 sponsor a one-time slab bonus when a downline makes their first qualifying hybrid deposit transition.
 * Idempotent via ledger row keyed by source + meta.fromUserId (depositor).
 */
export async function distributeFirstDepositBonus(
  {
    depositorUserId,
    sponsorUserId,
    depositAmountUsdt,
    depositReferenceId,
    depositTxHash,
  },
  session,
) {
  if (!session) {
    throw new Error("distributeFirstDepositBonus requires Mongo session");
  }

  const depOid =
    depositorUserId instanceof mongoose.Types.ObjectId
      ? depositorUserId
      : new mongoose.Types.ObjectId(String(depositorUserId));

  const sponsorOid =
    sponsorUserId instanceof mongoose.Types.ObjectId
      ? sponsorUserId
      : new mongoose.Types.ObjectId(String(sponsorUserId));

  const depStr = String(depOid);

  if (String(sponsorOid) === depStr) {
    return { paid: false, reason: "invalid_sponsor_self" };
  }

  const dup = await HybridLedger.findOne({
    source: FIRST_DEPOSIT_BONUS_LEDGER_SOURCE,
    "meta.fromUserId": depStr,
  }).session(session);

  if (dup) {
    return { paid: false, reason: "duplicate" };
  }

  const sponsor = await User.findById(sponsorOid).select("_id").session(session);
  if (!sponsor) {
    return { paid: false, reason: "sponsor_not_found" };
  }

  const { rewardUsdt, rewardTier } = resolveFirstDepositBonusTier(depositAmountUsdt);
  if (!(rewardUsdt > 0) || !rewardTier) {
    return { paid: false, reason: "no_tier" };
  }

  const rewardFixed = Number(rewardUsdt.toFixed(8));

  await User.findByIdAndUpdate(
    sponsorOid,
    {
      $inc: {
        rewardBalance: rewardFixed,
        referralEarnings: rewardFixed,
        totalEarnings: rewardFixed,
      },
    },
    { session },
  );

  const refOid =
    depositReferenceId instanceof mongoose.Types.ObjectId
      ? depositReferenceId
      : new mongoose.Types.ObjectId(String(depositReferenceId));

  await addHybridLedgerEntries(
    [
      {
        userId: sponsorOid,
        entryType: "credit",
        balanceType: "rewardBalance",
        amount: rewardFixed,
        source: FIRST_DEPOSIT_BONUS_LEDGER_SOURCE,
        referenceId: refOid,
        meta: {
          fromUserId: depStr,
          depositAmount: Number(depositAmountUsdt),
          rewardTier,
          ...(depositTxHash
            ? { depositTxHash: String(depositTxHash).trim().toLowerCase() }
            : {}),
        },
      },
    ],
    session,
  );

  return { paid: true, rewardUsdt: rewardFixed, rewardTier };
}
