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
import logger from "../../utils/logger.js";
import { getPktRoiClaimFlags } from "../utils/roiPktTime.js";
import {
  LEVEL_RULES,
  MIN_HYBRID_DEPOSIT,
  WITHDRAW_FEE_RATE,
  SALARY_RULES,
  WITHDRAW_MIN_AMOUNT,
} from "../utils/constants.js";
import { ONE_HOUR_MS, WITHDRAW_DELAY_MS, DEPOSIT_WITHDRAW_LOCK_MS } from "../utils/time.js";
import { getHybridReferralIncomeBreakdown } from "../services/firstDepositBonusService.js";
import { getHybridWithdrawalAvailability } from "../services/balanceService.js";

const timeStep = async (trace, key, work) => {
  const start = Date.now();
  try {
    return await work();
  } finally {
    trace[key] = Date.now() - start;
  }
};

export const getHybridDepositDashboard = async (req, res) => {
  const startedAt = Date.now();
  const trace = {};
  const scope = String(req.query?.scope || "").toLowerCase();
  const withdrawScope = scope === "withdraw";

  try {
    await timeStep(trace, "expireTrialMs", () => expireTrialIfNeeded(req.user._id));

    const userQuery = () =>
      User.findById(req.user._id)
        .select(
          "walletAddress depositBalance rewardBalance referralEarnings level pendingWithdraw lastWithdrawRequest salaryStage salaryDirectCount salaryTeamCount lastDailyClaim directCount teamCount claimedSalaryStages totalEarnings salaryProgress",
        )
        .lean();

    const user = await timeStep(trace, "userQueryMs", userQuery);

    if (!user) {
      return sendError(res, 404, "User not found");
    }

    const [deposits, stakes, salaryUi, referralBreakdown] = withdrawScope
      ? [[], [], null, { teamRoiIncome: 0, firstDepositBonusEarned: 0 }]
      : await Promise.all([
          timeStep(trace, "depositsQueryAndConfirmationsMs", () => getUserHybridDeposits(req.user._id)),
          timeStep(trace, "stakesQueryMs", () => getUserStakes(req.user._id)),
          timeStep(trace, "salaryMetaMs", () => getSalaryUiMeta(req.user._id)),
          timeStep(trace, "referralBreakdownMs", () =>
            getHybridReferralIncomeBreakdown(req.user._id),
          ),
        ]);

    const activeStakeAmount = stakes
      .filter((stake) => stake.status === "active")
      .reduce((sum, stake) => sum + Number(stake.amount || 0), 0);

    const { isAfter5AMPkt, claimedTodayPkt, roiCountdownTargetIso } = getPktRoiClaimFlags(
      user.lastDailyClaim,
    );
    const roiPrincipalBase = withdrawScope
      ? 0
      : await timeStep(trace, "roiPrincipalBaseMs", () => getRoiPrincipalBase(req.user._id));
    const effectiveRoiRate = getEffectiveRoiRate(user);
    const withdrawalAvailability = await timeStep(trace, "withdrawalAvailabilityMs", () =>
      getHybridWithdrawalAvailability({
        userId: req.user._id,
        user,
        trace,
      }),
    );
    trace.totalMs = Date.now() - startedAt;

    logger.info("Hybrid summary runtime trace", {
      userId: String(req.user._id),
      scope: withdrawScope ? "withdraw" : "full",
      totalMs: trace.totalMs,
      timings: trace,
      pendingWithdraw: withdrawalAvailability.pendingWithdraw,
      withdrawableUSDT: withdrawalAvailability.withdrawableUSDT,
      canWithdraw: withdrawalAvailability.canWithdraw,
      withdrawReason: withdrawalAvailability.withdrawReason,
      activeWithdrawal: withdrawalAvailability.activeWithdrawal,
    });

    const canClaimRoi =
      isAfter5AMPkt &&
      !claimedTodayPkt &&
      roiPrincipalBase > 0 &&
      effectiveRoiRate > 0;
    const nextRoiClaimAt = roiCountdownTargetIso;

    return sendSuccess(res, "Hybrid deposit data fetched successfully", {
      walletAddress: (user.walletAddress || "").toLowerCase(),
      depositBalance: withdrawalAvailability.depositBalance,
      rewardBalance: withdrawalAvailability.rewardBalance,
      spendableUSDT: withdrawalAvailability.spendableUSDT,
      withdrawableUSDT: withdrawalAvailability.withdrawableUSDT,
      referralEarnings: Number(user.referralEarnings || 0),
      teamRoiIncome: Number(referralBreakdown.teamRoiIncome || 0),
      firstDepositBonusEarned: Number(referralBreakdown.firstDepositBonusEarned || 0),
      pendingWithdraw: withdrawalAvailability.pendingWithdraw,
      minDepositAmount: MIN_HYBRID_DEPOSIT,
      withdrawMinAmount: WITHDRAW_MIN_AMOUNT,
      withdrawFeeRate: WITHDRAW_FEE_RATE,
      withdrawLockHours: Math.round(WITHDRAW_DELAY_MS / ONE_HOUR_MS),
      depositWithdrawLockHours: Math.round(DEPOSIT_WITHDRAW_LOCK_MS / ONE_HOUR_MS),
      withdrawLockUntil: withdrawalAvailability.activeWithdrawal?.payoutLockedUntil || null,
      canWithdraw: withdrawalAvailability.canWithdraw,
      withdrawReason: withdrawalAvailability.withdrawReason,
      activeWithdrawal: withdrawalAvailability.activeWithdrawal,
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
    logger.error("Hybrid summary runtime trace failed", {
      userId: String(req.user?._id || ""),
      scope: withdrawScope ? "withdraw" : "full",
      totalMs: Date.now() - startedAt,
      timings: trace,
      error: error?.message || String(error),
    });
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
