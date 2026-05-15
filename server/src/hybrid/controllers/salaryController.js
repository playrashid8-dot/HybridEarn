import {
  claimSalary,
  buildSalaryProgressPayload,
} from "../services/salaryService.js";
import { sendError, sendSuccess } from "../utils/response.js";
import logger from "../../utils/logger.js";

export const claimSalaryReward = async (req, res) => {
  try {
    if (!req.user?._id) {
      return sendError(res, 401, "Unauthorized");
    }
    const result = await claimSalary(req.user._id);
    const stage = Number(result?.stage ?? 0);
    return sendSuccess(res, stage ? `Stage ${stage} claimed` : "Salary claimed successfully", result);
  } catch (error) {
    if (error?.statusCode === 409) {
      return sendError(
        res,
        409,
        error.message || "Already claimed or state changed"
      );
    }
    return sendError(res, 400, error.message || "Failed to claim salary");
  }
};

export const getSalaryProgress = async (req, res) => {
  try {
    if (!req.user?._id) {
      return sendError(res, 401, "Unauthorized");
    }
    const data = await buildSalaryProgressPayload(req.user._id);
    if (!data) {
      return sendError(res, 404, "User not found");
    }

    return sendSuccess(res, "Salary progress", {
      stage: data.stage,
      direct: data.direct,
      team: data.team,
      claimableStage: data.claimableStage,
      lastClaimedStage: data.lastClaimedStage,
      lastClaimedAt: data.lastClaimedAt,
      salaryComplete: data.salaryComplete,
      claimedSalaryStages: data.claimedSalaryStages,
      rules: data.rules,
      salaryHistory: data.salaryHistory ?? [],
    });
  } catch (err) {
    logger.error("Hybrid salary GET progress failed", { error: err?.message || String(err) });
    return sendError(res, 500, "Salary calculation failed");
  }
};
