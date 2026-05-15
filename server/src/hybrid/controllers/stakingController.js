import {
  claimStake,
  createStake,
  getUserStakes,
} from "../services/stakingService.js";
import { sendError, sendSuccess } from "../utils/response.js";

export const createStakePlan = async (req, res) => {
  try {
    const { amount, planDays } = req.body;
    const stake = await createStake(req.user._id, amount, planDays);
    return sendSuccess(res, "Stake created successfully", { stake });
  } catch (error) {
    return sendError(res, 400, error.message || "Failed to create stake");
  }
};

export const claimStakeReward = async (req, res) => {
  try {
    const { stakeId } = req.body;

    if (!stakeId) {
      return sendError(res, 400, "Stake ID is required");
    }

    const result = await claimStake(req.user._id, stakeId);
    return sendSuccess(res, "Stake claimed successfully", result);
  } catch (error) {
    return sendError(res, 400, error.message || "Failed to claim stake");
  }
};

export const getMyStakes = async (req, res) => {
  try {
    const stakes = await getUserStakes(req.user._id);
    return sendSuccess(res, "Stakes fetched successfully", { stakes });
  } catch (error) {
    return sendError(res, 500, error.message || "Failed to fetch stakes");
  }
};
