import "../src/config/loadEnv.js";
import connectDB, { gracefulDisconnectMongo } from "../src/config/db.js";
import User from "../src/models/User.js";
import Investment from "../src/models/Investment.js";
import HybridLedger from "../src/hybrid/models/HybridLedger.js";
import { runMongoTransaction } from "../src/config/mongoTransactions.js";
import { getClaimWindowStartUtc } from "../src/hybrid/utils/roiPktTime.js";
import logger from "../src/utils/logger.js";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const LIMIT = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] || 500);

const isValidDate = (value) => {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
};

const toDateOrNull = (value) => (isValidDate(value) ? new Date(value) : null);

async function latestRoiLedgerClaim(userId, session) {
  return HybridLedger.findOne({
    userId,
    source: "roi_claim",
    entryType: "credit",
  })
    .sort({ createdAt: -1, _id: -1 })
    .select("createdAt")
    .session(session)
    .lean();
}

async function legacyInvestmentSnapshot(userId, session) {
  const aggregate = Investment.aggregate([
    { $match: { userId } },
    {
      $group: {
        _id: "$userId",
        activeCount: {
          $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] },
        },
        staleActiveCount: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$status", "active"] },
                  { $lte: ["$endDate", new Date()] },
                ],
              },
              1,
              0,
            ],
          },
        },
        latestLastClaim: { $max: "$lastClaim" },
        activeAmount: {
          $sum: {
            $cond: [{ $eq: ["$status", "active"] }, "$amount", 0],
          },
        },
      },
    },
  ]);
  if (session) {
    aggregate.session(session);
  }
  const [snapshot] = await aggregate;

  return snapshot || {
    activeCount: 0,
    staleActiveCount: 0,
    latestLastClaim: null,
    activeAmount: 0,
  };
}

async function repairUser(userId) {
  return runMongoTransaction("scripts.roiEligibilityRepair.user", async (session) => {
    const user = await User.findById(userId)
      .select("level vipLevel depositBalance rewardBalance lastDailyClaim")
      .session(session);
    if (!user) return { userId: String(userId), skipped: "missing_user" };

    const now = new Date();
    const futureGrace = new Date(now.getTime() + 5 * 60_000);
    const claimWindowStart = getClaimWindowStartUtc(now);
    const investment = await legacyInvestmentSnapshot(user._id, session);
    const latestLedger = await latestRoiLedgerClaim(user._id, session);
    const latestLedgerClaimAt = toDateOrNull(latestLedger?.createdAt);
    const latestLegacyClaimAt = toDateOrNull(investment.latestLastClaim);
    const currentLastClaim = toDateOrNull(user.lastDailyClaim);

    const $set = {};
    const notes = [];

    if (user.lastDailyClaim && !currentLastClaim) {
      $set.lastDailyClaim = latestLedgerClaimAt || latestLegacyClaimAt || null;
      notes.push("invalid_lastDailyClaim_repaired");
    } else if (currentLastClaim && currentLastClaim > futureGrace) {
      $set.lastDailyClaim = latestLedgerClaimAt || latestLegacyClaimAt || null;
      notes.push("future_lastDailyClaim_repaired");
    } else if (
      !currentLastClaim &&
      latestLegacyClaimAt &&
      latestLegacyClaimAt >= claimWindowStart
    ) {
      $set.lastDailyClaim = latestLegacyClaimAt;
      notes.push("legacy_today_claim_anchor_restored");
    }

    const level = Number(user.level || 0);
    const vipLevel = Number(user.vipLevel || 0);
    const hasHybridBase =
      Number(user.depositBalance || 0) > 0 ||
      Number(user.rewardBalance || 0) > 0 ||
      Number(investment.activeAmount || 0) > 0;
    if (hasHybridBase && vipLevel > level) {
      $set.level = vipLevel;
      notes.push("level_restored_from_vipLevel");
    }

    let completedInvestments = 0;
    if (investment.staleActiveCount > 0) {
      const stale = await Investment.updateMany(
        {
          userId: user._id,
          status: "active",
          endDate: { $lte: now },
        },
        { $set: { status: "completed" } },
        { session },
      );
      completedInvestments = stale.modifiedCount || 0;
      notes.push("stale_legacy_investments_completed");
    }

    if (Object.keys($set).length > 0) {
      await User.updateOne({ _id: user._id }, { $set }, { session });
    }

    return {
      userId: String(user._id),
      changed: Object.keys($set).length > 0 || completedInvestments > 0,
      set: $set,
      completedInvestments,
      notes,
      snapshot: {
        currentLastClaim: currentLastClaim?.toISOString?.() || null,
        latestLedgerClaimAt: latestLedgerClaimAt?.toISOString?.() || null,
        latestLegacyClaimAt: latestLegacyClaimAt?.toISOString?.() || null,
        claimWindowStart: claimWindowStart.toISOString(),
        level,
        vipLevel,
        activeLegacyInvestments: investment.activeCount,
        staleActiveLegacyInvestments: investment.staleActiveCount,
      },
    };
  });
}

async function main() {
  await connectDB();

  const legacyUserIds = await Investment.distinct("userId", {
    $or: [
      { status: "active" },
      { lastClaim: { $exists: true, $ne: null } },
    ],
  });

  const userIds = await User.distinct("_id", {
    $or: [
      { _id: { $in: legacyUserIds } },
      { lastDailyClaim: { $exists: false } },
      { level: { $gt: 0 }, $or: [{ depositBalance: { $gt: 0 } }, { rewardBalance: { $gt: 0 } }] },
    ],
  });

  const limited = userIds.slice(0, Math.max(1, Number.isFinite(LIMIT) ? LIMIT : 500));
  logger.warn("ROI eligibility repair starting", {
    apply: APPLY,
    candidates: userIds.length,
    limited: limited.length,
  });

  const results = [];
  if (APPLY) {
    for (const userId of limited) {
      results.push(await repairUser(userId));
    }
  } else {
    for (const userId of limited) {
      const user = await User.findById(userId)
        .select("level vipLevel depositBalance rewardBalance lastDailyClaim")
        .lean();
      const investment = await legacyInvestmentSnapshot(userId, null);
      results.push({
        userId: String(userId),
        dryRun: true,
        user,
        investment,
      });
    }
  }

  const changed = results.filter((r) => r.changed).length;
  logger.warn("ROI eligibility repair finished", {
    apply: APPLY,
    scanned: results.length,
    changed,
  });
  console.log(JSON.stringify({ apply: APPLY, scanned: results.length, changed, results }, null, 2));
}

main()
  .catch((error) => {
    logger.error("ROI eligibility repair failed", { error: error?.message || String(error) });
    process.exitCode = 1;
  })
  .finally(async () => {
    await gracefulDisconnectMongo("roi eligibility repair");
  });
