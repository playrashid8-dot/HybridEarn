import { runAutoWithdrawExecutorBatch } from "./withdrawService.js";
import { claimDailyRoi } from "./roiService.js";
import logger from "../../utils/logger.js";

/**
 * @param {{ name: string; data: object; opts?: object }} jobLike
 */
export async function processHybridPayoutJob(jobLike) {
  const name = String(jobLike?.name || "");
  const data = jobLike?.data || {};

  if (name === "withdraw_batch") {
    const limit = Math.max(1, Number(data.limit) || 1);
    return runAutoWithdrawExecutorBatch(limit);
  }

  if (name === "roi_claim") {
    const userId = data.userId;
    const out = await claimDailyRoi(userId);
    return { ok: true, roi: out };
  }

  throw new Error(`hybridPayout: unknown job "${name}"`);
}
