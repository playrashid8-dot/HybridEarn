import express from "express";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import auth from "../middleware/auth.js";
import { getReadyRedis } from "../config/redis.js";
import User from "../models/User.js";
import HybridWithdrawal from "../hybrid/models/HybridWithdrawal.js";
import { getEffectiveRoiRate } from "../hybrid/services/roiService.js";
import {
  expireTrialIfNeeded,
  stripTrialFieldsFromClientUser,
} from "../hybrid/services/trialService.js";
import { requestWithdraw } from "../hybrid/controllers/withdrawController.js";
import { getSalaryProgress } from "../hybrid/controllers/salaryController.js";
import { buildSalaryProgressPayload } from "../hybrid/services/salaryService.js";
import { getHybridReferralIncomeBreakdown } from "../hybrid/services/firstDepositBonusService.js";

const sumPaidWithdrawalsGross = async (userId) => {
  const [row] = await HybridWithdrawal.aggregate([
    { $match: { userId, status: { $in: ["paid", "claimed"] } } },
    { $group: { _id: null, total: { $sum: "$grossAmount" } } },
  ]);
  return Number(row?.total || 0);
};

const router = express.Router();

/** Same shape as GET /referral-stats `data` (shared with /dashboard-summary). */
async function loadReferralStatsPayload(userId) {
  const [user, breakdown] = await Promise.all([
    User.findById(userId)
      .select("referralCode referralEarnings directCount teamCount teamVolume")
      .lean(),
    getHybridReferralIncomeBreakdown(userId),
  ]);

  if (!user) return null;

  return {
    referralCode: user.referralCode,
    referralEarnings: user.referralEarnings || 0,
    teamRoiIncome: Number(breakdown.teamRoiIncome || 0),
    firstDepositBonusEarned: Number(breakdown.firstDepositBonusEarned || 0),
    directCount: user.directCount || 0,
    teamCount: user.teamCount || 0,
    teamVolume: user.teamVolume || 0,
  };
}

/** Same shape as GET /team-members `data` (shared with /dashboard-summary). */
async function loadTeamMembersPayload(userId, queryPage, queryLimit) {
  const viewer = await User.findById(userId).select("isBlocked").lean();
  if (!viewer) {
    return { _error: "not_found" };
  }
  if (viewer.isBlocked) {
    return { _error: "blocked" };
  }

  const page = Math.max(1, Number.parseInt(String(queryPage || "1"), 10) || 1);
  const limit = Math.max(1, Math.min(Number(queryLimit) || 50, 50));
  const skip = (page - 1) * limit;

  const selectFields = "username createdAt depositBalance rewardBalance referredBy";
  const oid = userId instanceof mongoose.Types.ObjectId ? userId : new mongoose.Types.ObjectId(userId);

  const levelAIdsRaw = await User.find({ referredBy: oid }).select("_id").lean();
  const levelAIds = levelAIdsRaw.map((u) => u._id);

  let levelBIds = [];
  if (levelAIds.length > 0) {
    levelBIds = (
      await User.find({ referredBy: { $in: levelAIds } }).select("_id").lean()
    ).map((u) => u._id);
  }

  const tierOr = [{ referredBy: oid }];
  if (levelAIds.length) tierOr.push({ referredBy: { $in: levelAIds } });
  if (levelBIds.length) tierOr.push({ referredBy: { $in: levelBIds } });

  const listFilter = tierOr.length === 1 ? tierOr[0] : { $or: tierOr };

  const total = tierOr.length === 0 ? 0 : await User.countDocuments(listFilter);

  let tierRows = [];
  if (tierOr.length > 0) {
    tierRows = await User.find(listFilter)
      .select(selectFields)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();
  }

  const setA = new Set(levelAIds.map((id) => String(id)));

  const tierLabel = (referrerId) => {
    if (!referrerId) return "C";
    const r = referrerId instanceof mongoose.Types.ObjectId ? referrerId : new mongoose.Types.ObjectId(referrerId);
    const rs = String(r);
    const uidStr = String(oid);
    if (rs === uidStr) return "A";
    if (setA.has(rs)) return "B";
    return "C";
  };

  const members = tierRows.map((u) => ({
    id: String(u._id),
    username: u.username,
    level: tierLabel(u.referredBy),
    joinedAt: u.createdAt,
    balance: Number((u.depositBalance || 0) + (u.rewardBalance || 0)),
  }));

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return {
    members,
    page,
    limit,
    total,
    totalPages,
    hasMore: page < totalPages,
  };
}

function mapSalaryProgressForClient(data) {
  if (!data) return null;
  return {
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
  };
}

