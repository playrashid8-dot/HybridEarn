import Withdrawal from "../models/Withdrawal.js";
import User from "../models/User.js";
import Transaction from "../models/Transaction.js";
import Ledger from "../models/Ledger.js";
import AuditLog from "../models/AuditLog.js";
import mongoose from "mongoose";

const getIdempotencyKey = (req) => req.get("Idempotency-Key")?.trim() || null;

const logControllerError = (action, req, err) => {
  console.log("USER ID:", req.user?._id);
  console.log("ACTION:", action);
  console.log("ERROR:", err.message);
};

//
// 🔥 CREATE WITHDRAWAL
//
export const createWithdrawal = async (req, res) => {
  let session;

  try {
    return res.status(400).json({
      success: false,
      msg: "Legacy withdrawals are disabled. Use the HybridEarn withdrawal API.",
      data: null,
    });

    let { amount, walletAddress } = req.body;
    const idempotencyKey = getIdempotencyKey(req);

    amount = Number(amount);
    walletAddress = walletAddress?.trim();

    // ✅ VALIDATION
    if (!req.user?._id) {
      return res.status(401).json({
        success: false,
        msg: "Unauthorized",
        data: null,
      });
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        msg: "Amount must be a number greater than 0",
        data: null,
      });
    }

    if (!walletAddress || walletAddress.length < 8) {
      return res.status(400).json({
        success: false,
        msg: "Valid wallet address required",
        data: null,
      });
    }

    if (idempotencyKey) {
      const previous = await Withdrawal.findOne({
        userId: req.user._id,
        idempotencyKey,
      });

      if (previous?.idempotencyResponse) {
        return res.status(200).json(previous.idempotencyResponse);
      }

      if (previous) {
        return res.status(200).json({
          success: true,
          msg: "Duplicate request",
          data: previous,
        });
      }
    }

    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found",
        data: null,
      });
    }

    if (user.isBlocked) {
      return res.status(403).json({
        success: false,
        msg: "Account blocked",
        data: null,
      });
    }

    session = await mongoose.startSession();

    const cooldownMs = 96 * 60 * 60 * 1000;
    const now = new Date();
    const cutoff = new Date(now.getTime() - cooldownMs);
    // ⏱ 96h delay
    const releaseAt = new Date(Date.now() + cooldownMs);

    let withdrawal;
    let responseBody;
    try {
      await session.withTransaction(async () => {
        // 🔥 ATOMIC BALANCE DEDUCT
        const updated = await User.findOneAndUpdate(
          {
            _id: user._id,
            isBlocked: { $ne: true },
            balance: { $gte: amount },
            $or: [
              { lastWithdrawalAt: { $exists: false } },
              { lastWithdrawalAt: null },
              { lastWithdrawalAt: { $lte: cutoff } },
            ],
          },
          { $inc: { balance: -amount }, $set: { lastWithdrawalAt: now } },
          { new: true, session }
        );

        if (!updated) {
          throw new Error("WITHDRAWAL_DEDUCT_FAILED");
        }

        withdrawal = (await Withdrawal.create([{
          userId: user._id,
          amount,
          walletAddress,
          releaseAt,
          status: "pending",
          idempotencyKey,
        }], { session }))[0];

        // 🔥 CREATE TRANSACTION (HISTORY)
        await Transaction.findOneAndUpdate(
          { type: "withdraw", refId: withdrawal._id },
          {
            user: user._id,
            type: "withdraw",
            amount,
            status: "pending",
            refId: withdrawal._id,
          },
          { upsert: true, new: true, setDefaultsOnInsert: true, session }
        );

        await Ledger.create([{
          userId: user._id,
          type: "debit",
          amount,
          balanceBefore: Number(updated.balance || 0) + amount,
          balanceAfter: Number(updated.balance || 0),
          referenceId: withdrawal._id,
          referenceType: "withdrawal",
        }], { session });

        responseBody = {
          success: true,
          msg: "Withdrawal requested successfully",
          data: { withdrawal },
        };

        if (idempotencyKey) {
          await Withdrawal.updateOne(
            { _id: withdrawal._id },
            {
              $set: {
                idempotencyResponse: responseBody,
              },
            },
            { session }
          );
        }
      });

      console.log("USER ID:", req.user?._id);
      console.log("ACTION:", "withdrawal.create");
      console.log("WITHDRAW:", {
        userId: req.user._id,
        withdrawalId: withdrawal._id,
        amount: withdrawal.amount,
      });

      return res.json(responseBody);
    } catch (createErr) {
      if (createErr?.message === "WITHDRAWAL_DEDUCT_FAILED") {
        const refreshed = await User.findById(user._id).select("balance lastWithdrawalAt");
        const lastAt = refreshed?.lastWithdrawalAt
          ? new Date(refreshed.lastWithdrawalAt).getTime()
          : null;
        const remainingMs = lastAt ? cooldownMs - (Date.now() - lastAt) : 0;

        if (remainingMs > 0) {
          return res.status(400).json({
            success: false,
            msg: "Withdrawal cooldown active",
            data: null,
          });
        }

        return res.status(400).json({
          success: false,
          msg: "Insufficient balance",
          data: null,
        });
      }

      if (createErr?.code === 11000 && idempotencyKey) {
        const previous = await Withdrawal.findOne({
          userId: req.user._id,
          idempotencyKey,
        });

        if (previous?.idempotencyResponse) {
          return res.status(200).json(previous.idempotencyResponse);
        }

        if (previous) {
          return res.status(200).json({
            success: true,
            msg: "Duplicate request",
            data: previous,
          });
        }
      }

      throw createErr;
    }

  } catch (err) {
    logControllerError("withdrawal.create", req, err);
    res.status(500).json({ success: false, msg: "Internal server error", data: null });
  } finally {
    if (session) {
      session.endSession();
    }
  }
};


