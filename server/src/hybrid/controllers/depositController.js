import User from "../../models/User.js";
import { getUserHybridDeposits } from "../services/depositService.js";
import { getUserStakes } from "../services/stakingService.js";
import {
  getEffectiveRoiRate,
  getRoiPrincipalBase,
} from "../services/roiService.js";
import { expireTrialIfNeeded } from "../services/trialService.js";
import { getSalaryUiMeta } from "../services/salaryService.js";
import { sendError, sendSuccess } from "../utils/response.js";
import { getPktRoiClaimFlags } from "../utils/roiPktTime.js";
import {
  LEVEL_RULES,
  MIN_HYBRID_DEPOSIT,
  SALARY_RULES,
  WITHDRAW_MIN_AMOUNT,
} from "../utils/constants.js";
import { ONE_HOUR_MS, WITHDRAW_DELAY_MS, DEPOSIT_WITHDRAW_LOCK_MS } from "../utils/time.js";
import { getHybridReferralIncomeBreakdown } from "../services/firstDepositBonusService.js";

export const getHybridDepositDashboard = async (req, res) => {
  try {
    await expireTrialIfNeeded(req.user._id);

    const [user, deposits, stakes, salaryUi, referralBreakdown] = await Promise.all([
      User.findById(req.user._id)
        .select(
          "walletAddress depositBalance rewardBalance referralEarnings level pendingWithdraw salaryStage salaryDirectCount salaryTeamCount lastDailyClaim directCount teamCount claimedSalaryStages totalEarnings salaryProgress",
        )
        .lean(),
      getUserHybridDeposits(req.user._id),
      getUserStakes(req.user._id),
      getSalaryUiMeta(req.user._id),
      getHybridReferralIncomeBreakdown(req.user._id),
    ]);

    if (!user) {
      return sendError(res, 404, "User not found");
    }

    const activeStakeAmount = stakes
      .filter((stake) => stake.status === "active")
      .reduce((sum, stake) => sum + Number(stake.amount || 0), 0);

    const { isAfter5AMPkt, claimedTodayPkt, roiCountdownTargetIso } = getPktRoiClaimFlags(
      user.lastDailyClaim,
    );
    const roiPrincipalBase = await getRoiPrincipalBase(req.user._id);
    const effectiveRoiRate = getEffectiveRoiRate(user);

    const canClaimRoi =
      isAfter5AMPkt &&
      !claimedTodayPkt &&
      roiPrincipalBase > 0 &&
      effectiveRoiRate > 0;
    const nextRoiClaimAt = roiCountdownTargetIso;

    return sendSuccess(res, "Hybrid deposit data fetched successfully", {
      walletAddress: (user.walletAddress || "").toLowerCase(),
      depositBalance: Number(user.depositBalance || 0),
      rewardBalance: Number(user.rewardBalance || 0),
      referralEarnings: Number(user.referralEarnings || 0),
      teamRoiIncome: Number(referralBreakdown.teamRoiIncome || 0),
      firstDepositBonusEarned: Number(referralBreakdown.firstDepositBonusEarned || 0),
      pendingWithdraw: Number(user.pendingWithdraw || 0),
      minDepositAmount: MIN_HYBRID_DEPOSIT,
      withdrawMinAmount: WITHDRAW_MIN_AMOUNT,
      withdrawLockHours: Math.round(WITHDRAW_DELAY_MS / ONE_HOUR_MS),
      depositWithdrawLockHours: Math.round(DEPOSIT_WITHDRAW_LOCK_MS / ONE_HOUR_MS),
      withdrawLockUntil: null,
      canWithdraw: true,
      withdrawReason: null,
      unlockAt: null,
      level: Number(user.level || 0),
      roiRate: effectiveRoiRate,
      salaryStage: Number(user.salaryStage ?? 0),
      salaryDirectCount: Number(user.salaryDirectCount || 0),
      salaryTeamCount: Number(user.salaryTeamCount || 0),
      salaryRules: SALARY_RULES,
      levelRules: LEVEL_RULES,
      directCount: Number(user.directCount || 0),
      teamCount: Number(user.teamCount || 0),
      activeStakeAmount,
      lastDailyClaim: user.lastDailyClaim,
      isAfter5AMPkt,
      claimedTodayPkt,
      roiCountdownTargetIso,
      canClaimRoi,
      nextRoiClaimAt,
      roiPrincipalBase,
      totalEarnings: Number(user.totalEarnings || 0),
      salaryUi,
      deposits,
      stakes,
    });
  } catch (error) {
    return sendError(res, 500, error.message || "Failed to fetch Hybrid data");
  }
};

export const getMyHybridDeposits = async (req, res) => {
  try {
    const deposits = await getUserHybridDeposits(req.user._id);
    return sendSuccess(res, "Hybrid deposits fetched successfully", { deposits });
  } catch (error) {
    return sendError(res, 500, error.message || "Failed to fetch deposits");
  }
};