/* ==============================
   👤 GET CURRENT USER
============================== */
router.get("/me", auth, async (req, res) => {
  try {
    await expireTrialIfNeeded(req.user._id);

    const user = await User.findById(req.user._id).select("-password");

    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found", data: null });
    }

    if (user.isBlocked) {
      return res.status(403).json({ success: false, msg: "Account blocked", data: null });
    }

    const plain = user.toJSON ? user.toJSON() : user;
    const payload = stripTrialFieldsFromClientUser({ ...plain });

    res.json({
      success: true,
      msg: "User fetched",
      data: payload,
      user: payload,
    });

  } catch (err) {
    console.error("GET /me ERROR:", err.message);
    res.status(500).json({ success: false, msg: "Server error", data: null });
  }
});

router.post("/password", auth, async (req, res) => {
  try {
    let { currentPassword, newPassword } = req.body;
    currentPassword = currentPassword != null ? String(currentPassword) : "";
    newPassword = newPassword != null ? String(newPassword) : "";

    if (!currentPassword.trim() || !newPassword.trim()) {
      return res.status(400).json({
        success: false,
        msg: "Current password and new password are required",
        data: null,
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        msg: "New password must be at least 8 characters",
        data: null,
      });
    }

    const user = await User.findById(req.user._id).select("+password isBlocked");

    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found", data: null });
    }

    if (user.isBlocked) {
      return res.status(403).json({ success: false, msg: "Account blocked", data: null });
    }

    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) {
      return res.status(400).json({
        success: false,
        msg: "Current password is incorrect",
        data: null,
      });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    return res.json({ success: true, msg: "Password updated successfully", data: null });
  } catch (err) {
    console.error("POST /password ERROR:", err.message);
    return res.status(500).json({ success: false, msg: "Server error", data: null });
  }
});

/* ==============================
   📊 USER STATS (BASIC)
============================== */
router.get("/stats", auth, async (req, res) => {
  try {
    await expireTrialIfNeeded(req.user._id);

    const user = await User.findById(req.user._id)
      .select(
        "depositBalance rewardBalance pendingWithdraw referralEarnings todayProfit totalEarnings isBlocked level directCount teamCount",
      )
      .lean();

    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found", data: null });
    }

    if (user.isBlocked) {
      return res.status(403).json({ success: false, msg: "Account blocked", data: null });
    }

    const depositBalance = Number(user.depositBalance || 0);
    const rewardBalance = Number(user.rewardBalance || 0);
    const totalWithdrawPaid = await sumPaidWithdrawalsGross(user._id);
    const stats = {
      balance: depositBalance + rewardBalance,
      depositBalance,
      rewardBalance,
      pendingWithdraw: Number(user.pendingWithdraw || 0),
      totalInvested: depositBalance,
      totalWithdraw: totalWithdrawPaid,
      totalEarnings: Number(user.totalEarnings || 0),
      todayProfit: user.todayProfit,
      lastClaimProfit: user.todayProfit,
      vipLevel: user.level,
      level: Number(user.level || 0),
      roiRate: getEffectiveRoiRate(user),
      directCount: user.directCount,
      teamCount: user.teamCount,
    };

    res.json({
      success: true,
      msg: "Stats fetched",
      data: stats,
      stats,
    });

  } catch (err) {
    console.error("GET /stats ERROR:", err.message);
    res.status(500).json({ success: false, msg: "Server error", data: null });
  }
});

/* ==============================
   📈 ADVANCED DASHBOARD (COMBINED)
============================== */
router.get("/dashboard", auth, async (req, res) => {
  try {
    const userId = req.user._id;
    const redis = getReadyRedis();
    const cacheKey = `dashboard-user:${String(userId)}`;

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

    await expireTrialIfNeeded(userId);

    const user = await User.findById(userId)
      .select(
        "depositBalance rewardBalance pendingWithdraw referralEarnings todayProfit totalEarnings level directCount teamCount isBlocked",
      )
      .lean();

    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found", data: null });
    }

    if (user.isBlocked) {
      return res.status(403).json({ success: false, msg: "Account blocked", data: null });
    }

    const depositBalance = Number(user.depositBalance || 0);
    const rewardBalance = Number(user.rewardBalance || 0);
    const totalWithdrawPaid = await sumPaidWithdrawalsGross(userId);
    const dashboard = {
      balance: depositBalance + rewardBalance,
      depositBalance,
      rewardBalance,
      pendingWithdraw: Number(user.pendingWithdraw || 0),
      todayProfit: user.todayProfit,
      lastClaimProfit: user.todayProfit,
      totalEarned: rewardBalance,
      totalEarnings: Number(user.totalEarnings || 0),
      totalWithdraw: totalWithdrawPaid,

      totalInvested: depositBalance,
      investmentProfit: 0,

      activePlans: 0,
      directCount: user.directCount,
      teamCount: user.teamCount,
      vipLevel: user.level,
      level: Number(user.level || 0),
      roiRate: getEffectiveRoiRate(user),
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

/* ==============================
   👥 TEAM MEMBERS (READ — referral tree A / B / C)
============================== */
router.get("/team-members", auth, async (req, res) => {
  try {
    const redis = getReadyRedis();
    const userId = req.user._id;
    const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 50));
    const cacheKey = `team-members:${String(userId)}:${page}:${limit}`;

    if (redis) {
      try {
        const raw = await redis.get(cacheKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          const { members, page: pg, limit: lm, total, totalPages, hasMore } = parsed;
          return res.json({
            success: true,
            msg: "Team members loaded",
            data: {
              members,
              page: pg,
              limit: lm,
              total,
              totalPages,
              hasMore,
            },
          });
        }
      } catch {
        /* fall through */
      }
    }

    const payload = await loadTeamMembersPayload(userId, req.query.page, req.query.limit);
    if (payload?._error === "not_found") {
      return res.status(404).json({ success: false, msg: "User not found", data: null });
    }
    if (payload?._error === "blocked") {
      return res.status(403).json({ success: false, msg: "Account blocked", data: null });
    }
    const { members, page: pageNum, limit: limitNum, total, totalPages, hasMore } = payload;

    const body = {
      members,
      page: pageNum,
      limit: limitNum,
      total,
      totalPages,
      hasMore,
    };

    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(body), "EX", 10);
      } catch {
        /* ignore */
      }
    }

    return res.json({
      success: true,
      msg: "Team members loaded",
      data: body,
    });
  } catch (err) {
    console.error("Team members error:", err);
    return res.status(500).json({ success: false, msg: "Failed to load team", data: null });
  }
});

