import express from "express";
import User from "../models/User.js";
import HybridDeposit from "../hybrid/models/HybridDeposit.js";
import HybridWithdrawal from "../hybrid/models/HybridWithdrawal.js";

const router = express.Router();

const creditedDepositStatuses = ["credited", "swept"];

async function getRealPublicTotals() {
  const [realUsers, depAgg, wdAgg] = await Promise.all([
    User.countDocuments(),
    HybridDeposit.aggregate([
      { $match: { status: { $in: creditedDepositStatuses } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    HybridWithdrawal.aggregate([
      { $match: { status: "paid" } },
      { $group: { _id: null, total: { $sum: "$netAmount" } } },
    ]),
  ]);

  const realTotalDeposits = depAgg[0]?.total ?? 0;
  const realTotalWithdrawn = wdAgg[0]?.total ?? 0;

  return {
    users: realUsers,
    totalDeposits: realTotalDeposits,
    totalWithdrawn: realTotalWithdrawn,
  };
}

function applyDisplayGrowthBoost(users, totalDeposits, totalWithdrawn) {
  const boostEnabled = process.env.GROWTH_BOOST_ENABLED === "true";
  if (!boostEnabled) {
    return { users, totalDeposits, totalWithdrawn };
  }

  const createdAt = new Date(process.env.APP_LAUNCH_DATE ?? "");
  if (Number.isNaN(createdAt.getTime())) {
    return { users, totalDeposits, totalWithdrawn };
  }

  const now = new Date();
  const hoursPassed = Math.max(
    0,
    Math.floor((now - createdAt) / (1000 * 60 * 60))
  );

  const growthFactor = 1 + hoursPassed * 0.03;

  return {
    users: Math.floor(users * growthFactor),
    totalDeposits: Math.floor(totalDeposits * growthFactor * 1.2),
    totalWithdrawn: Math.floor(totalWithdrawn * growthFactor * 0.9),
  };
}

async function buildDisplayedPublicStats() {
  const { users, totalDeposits, totalWithdrawn } = await getRealPublicTotals();
  const boosted = applyDisplayGrowthBoost(users, totalDeposits, totalWithdrawn);
  return {
    totalUsers: boosted.users,
    totalDeposits: boosted.totalDeposits,
    totalWithdrawals: boosted.totalWithdrawn,
  };
}

async function respondPublicStats(_req, res, logLabel) {
  try {
    const stats = await buildDisplayedPublicStats();

    res.json({
      success: true,
      msg: "Platform stats",
      data: { stats },
      stats,
    });
  } catch (err) {
    console.error(`${logLabel}:`, err?.message || String(err));
    res.status(500).json({
      success: false,
      msg: "Could not load platform stats",
      data: null,
    });
  }
}

router.get("/stats", (req, res) => respondPublicStats(req, res, "GET /public/stats"));

router.get("/platform-stats", (req, res) =>
  respondPublicStats(req, res, "GET /public/platform-stats")
);

export default router;
