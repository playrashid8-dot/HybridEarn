import mongoose from "mongoose";
import User from "../../models/User.js";
import HybridLedger from "../models/HybridLedger.js";
import { REFERRAL_RATES } from "../utils/constants.js";
import { addHybridLedgerEntries } from "./ledgerService.js";
import { updateUserLevel } from "./levelService.js";

const getParentId = (user) => user?.referrer || user?.referredBy || null;

/**
 * Credits L1–L3 from a successful daily ROI claim (basis = claimed ROI amount).
 * Idempotent per claim via `roiClaimLedgerId` (the claimant's `roi_claim` ledger row).
 */
export const distributeRoiReferralRewards = async (
  claimerUserId,
  roiClaimAmount,
  session = null,
  options = {}
) => {
  const { roiClaimLedgerId } = options || {};
  if (!roiClaimLedgerId) {
    throw new Error("roiClaimLedgerId required for ROI referral distribution");
  }

  const ledgerOid =
    roiClaimLedgerId instanceof mongoose.Types.ObjectId
      ? roiClaimLedgerId
      : new mongoose.Types.ObjectId(String(roiClaimLedgerId));

  const dup = await HybridLedger.findOne({
    source: "roi_referral_bonus",
    "meta.roiClaimLedgerId": ledgerOid,
  }).session(session);

  if (dup) {
    return [];
  }

  const sourceUser = await User.findById(claimerUserId)
    .select("referredBy referrer")
    .session(session);

  if (!sourceUser) {
    return [];
  }

  const amt = Number(roiClaimAmount || 0);
  if (!Number.isFinite(amt) || amt <= 0) {
    return [];
  }

  const appliedRewards = [];
  const levelTouchedIds = new Set();
  const visited = new Set();

  let currentParentId = getParentId(sourceUser);
  let depth = 1;

  while (
    currentParentId &&
    depth <= REFERRAL_RATES.length &&
    !visited.has(String(currentParentId))
  ) {
    visited.add(String(currentParentId));
    const parent = await User.findById(currentParentId)
      .select("_id referredBy referrer level")
      .session(session);

    if (!parent) {
      break;
    }

    const parentLevel = Number(parent.level || 0);
    const rule = REFERRAL_RATES.find((item) => item.depth === depth);

    if (rule && parentLevel >= depth) {
      const reward = Number((amt * rule.rate).toFixed(8));

      if (reward > 0) {
        await User.findByIdAndUpdate(
          parent._id,
          {
            $inc: {
              rewardBalance: reward,
              referralEarnings: reward,
              totalEarnings: reward,
              teamVolume: amt,
            },
          },
          {
            session,
          }
        );

        appliedRewards.push({
          userId: parent._id,
          amount: reward,
          depth,
        });
        levelTouchedIds.add(String(parent._id));
      }
    }

    currentParentId = getParentId(parent);
    depth += 1;
  }

  if (appliedRewards.length > 0) {
    await addHybridLedgerEntries(
      appliedRewards.map((item) => ({
        userId: item.userId,
        entryType: "credit",
        balanceType: "rewardBalance",
        amount: item.amount,
        source: "roi_referral_bonus",
        meta: {
          depth: item.depth,
          fromUserId: String(claimerUserId),
          roiClaimLedgerId: ledgerOid,
          roiClaimAmount: amt,
          accountingKind: "team_roi_income",
        },
      })),
      session
    );
  }

  for (const touchedId of levelTouchedIds) {
    await updateUserLevel(touchedId, session);
  }

  return appliedRewards;
};
