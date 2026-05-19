import { runAutoWithdrawExecutorBatch } from "./withdrawService.js";
import { claimDailyRoi } from "./roiService.js";
import logger from "../../utils/logger.js";

/**
 * @param {{ name: string; data: object; opts?: object; updateProgress?: (progress: object) => Promise<void> }} jobLike
 */
export async function processHybridPayoutJob(jobLike) {
  const name = String(jobLike?.name || "");
  const data = jobLike?.data || {};
  const jobId = jobLike?.id ? String(jobLike.id) : null;

  logger.info("Hybrid payout queue processor started job", {
    jobId,
    jobName: name,
  });

  if (name === "withdraw_batch") {
    const limit = Math.max(1, Number(data.limit) || 1);
    const result = await runAutoWithdrawExecutorBatch(limit);
    logger.info("Hybrid payout queue processor finished withdraw batch", {
      jobId,
      limit,
      processed: result?.processed ?? 0,
      failed: result?.failed ?? 0,
    });
    return result;
  }

  if (name === "roi_claim") {
    const userId = data.userId;
    if (typeof jobLike?.updateProgress === "function") {
      await jobLike.updateProgress({ status: "processing", phase: "roi_claim_started" });
    }
    try {
      const out = await claimDailyRoi(userId);
      if (typeof jobLike?.updateProgress === "function") {
        await jobLike.updateProgress({ status: "completed", phase: "roi_claim_committed" });
      }
      logger.info("Hybrid payout queue processor finished ROI claim", {
        jobId,
        userId: String(userId || ""),
        amount: out?.amount ?? null,
      });
      return { ok: true, roi: out };
    } catch (err) {
      if (typeof jobLike?.updateProgress === "function") {
        await jobLike.updateProgress({
          status: "failed",
          phase: "roi_claim_failed",
          reason: err?.message || "roi_claim_failed",
        }).catch(() => {});
      }
      logger.error("Hybrid payout queue processor failed ROI claim", {
        jobId,
        userId: String(userId || ""),
        error: err?.message || String(err),
      });
      throw err;
    }
  }

  throw new Error(`hybridPayout: unknown job "${name}"`);
}
