import Deposit from "../models/Deposit.js";
import User from "../models/User.js";
import Transaction from "../models/Transaction.js";
import Ledger from "../models/Ledger.js";
import AuditLog from "../models/AuditLog.js";
import { distributeReferralIncome } from "../utils/referral.js";
import mongoose from "mongoose";

const getIdempotencyKey = (req) => req.get("Idempotency-Key")?.trim() || null;

const sendIdempotencyResponse = (res, record) => {
  if (!record) return false;

  if (record.idempotencyResponse?.body) {
    res
      .status(record.idempotencyResponse.statusCode || 200)
      .json(record.idempotencyResponse.body);
    return true;
  }

  res.json({
    success: true,
    msg: "Deposit submitted successfully",
    data: { deposit: record },
  });

  return true;
};

const logControllerError = (action, req, err) => {
  console.log("USER:", req.user?._id);
  console.log("ACTION:", action);
  console.log("ERROR:", err.message);
};

//
// 🔥 CREATE DEPOSIT (USER)
//
export const createDeposit = async (req, res) => {
  try {
    return res.status(400).json({
      success: false,
      msg: "Manual legacy deposits are disabled. Send USDT to your HybridEarn wallet.",
      data: null,
    });

    let { amount, txHash } = req.body;
    const idempotencyKey = getIdempotencyKey(req);

    // 🔧 NORMALIZE
    amount = Number(amount);
    txHash = txHash?.trim().toLowerCase();

    if (!req.user?._id) {
      return res.status(401).json({ success: false, msg: "Unauthorized user" });
    }

    // ✅ VALIDATION (STRONG)
    if (!Number.isFinite(amount) || amount <= 0) {
      return res
        .status(400)
        .json({ success: false, msg: "Amount must be a number greater than 0" });
    }

    if (!txHash) {
      return res
        .status(400)
        .json({ success: false, msg: "Transaction hash is required" });
    }

    if (idempotencyKey) {
      const previous = await Deposit.findOne({
        userId: req.user._id,
        idempotencyKey,
      });

      if (previous) {
        if (previous.txHash !== txHash) {
          return res.status(409).json({
            success: false,
            msg: "Idempotency key already used for another deposit",
          });
        }

        if (sendIdempotencyResponse(res, previous)) return;
      }
    }

    const duplicateTx = await Deposit.findOne({ txHash });

    if (duplicateTx) {
      return res
        .status(409)
        .json({ success: false, msg: "Transaction hash already used" });
    }

    // 🔥 CREATE DEPOSIT
    let deposit;
    try {
      deposit = await Deposit.create({
        userId: req.user._id,
        amount,
        txHash,
        status: "pending",
        idempotencyKey,
      });
    } catch (createErr) {
      if (createErr?.code === 11000) {
        if (idempotencyKey) {
          const previous = await Deposit.findOne({
            userId: req.user._id,
            idempotencyKey,
          });

          if (previous) {
            if (previous.txHash === txHash && sendIdempotencyResponse(res, previous)) return;

            return res.status(409).json({
              success: false,
              msg: "Idempotency key already used for another deposit",
            });
          }
        }

        return res
          .status(409)
          .json({ success: false, msg: "Transaction hash already used" });
      }
      throw createErr;
    }

    // 🔥 CREATE TRANSACTION (SAFE - NO DUPLICATE)
    await Transaction.findOneAndUpdate(
      { type: "deposit", refId: deposit._id },
      {
        user: req.user._id,
        type: "deposit",
        amount,
        status: "pending",
        refId: deposit._id,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const responseBody = {
      success: true,
      msg: "Deposit submitted successfully",
      data: { deposit },
    };

    if (idempotencyKey) {
      await Deposit.updateOne(
        { _id: deposit._id },
        { $set: { idempotencyResponse: { statusCode: 200, body: responseBody } } }
      );
    }

    console.log("USER:", req.user);
    console.log("ACTION:", "deposit.create");
    console.log("DEPOSIT:", {
      userId: req.user._id,
      depositId: deposit._id,
      amount: deposit.amount,
    });

    res.json(responseBody);

  } catch (err) {
    console.log("ERROR:", err.message);
    logControllerError("deposit.create", req, err);
    res.status(500).json({ success: false, msg: "Internal server error", data: null });
  }
};


//
// 🔥 ADMIN APPROVE DEPOSIT
//
export const approveDeposit = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    return res.status(400).json({
      success: false,
      msg: "Manual legacy deposit approval is disabled. HybridEarn listener credits deposits automatically.",
      data: null,
    });

    let deposit;

    // 🔒 ATOMIC UPDATE (avoid double approve)
    await session.withTransaction(async () => {
      deposit = await Deposit.findOneAndUpdate(
        { _id: req.params.id, status: "pending" },
        { status: "approved", approvedAt: new Date() },
        { new: true, session }
      );

      if (!deposit) {
        return;
      }

      // 🔍 USER
      const user = await User.findById(deposit.userId).session(session);

      if (!user) {
        throw new Error("User not found");
      }

      if (user.isBlocked) {
        throw new Error("User is blocked");
      }

      // 🔥 SAFE BALANCE UPDATE
      const updatedUser = await User.findOneAndUpdate(
        { _id: user._id, isBlocked: { $ne: true } },
        {
          $inc: {
            balance: deposit.amount,
            totalInvested: deposit.amount,
          },
        },
        { new: true, session }
      );

      if (!updatedUser) {
        throw new Error("User not found or blocked during approval");
      }

      const balanceAfter = Number(updatedUser.balance || 0);
      const balanceBefore = balanceAfter - Number(deposit.amount || 0);

      await Ledger.create([{
        userId: user._id,
        type: "credit",
        amount: deposit.amount,
        balanceBefore,
        balanceAfter,
        referenceId: deposit._id,
        referenceType: "deposit",
      }], { session });

      // 🔥 UPDATE TRANSACTION (SAFE)
      await Transaction.findOneAndUpdate(
        { type: "deposit", refId: deposit._id },
        {
          user: deposit.userId,
          type: "deposit",
          amount: deposit.amount,
          status: "approved",
          refId: deposit._id,
        },
        { new: true, upsert: true, setDefaultsOnInsert: true, session }
      );

      await AuditLog.create([{
        adminId: req.user._id,
        action: "deposit.approve",
        targetId: deposit._id,
        targetType: "deposit",
      }], { session });
    });

    if (!deposit) {
      return res
        .status(400)
        .json({ success: false, msg: "Already processed or not found" });
    }

    // 🔥 REFERRAL DISTRIBUTION
    await distributeReferralIncome(deposit.userId, deposit.amount);

    console.log("USER:", req.user);
    console.log("ACTION:", "deposit.approve");
    console.log("DEPOSIT:", {
      adminId: req.user._id,
      depositId: deposit._id,
    });

    res.json({
      success: true,
      msg: "Deposit approved successfully",
      data: { deposit },
    });

  } catch (err) {
    logControllerError("deposit.approve", req, err);
    res.status(500).json({ success: false, msg: "Internal server error", data: null });
  } finally {
    session.endSession();
  }
};


