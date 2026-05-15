import express from "express";
import mongoose from "mongoose";
import auth from "../middleware/auth.js";
import { getReadyRedis } from "../config/redis.js";
import User from "../models/User.js";
import HybridDeposit from "../hybrid/models/HybridDeposit.js";
import HybridWithdrawal from "../hybrid/models/HybridWithdrawal.js";
import { getCurrentRoiRate } from "../hybrid/services/roiService.js";

const router = express.Router();

/* ==============================
   📊 MAIN DASHBOARD DATA
============================== */
router.get("/", auth, async (req, res) => {
  try {
    const userId = req.user._id;
    const oid = userId instanceof mongoose.Types.ObjectId ? userId : new mongoose.Types.ObjectId(userId);
    const redis = getReadyRedis();
    const cacheKey = `dashboard-route:${String(userId)}`;

    if (redis) {
      try {
        const raw = await redis.get(cacheKey);
        if (raw) {
          const dashboard = JSON.parse(raw);
          return res.json({
            success: true,
            msg: "Dashboard data",
            data: dashboard,
            dashboard,
          });
        }
      } catch {
        /* fall through */
      }
    }

    const user = await User.findById(userId)
      .select(
        "depositBalance rewardBalance pendingWithdraw todayProfit level referralEarnings teamCount",
      )
      .lean();

    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found", data: null });
    }

    const [depAgg] = await HybridDeposit.aggregate([
      {
        $match: {
          userId: oid,
          status: { $in: ["credited", "swept"] },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const totalDeposited = Number(depAgg?.total || 0);

    const [wdAgg] = await HybridWithdrawal.aggregate([
      {
        $match: {
          userId: oid,
          status: { $in: ["paid", "claimed"] },
        },
      },
      { $group: { _id: null, total: { $sum: "$grossAmount" } } },
    ]);
    const totalWithdrawn = Number(wdAgg?.total || 0);

    const directCount = await User.countDocuments({ referredBy: oid });

    const depositBalance = Number(user.depositBalance || 0);
    const rewardBalance = Number(user.rewardBalance || 0);
    const hybridBalance = depositBalance + rewardBalance;

    const dashboard = {
      balance: hybridBalance,
      depositBalance,
      rewardBalance,
      pendingWithdraw: Number(user.pendingWithdraw || 0),
      todayProfit: Number(user.todayProfit || 0),
      lastClaimProfit: Number(user.todayProfit || 0),

      totalInvested: depositBalance,
      totalEarned: rewardBalance,
      totalDeposited,
      totalWithdrawn,

      activePlans: 0,
      directCount,
      teamCount: Number(user.teamCount || 0),

      referralIncome: Number(user.referralEarnings || 0),
      vipLevel: user.level,
      level: Number(user.level || 0),
      roiRate: getCurrentRoiRate(user.level),
    };

    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(dashboard), "EX", 10);
      } catch {
        /* ignore */
      }
    }

    res.json({
      success: true,
      msg: "Dashboard data",
      data: dashboard,
      dashboard,
    });

  } catch (err) {
    console.error("DASHBOARD ERROR:", err.message);
    res.status(500).json({ success: false, msg: "Server error", data: null });
  }
});

export default router;