//
// 📄 USER WITHDRAWALS
//
export const getMyWithdrawals = async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find({ userId: req.user._id })
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      msg: "Withdrawals fetched successfully",
      data: { withdrawals },
    });

  } catch (err) {
    logControllerError("withdrawal.list", req, err);
    res.status(500).json({ success: false, msg: "Internal server error", data: null });
  }
};


//
// 🔥 ADMIN APPROVE
//
export const approveWithdrawal = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    return res.status(400).json({
      success: false,
      msg: "Legacy withdrawal processing is disabled. HybridEarn withdrawals are active.",
      data: null,
    });

    let withdrawal;

    await session.withTransaction(async () => {
      withdrawal = await Withdrawal.findOneAndUpdate(
        { _id: req.params.id, status: "pending" },
        { status: "approved", approvedAt: new Date() },
        { new: true, session }
      );

      if (!withdrawal) {
        return;
      }

      // 🔥 UPDATE TRANSACTION
      await Transaction.findOneAndUpdate(
        { type: "withdraw", refId: withdrawal._id },
        {
          user: withdrawal.userId,
          type: "withdraw",
          amount: withdrawal.amount,
          status: "approved",
          refId: withdrawal._id,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true, session }
      );

      await AuditLog.create([{
        adminId: req.user._id,
        action: "withdrawal.approve",
        targetId: withdrawal._id,
        targetType: "withdrawal",
      }], { session });
    });

    if (!withdrawal) {
      return res
        .status(400)
        .json({ success: false, msg: "Already processed or not found", data: null });
    }

    console.log("USER ID:", req.user?._id);
    console.log("ACTION:", "withdrawal.approve");
    console.log("WITHDRAW:", {
      adminId: req.user._id,
      withdrawalId: withdrawal._id,
    });

    res.json({
      success: true,
      msg: "Withdrawal approved successfully",
      data: { withdrawal },
    });

  } catch (err) {
    logControllerError("withdrawal.approve", req, err);
    res.status(500).json({ success: false, msg: "Internal server error", data: null });
  } finally {
    session.endSession();
  }
};


//
// ❌ ADMIN REJECT (SAFE REFUND)
//
export const rejectWithdrawal = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    return res.status(400).json({
      success: false,
      msg: "Legacy withdrawal processing is disabled. HybridEarn withdrawals are active.",
      data: null,
    });

    let withdrawal;

    await session.withTransaction(async () => {
      withdrawal = await Withdrawal.findOneAndUpdate(
        { _id: req.params.id, status: "pending" },
        { status: "rejected", rejectedAt: new Date() },
        { new: true, session }
      );

      if (!withdrawal) {
        return;
      }

      // 🔁 REFUND
      const updatedUser = await User.findOneAndUpdate(
        { _id: withdrawal.userId },
        {
          $inc: {
            balance: withdrawal.amount,
          },
          $set: {
            lastWithdrawalAt: null,
          },
        },
        { new: true, session }
      );

      if (!updatedUser) {
        throw new Error("User not found during withdrawal refund");
      }

      const balanceAfter = Number(updatedUser.balance || 0);
      const balanceBefore = balanceAfter - Number(withdrawal.amount || 0);

      await Ledger.create([{
        userId: withdrawal.userId,
        type: "credit",
        amount: withdrawal.amount,
        balanceBefore,
        balanceAfter,
        referenceId: withdrawal._id,
        referenceType: "withdrawal",
      }], { session });

      // 🔥 UPDATE TRANSACTION
      await Transaction.findOneAndUpdate(
        { type: "withdraw", refId: withdrawal._id },
        {
          user: withdrawal.userId,
          type: "withdraw",
          amount: withdrawal.amount,
          status: "rejected",
          refId: withdrawal._id,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true, session }
      );

      await AuditLog.create([{
        adminId: req.user._id,
        action: "withdrawal.reject",
        targetId: withdrawal._id,
        targetType: "withdrawal",
      }], { session });
    });

    if (!withdrawal) {
      return res
        .status(400)
        .json({ success: false, msg: "Already processed or not found", data: null });
    }

    console.log("USER ID:", req.user?._id);
    console.log("ACTION:", "withdrawal.reject");
    console.log("WITHDRAW:", {
      adminId: req.user._id,
      withdrawalId: withdrawal._id,
    });

    res.json({
      success: true,
      msg: "Withdrawal rejected and refunded successfully",
      data: { withdrawal },
    });

  } catch (err) {
    logControllerError("withdrawal.reject", req, err);
    res.status(500).json({ success: false, msg: "Internal server error", data: null });
  } finally {
    session.endSession();
  }
};