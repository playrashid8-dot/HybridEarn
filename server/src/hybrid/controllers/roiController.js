import User from "../../models/User.js";
import {
  claimDailyRoi,
  getEffectiveRoiRate,
  getRoiPrincipalBase,
} from "../services/roiService.js";
import { expireTrialIfNeeded } from "../services/trialService.js";
import { sendError, sendSuccess } from "../utils/response.js";
import { getNextPktFiveAmUtc, getPktRoiClaimFlags } from "../utils/roiPktTime.js";

export const claimRoi = async (req, res) => {
  try {
    const result = await claimDailyRoi(req.user._id);
    const nextAt = getNextPktFiveAmUtc(new Date());
    return sendSuccess(res, "ROI claimed successfully", {
      ...result,
      nextClaimAvailableAt: nextAt.toISOString(),
    });
  } catch (error) {
    return sendError(res, 400, error.message || "Failed to claim ROI", null);
  }
};

/** Optional: read-only hint for dashboards (claim still enforces server-side). */
export const getRoiClaimStatus = async (req, res) => {
  try {
    await expireTrialIfNeeded(req.user._id);
    const user = await User.findById(req.user._id)
      .select("lastDailyClaim depositBalance level")
      .lean();
    if (!user) {
      return sendError(res, 404, "User not found", null);
    }
    const roiPrincipalBase = await getRoiPrincipalBase(req.user._id);
    const effectiveRoiRate = getEffectiveRoiRate(user);
    const { isAfter5AMPkt, claimedTodayPkt, roiCountdownTargetIso } = getPktRoiClaimFlags(
      user.lastDailyClaim,
    );
    const canClaim =
      isAfter5AMPkt &&
      !claimedTodayPkt &&
      roiPrincipalBase > 0 &&
      effectiveRoiRate > 0;
    return sendSuccess(res, "ROI claim status", {
      canClaim,
      nextClaimAvailableAt: roiCountdownTargetIso,
      isAfter5AMPkt,
      claimedTodayPkt,
      roiCountdownTargetIso,
      roiPrincipalBase,
      roiRate: effectiveRoiRate,
    });
  } catch (error) {
    return sendError(res, 500, error.message || "Failed to read ROI status", null);
  }
};
