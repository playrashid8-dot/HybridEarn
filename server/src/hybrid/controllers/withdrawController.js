import bcrypt from "bcryptjs";
import User from "../../models/User.js";
import logger from "../../utils/logger.js";
import {
  claimHybridWithdrawal,
  getHybridWithdrawals,
  requestHybridWithdrawal,
} from "../services/withdrawService.js";
import { sendError, sendSuccess } from "../utils/response.js";

const getIdempotencyKey = (req) => req.get("Idempotency-Key")?.trim() || null;

export const requestWithdraw = async (req, res) => {
  try {
    const { amount, walletAddress, password } = req.body;

    logger.debug?.("Hybrid withdraw POST received", {
      amount,
      walletPreview:
        walletAddress != null ? `${String(walletAddress).trim().slice(0, 10)}…` : "",
      passwordPresent:
        password != null && String(password).trim().length ? true : false,
    });

    const passwordStr = password != null ? String(password) : "";
    if (!passwordStr.trim()) {
      return sendError(res, 400, "Password required", null);
    }

    const rawWallet = walletAddress != null ? String(walletAddress).trim() : "";
    if (!rawWallet.startsWith("0x") || rawWallet.length !== 42) {
      return sendError(
        res,
        400,
        "Enter a valid BEP20 wallet: must start with 0x and be 42 characters",
        null
      );
    }

    const user = await User.findById(req.user._id).select("+password isBlocked");

    if (!user) {
      return sendError(res, 404, "User not found", null);
    }

    if (user.isBlocked) {
      return sendError(res, 403, "Account blocked", null);
    }

    const isMatch = await bcrypt.compare(passwordStr, user.password);

    if (!isMatch) {
      return sendError(res, 400, "Invalid password");
    }

    const result = await requestHybridWithdrawal(
      req.user._id,
      amount,
      rawWallet,
      getIdempotencyKey(req)
    );

    const w = result?.withdrawal?.walletAddress || "";
    logger.debug?.("Hybrid withdraw request persisted snapshot", {
      withdrawalId: result?.withdrawal?._id ? String(result.withdrawal._id) : null,
      grossAmount: Number(result?.withdrawal?.grossAmount ?? amount),
      netAmount:
        result?.withdrawal?.netAmount != null ? Number(result.withdrawal.netAmount) : null,
      status: result?.withdrawal?.status,
      walletPreview: w ? `${String(w).slice(0, 10)}…` : "",
    });
    logger.info("Hybrid withdraw queued for review", {
      userId: String(req.user._id),
      grossAmount: Number(result?.withdrawal?.grossAmount ?? amount),
      withdrawalId: result?.withdrawal?._id ? String(result.withdrawal._id) : null,
    });

    return sendSuccess(res, "Withdrawal request submitted", result);
  } catch (error) {
    return sendError(res, 400, error.message || "Failed to request withdrawal");
  }
};

export const claimWithdraw = async (req, res) => {
  try {
    const { withdrawalId } = req.body;

    if (!withdrawalId) {
      return sendError(res, 400, "Withdrawal ID is required");
    }

    const result = await claimHybridWithdrawal(req.user._id, withdrawalId);
    return sendSuccess(res, "Withdrawal lock cleared; awaiting admin approval and payout", result);
  } catch (error) {
    return sendError(res, 400, error.message || "Failed to claim withdrawal");
  }
};

export const getMyHybridWithdrawals = async (req, res) => {
  try {
    const withdrawals = await getHybridWithdrawals(req.user._id);
    return sendSuccess(res, "Hybrid withdrawals fetched successfully", {
      withdrawals,
      withdrawLockUntil: null,
    });
  } catch (error) {
    return sendError(res, 500, error.message || "Failed to fetch withdrawals");
  }
};