/* ==============================
   👥 REFERRAL STATS
============================== */
router.get("/referral-stats", auth, async (req, res) => {
  try {
    const redis = getReadyRedis();
    const userId = String(req.user._id);
    const cacheKey = `referral-stats:${userId}`;

    if (redis) {
      try {
        const raw = await redis.get(cacheKey);
        if (raw) {
          const stats = JSON.parse(raw);
          return res.json({
            success: true,
            msg: "Stats fetched",
            data: stats,
            stats,
          });
        }
      } catch {
        /* fall through */
      }
    }

    const stats = await loadReferralStatsPayload(req.user._id);

    if (!stats) {
      return res.status(404).json({ success: false, msg: "User not found", data: null });
    }

    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(stats), "EX", 10);
      } catch {
        /* ignore */
      }
    }

    res.json({
      success: true,
      msg: "Stats fetched",
      data: stats,
      stats,
    });
  } catch (err) {
    console.error("GET /referral-stats ERROR:", err.message);
    res.status(500).json({ success: false, msg: "Server error", data: null });
  }
});

router.get("/dashboard-summary", auth, async (req, res) => {
  try {
    await expireTrialIfNeeded(req.user._id);
    const redis = getReadyRedis();
    const userId = String(req.user._id);
    const cacheKey = `dashboard:${userId}`;

    let cached = null;
    if (redis) {
      try {
        cached = await redis.get(cacheKey);
      } catch {}
    }
    if (cached) {
      try {
        const data = JSON.parse(cached);
        return res.json({
          success: true,
          msg: "Dashboard summary loaded",
          data,
        });
      } catch {
        /* stale cache — fall through */
      }
    }

    const [referralStats, teamPayload, salPayload] = await Promise.all([
      loadReferralStatsPayload(req.user._id),
      loadTeamMembersPayload(req.user._id, 1, 50),
      buildSalaryProgressPayload(req.user._id),
    ]);

    if (!referralStats) {
      return res.status(404).json({ success: false, msg: "User not found", data: null });
    }

    if (teamPayload?._error === "not_found") {
      return res.status(404).json({ success: false, msg: "User not found", data: null });
    }
    if (teamPayload?._error === "blocked") {
      return res.status(403).json({ success: false, msg: "Account blocked", data: null });
    }

    if (!salPayload) {
      return res.status(404).json({ success: false, msg: "User not found", data: null });
    }

    const { members, page, limit, total, totalPages, hasMore } = teamPayload;
    const teamMembersData = {
      members,
      page,
      limit,
      total,
      totalPages,
      hasMore,
    };

    const salaryProgress = mapSalaryProgressForClient(salPayload);

    const data = {
      referralStats,
      teamMembers: teamMembersData,
      salaryProgress,
    };

    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(data), "EX", 10);
      } catch {}
    }

    return res.json({
      success: true,
      msg: "Dashboard summary loaded",
      data,
    });
  } catch (err) {
    console.error("GET /dashboard-summary ERROR:", err.message);
    return res.status(500).json({ success: false, msg: "Server error", data: null });
  }
});

router.get("/salary-progress", auth, getSalaryProgress);

/* ==============================
   💸 HYBRID WITHDRAW — POST /api/user/withdraw only
============================== */
router.post("/withdraw", auth, requestWithdraw);

export default router;