//
// ❌ ADMIN REJECT DEPOSIT
//
export const rejectDeposit = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    let deposit;

    await session.withTransaction(async () => {
      deposit = await Deposit.findOneAndUpdate(
        { _id: req.params.id, status: "pending" },
        { status: "rejected", rejectedAt: new Date() },
        { new: true, session }
      );

      if (!deposit) {
        return;
      }

      // 🔥 UPDATE TRANSACTION (SAFE)
      await Transaction.findOneAndUpdate(
        { type: "deposit", refId: deposit._id },
        {
          user: deposit.userId,
          type: "deposit",
          amount: deposit.amount,
          status: "rejected",
          refId: deposit._id,
        },
        { new: true, upsert: true, setDefaultsOnInsert: true, session }
      );

      await AuditLog.create([{
        adminId: req.user._id,
        action: "deposit.reject",
        targetId: deposit._id,
        targetType: "deposit",
      }], { session });
    });

    if (!deposit) {
      return res
        .status(400)
        .json({ success: false, msg: "Already processed or not found" });
    }

    console.log("USER:", req.user);
    console.log("ACTION:", "deposit.reject");
    console.log("DEPOSIT:", {
      adminId: req.user._id,
      depositId: deposit._id,
    });

    res.json({
      success: true,
      msg: "Deposit rejected successfully",
      data: { deposit },
    });

  } catch (err) {
    logControllerError("deposit.reject", req, err);
    res.status(500).json({ success: false, msg: "Internal server error", data: null });
  } finally {
    session.endSession();
  }
};


//
// 📜 GET USER DEPOSITS
//
export const getMyDeposits = async (req, res) => {
  try {
    const deposits = await Deposit.find({ userId: req.user._id })
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      msg: "Deposits fetched successfully",
      data: { deposits },
    });

  } catch (err) {
    logControllerError("deposit.list", req, err);
    res.status(500).json({ success: false, msg: "Internal server error", data: null });
  }
};