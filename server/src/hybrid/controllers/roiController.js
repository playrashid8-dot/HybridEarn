import User from "../../models/User.js";
import {
  claimDailyRoi,
  getEffectiveRoiRate,
  getRoiPrincipalBase,
} from "../services/roiService.js";
import { expireTrialIfNeeded } from "../services/trialService.js";
import { sendError, sendSuccess } from "../utils/response.js";
import {
  getClaimWindowStartUtc,
  getNextPktFiveAmUtc,
  getPktRoiClaimFlags,
  isAfter5AM,
} from "../utils/roiPktTime.js";
import { enqueueRoiClaimJob, getRoiClaimJobStatus } from "../../queues/payoutQueue.js";
import logger from "../../utils/logger.js";

const shouldQueueRoiClaims = () => {
  const novaService = String(process.env.NOVA_SERVICE || "all").trim().toLowerCase();
  return (
    novaService === "api" ||
    String(process.env.HYBRID_ROI_USE_QUEUE || "").toLowerCase() === "true"
  );
};

export const claimRoi = async (req, res) => {
  try {
    let result;
    if (shouldQueueRoiClaims()) {
      if (!isAfter5AM()) {
        return sendError(res, 400, "ROI claim available after 5:00 AM (PKT)", null);
      }
      const claimWindowStartMs = getClaimWindowStartUtc(new Date()).getTime();
      logger.info("Hybrid ROI API claim enqueuing for HYBRID2 worker", {
        userId: String(req.user._id),
        claimWindowStartMs,
      });
      const queued = await enqueueRoiClaimJob(req.user._id, claimWindowStartMs);
      if (!queued.ok) {
        const reason = queued.reason || "ROI worker unavailable";
        const unavailable =
          reason === "no_queue" ||
          /queue/i.test(String(reason));
        return sendError(
          res,
          unavailable ? 503 : 400,
          unavailable ? "ROI worker unavailable; please retry shortly" : reason,
          null,
        );
      }
      const jobStatus = await getRoiClaimJobStatus(
        req.user._id,
        claimWindowStartMs,
        queued.jobId,
      ).catch((err) => ({
        ok: false,
        reason: err?.message || "job_status_unavailable",
      }));
      const nextAt = getNextPktFiveAmUtc(new Date());
      return sendSuccess(res, "ROI claim queued", {
        queued: true,
        jobId: queued.jobId,
        status: jobStatus?.status || "queued",
        claimWindowStartMs,
        deduped: queued.deduped === true,
        nextClaimAvailableAt: nextAt.toISOString(),
      });
    } else {
      result = await claimDailyRoi(req.user._id);
    }
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
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    await expireTrialIfNeeded(req.user._id);
    const user = await User.findById(req.user._id)
      .select("lastDailyClaim depositBalance rewardBalance level")
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
    logger.info("Hybrid ROI status evaluated", {
      userId: String(req.user._id),
      canClaim,
      isAfter5AMPkt,
      claimedTodayPkt,
      lastDailyClaim: user.lastDailyClaim ? new Date(user.lastDailyClaim).toISOString() : null,
      depositBalance: Number(user.depositBalance || 0),
      rewardBalance: Number(user.rewardBalance || 0),
      roiPrincipalBase,
      roiRate: effectiveRoiRate,
      skipReason: canClaim
        ? null
        : !isAfter5AMPkt
          ? "before_5am_pkt"
          : claimedTodayPkt
            ? "already_claimed_today"
            : roiPrincipalBase <= 0
              ? "no_eligible_balance"
              : "level_without_roi_rate",
    });
    const claimWindowStartMs = getClaimWindowStartUtc(new Date()).getTime();
    const requestedJobId =
      typeof req.query?.jobId === "string" ? req.query.jobId : null;
    const queueStatus = shouldQueueRoiClaims()
      ? await getRoiClaimJobStatus(req.user._id, claimWindowStartMs, requestedJobId).catch((err) => ({
          ok: false,
          reason: err?.message || "job_status_unavailable",
        }))
      : null;
    const completedResult = queueStatus?.returnvalue?.roi || queueStatus?.returnvalue || null;
    const effectiveQueueStatus =
      claimedTodayPkt && queueStatus?.exists === false
        ? {
            ...queueStatus,
            status: "completed",
            state: "claimed_without_retained_job",
          }
        : queueStatus && queueStatus.ok === false
          ? {
              ...queueStatus,
              status: "failed",
              state: queueStatus.state || "status_unavailable",
            }
          : requestedJobId && queueStatus?.exists === false
            ? {
                ...queueStatus,
                status: "failed",
                state: "missing_requested_job",
                failedReason: "ROI job status is unavailable; please retry shortly",
              }
        : queueStatus;

    if (effectiveQueueStatus) {
      logger.info("Hybrid ROI claim status fetched", {
        userId: String(req.user._id),
        jobId: effectiveQueueStatus.jobId || null,
        requestedJobId,
        status: effectiveQueueStatus.status || null,
        state: effectiveQueueStatus.state || null,
        claimedTodayPkt,
      });
      if (effectiveQueueStatus.status === "completed") {
        logger.info("Hybrid ROI claim status completed", {
          userId: String(req.user._id),
          jobId: effectiveQueueStatus.jobId || null,
          state: effectiveQueueStatus.state || null,
        });
      } else if (effectiveQueueStatus.status === "failed") {
        logger.warn("Hybrid ROI claim status failed", {
          userId: String(req.user._id),
          jobId: effectiveQueueStatus.jobId || null,
          state: effectiveQueueStatus.state || null,
          failedReason: effectiveQueueStatus.failedReason || effectiveQueueStatus.reason || null,
        });
      }
    }

    return sendSuccess(res, "ROI claim status", {
      canClaim,
      nextClaimAvailableAt: roiCountdownTargetIso,
      isAfter5AMPkt,
      claimedTodayPkt,
      roiCountdownTargetIso,
      roiPrincipalBase,
      roiRate: effectiveRoiRate,
      queue: effectiveQueueStatus
        ? {
            queued: ["queued", "processing", "broadcasting"].includes(
              String(effectiveQueueStatus.status || ""),
            ),
            jobId: effectiveQueueStatus.jobId || null,
            status: effectiveQueueStatus.status || "queued",
            state: effectiveQueueStatus.state || null,
            attemptsMade: effectiveQueueStatus.attemptsMade ?? null,
            processedOn: effectiveQueueStatus.processedOn ?? null,
            finishedOn: effectiveQueueStatus.finishedOn ?? null,
            failedReason: effectiveQueueStatus.failedReason || effectiveQueueStatus.reason || null,
            result: completedResult,
          }
        : null,
    });
  } catch (error) {
    return sendError(res, 500, error.message || "Failed to read ROI status", null);
  }
};
