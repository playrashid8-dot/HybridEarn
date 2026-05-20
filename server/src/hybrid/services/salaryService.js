import mongoose from "mongoose";
import User from "../../models/User.js";
import {
  SALARY_RULES,
  MAX_SALARY_STAGE,
  nextSalaryStageAfterClaim,
  SALARY_ACTIVE_INVESTOR_MIN_USDT,
  SALARY_BFS_FRONTIER_CHUNK,
  SALARY_BFS_MAX_WAVES,
  SALARY_BFS_MAX_QUALIFYING_NODES,
  SALARY_BFS_YIELD_EVERY_WAVES,
  SALARY_BFS_YIELD_MIN_FRONTIER,
  SALARY_COUNT_CACHE_TTL_SEC,
  SALARY_COUNT_CACHE_KEY_PREFIX,
} from "../utils/constants.js";
import { addHybridLedgerEntries } from "./ledgerService.js";
import { getReadyRedis } from "../../config/redis.js";
import logger from "../../utils/logger.js";
import { bumpClaimSalary } from "../utils/payoutObservability.js";
import { runMongoTransaction } from "../../config/mongoTransactions.js";

const FRONTIER_IN_CHUNK = SALARY_BFS_FRONTIER_CHUNK;

const salaryCountCacheKey = (userId) => {
  const id =
    userId instanceof mongoose.Types.ObjectId
      ? userId.toString()
      : String(userId ?? "");
  return `${SALARY_COUNT_CACHE_KEY_PREFIX}${id}`;
};

const yieldEventLoop = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** Optional Redis-backed cache for computed fresh counts (TTL from constants). */
const tryGetSalaryCountCache = async (userId) => {
  let raw = null;
  const redis = getReadyRedis();
  if (redis) {
    try {
      raw = await redis.get(salaryCountCacheKey(userId));
    } catch {
      return null;
    }
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const direct = Number(parsed?.direct);
    const team = Number(parsed?.team);
    if (!Number.isFinite(direct) || !Number.isFinite(team)) return null;
    return { direct, team };
  } catch {
    return null;
  }
};

const trySetSalaryCountCache = async (userId, direct, team) => {
  const redis = getReadyRedis();
  if (redis) {
    try {
      await redis.set(
        salaryCountCacheKey(userId),
        JSON.stringify({ direct, team }),
        "EX",
        SALARY_COUNT_CACHE_TTL_SEC
      );
    } catch {
      /* optional boost — Redis optional */
    }
  }
};

export async function invalidateSalaryCountCache(userId) {
  const redis = getReadyRedis();
  if (redis) {
    try {
      await redis.del(salaryCountCacheKey(userId));
    } catch {
      /* ignore */
    }
  }
}

/** Walk sponsor chain and drop cached GET counts so deposit-driven “active” team changes reflect quickly. */
export async function invalidateSalaryCountCacheForUplineOfUser(userId) {
  const maxHops = 128;
  let current = userId;
  const seen = new Set();

  for (let hop = 0; hop < maxHops; hop += 1) {
    const row = await User.findById(current).select("referredBy").lean();
    const parentId = row?.referredBy;
    if (!parentId) break;

    const ps = parentId.toString();
    if (seen.has(ps)) break;
    seen.add(ps);

    await invalidateSalaryCountCache(parentId);
    current = parentId;
  }
}

/**
 * Recursive fresh-downline count matching former $graphLookup + restrictSearchWithMatch
 * semantics, without loading the entire subtree into Mongoose BSON memory (<graphLookup>.
 * Only nodes matching freshness participate; wave BFS from root excludes root from tally.
 *
 * Hardening: global visited set (cycles / duplicate edges / corrupted graphs), self-referral
 * exclusion, single max-wave cap (no undercount on deep trees from mismatched limits).
 */
export const countFreshTeam = async (rootId, lastClaimDate, session = null) => {
  const oid =
    rootId instanceof mongoose.Types.ObjectId
      ? rootId
      : new mongoose.Types.ObjectId(rootId);

  const freshness =
    lastClaimDate instanceof Date && !Number.isNaN(lastClaimDate.getTime())
      ? { createdAt: { $gt: lastClaimDate } }
      : {};

  let frontier = [oid];
  let total = 0;

  const visited = new Set([oid.toString()]);

  const activeMin = SALARY_ACTIVE_INVESTOR_MIN_USDT;

  waveLoop: for (let wave = 0; wave < SALARY_BFS_MAX_WAVES && frontier.length > 0; wave += 1) {
    if (
      wave > 0 &&
      wave % SALARY_BFS_YIELD_EVERY_WAVES === 0 &&
      frontier.length >= SALARY_BFS_YIELD_MIN_FRONTIER
    ) {
      await yieldEventLoop();
    }

    const next = [];

    for (let i = 0; i < frontier.length; i += FRONTIER_IN_CHUNK) {
      const chunk = frontier.slice(i, i + FRONTIER_IN_CHUNK);
      const finder = User.find({
        referredBy: { $in: chunk },
        _id: { $ne: oid },
        ...freshness,
        depositBalance: { $gte: activeMin },
        $expr: { $ne: ["$_id", "$referredBy"] },
      })
        .select("_id depositBalance")
        .lean();

      if (session) finder.session(session);
      const rows = await finder.exec();

      for (const userRow of rows) {
        const idStr =
          userRow?._id != null ? userRow._id.toString() : "";
        if (!idStr || visited.has(idStr)) {
          continue;
        }
        if (Number(userRow?.depositBalance ?? 0) < activeMin) {
          continue;
        }
        visited.add(idStr);
        total += 1;
        next.push(userRow._id);
        if (total > SALARY_BFS_MAX_QUALIFYING_NODES) {
          break waveLoop;
        }
      }
    }

    frontier = next;
  }

  if (!Number.isFinite(total)) {
    throw new Error("Invalid team count");
  }
  return total;
};

/**
 * Migrates legacy `claimedSalaryStages` into salaryProgress once.
 * Sets lastClaimedAt when inferring stages so onwards only fresh recruits count for the next claim.
 */
export const migrateSalaryProgressFields = async (userId, session = null) => {
  let user = await User.findById(userId)
    .select("salaryProgress claimedSalaryStages rewardBalance totalEarnings salaryStage salaryHistory")
    .session(session ?? undefined);

  if (!user) return null;

  const claimedLegacy = [...(user.claimedSalaryStages ?? [])]
    .map(Number)
    .filter((n) => Number.isFinite(n));
  let lastClaimedStage = Number(user.salaryProgress?.lastClaimedStage ?? 0);
  let lastClaimedAtRaw = user.salaryProgress?.lastClaimedAt ?? null;

  const maxLegacy = claimedLegacy.length ? Math.max(...claimedLegacy, 0) : 0;
  const needsMigrateFromLegacy = lastClaimedStage === 0 && maxLegacy > 0;

  if (needsMigrateFromLegacy) {
    lastClaimedStage = maxLegacy;
    const lastClaimedAt =
      lastClaimedAtRaw != null ? new Date(lastClaimedAtRaw) : new Date();

    await User.updateOne(
      { _id: userId },
      {
        $set: {
          "salaryProgress.lastClaimedStage": lastClaimedStage,
          "salaryProgress.lastClaimedAt": lastClaimedAt,
          salaryStage: lastClaimedStage,
        },
      },
      { session: session ?? undefined }
    );

    user = await User.findById(userId)
      .select("salaryProgress claimedSalaryStages rewardBalance totalEarnings salaryStage salaryHistory")
      .session(session ?? undefined);
  }

  return user;
};

/** Fresh recruits only — resets after last salary claim timestamp */
export const getFreshCounts = async (user, session = null) => {
  const lastClaimRaw = user.salaryProgress?.lastClaimedAt;
  let lastClaim = null;

  if (lastClaimRaw != null) {
    const d =
      lastClaimRaw instanceof Date
        ? lastClaimRaw
        : new Date(lastClaimRaw);

    lastClaim = !Number.isNaN(d.getTime()) ? d : null;
  }

  const filter = lastClaim ? { createdAt: { $gt: lastClaim } } : {};

  const cached =
    session == null ? await tryGetSalaryCountCache(user._id) : null;
  if (cached) {
    return cached;
  }

  const activeMin = SALARY_ACTIVE_INVESTOR_MIN_USDT;

  let directQ = User.countDocuments({
    referredBy: user._id,
    _id: { $ne: user._id },
    depositBalance: { $gte: activeMin },
    $expr: { $ne: ["$_id", "$referredBy"] },
    ...filter,
  });
  if (session != null) {
    directQ = directQ.session(session);
  }
  const direct = await directQ;
  if (!Number.isFinite(direct)) {
    throw new Error("Invalid direct count");
  }

  const team = await countFreshTeam(user._id, lastClaim ?? undefined, session);
  if (!Number.isFinite(team)) {
    throw new Error("Invalid team count");
  }

  if (session == null) {
    await trySetSalaryCountCache(user._id, direct, team);
  }

  return { direct, team };
};

const ruleByStage = (stageNum) =>
  SALARY_RULES.find((r) => Number(r.stage) === Number(stageNum)) ?? null;

/** Mongo filter for anchored lastClaimedAt (prevents claim races / mismatched freshness window). */
const anchorLastClaimedAtCondition = (raw) => {
  if (
    raw != null &&
    (raw instanceof Date || typeof raw === "string" || typeof raw === "number")
  ) {
    const asDate =
      raw instanceof Date ? raw : new Date(raw);
    if (!Number.isNaN(asDate.getTime())) {
      return { "salaryProgress.lastClaimedAt": asDate };
    }
  }
  return {
    $or: [
      { "salaryProgress.lastClaimedAt": { $exists: false } },
      { "salaryProgress.lastClaimedAt": null },
    ],
  };
};

const isTransientTxnError = (err) => {
  const labels = err?.errorLabels;
  if (labels instanceof Set && labels.has("TransientTransactionError")) {
    return true;
  }
  if (Array.isArray(labels) && labels.includes("TransientTransactionError")) {
    return true;
  }
  if (labels instanceof Set && labels.has("UnknownTransactionCommitResult")) {
    return true;
  }
  if (Array.isArray(labels) && labels.includes("UnknownTransactionCommitResult")) {
    return true;
  }
  const msg = String(err?.message || "").toLowerCase();
  return (
    msg.includes("transienttransactionerror") ||
    msg.includes("has been aborted")
  );
};

/**
 * Builds GET /api/user/salary-progress payload.
 */
export const buildSalaryProgressPayload = async (userId) => {
  const migrated = await migrateSalaryProgressFields(userId);
  if (!migrated) return null;

  const maxStageNum = MAX_SALARY_STAGE;

  let lastClaimedStage = Number(migrated.salaryProgress?.lastClaimedStage ?? 0);
  lastClaimedStage = Math.min(lastClaimedStage, maxStageNum);

  const { direct, team } = await getFreshCounts(migrated, null);

  const complete = lastClaimedStage >= maxStageNum;

  /** Milestone you're working toward (next claim); when finished, repeats last rule index for convenience */
  const nextStageNum = complete ? maxStageNum : nextSalaryStageAfterClaim(lastClaimedStage);
  const rule = ruleByStage(nextStageNum);

  const eligible =
    !complete &&
    rule &&
    direct >= Number(rule.directCount ?? 0) &&
    team >= Number(rule.teamCount ?? 0);

  const historyRaw = Array.isArray(migrated.salaryHistory) ? migrated.salaryHistory : [];

  const salaryHistory = [...historyRaw]
    .slice(-20)
    .map((h) => ({
      stage: Number(h.stage),
      amount: Number(h.amount ?? 0),
      claimedAt: h.claimedAt != null ? h.claimedAt : null,
    }))
    .sort((a, b) => {
      const ta = new Date(a.claimedAt || 0).getTime();
      const tb = new Date(b.claimedAt || 0).getTime();
      return tb - ta;
    });

  const claimableStageNum = eligible ? nextStageNum : 0;

  logger.debug?.("Hybrid salary milestone GET snapshot", {
    userId: String(userId),
    direct,
    team,
    stage: claimableStageNum,
  });

  return {
    stage: complete ? maxStageNum : nextStageNum,
    direct,
    team,
    claimableStage: claimableStageNum,
    lastClaimedStage,
    lastClaimedAt: migrated.salaryProgress?.lastClaimedAt ?? null,
    salaryComplete: complete,
    claimedSalaryStages: [...(migrated.claimedSalaryStages ?? [])].map(Number),
    rules: SALARY_RULES,
    salaryHistory,
  };
};

export const claimSalary = async (userId) => {
  const MAX_ATTEMPTS = 3;
  let lastErr = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await runMongoTransaction("hybrid.salary.claim", async (session) => {
          let user = await migrateSalaryProgressFields(userId, session);
          if (!user) {
            throw new Error("User not found");
          }

          const maxStageNum = MAX_SALARY_STAGE;
          let prevStage = Number(user.salaryProgress?.lastClaimedStage ?? 0);
          prevStage = Math.min(prevStage, maxStageNum);

          if (prevStage >= maxStageNum) {
            throw new Error("All salary stages claimed");
          }

          const nextStage = nextSalaryStageAfterClaim(prevStage);
          const rule = ruleByStage(nextStage);

          if (!rule || rule.stage !== nextStage) {
            throw new Error("Invalid salary stage");
          }

          const rewardAmount = Number(rule.amount);
          if (!Number.isFinite(rewardAmount) || rewardAmount <= 0) {
            throw new Error("Invalid salary reward configuration");
          }

          const lastClaimedAtSnapshot = user.salaryProgress?.lastClaimedAt;

          const { direct, team } = await getFreshCounts(user, session);

          if (
            direct < Number(rule.directCount) ||
            team < Number(rule.teamCount)
          ) {
            throw new Error("Salary stage not reached");
          }

          /** Single atomic instant for persisted claim boundary (fixes split-ms exploit). */
          const now = new Date();

          const stageMatch =
            prevStage === 0
              ? {
                  $or: [
                    { "salaryProgress.lastClaimedStage": 0 },
                    { "salaryProgress.lastClaimedStage": { $exists: false } },
                    { salaryProgress: { $exists: false } },
                  ],
                }
              : { "salaryProgress.lastClaimedStage": prevStage };

          /** Atomic compare-and-set on lastClaimedStage + lastClaimedAt snapshot — blocks duplicate / racing claims. */
          const claimFilter = {
            _id: userId,
            $and: [stageMatch, anchorLastClaimedAtCondition(lastClaimedAtSnapshot)],
          };

          const updatedUser = await User.findOneAndUpdate(
            claimFilter,
            {
              $inc: {
                rewardBalance: rewardAmount,
                totalEarnings: rewardAmount,
              },
              $set: {
                "salaryProgress.lastClaimedStage": nextStage,
                "salaryProgress.lastClaimedAt": now,
                salaryStage: nextStage,
              },
              $addToSet: {
                claimedSalaryStages: nextStage,
              },
              $push: {
                salaryHistory: {
                  $each: [
                    {
                      stage: nextStage,
                      amount: rewardAmount,
                      claimedAt: now,
                    },
                  ],
                  $slice: -20,
                },
              },
            },
            {
              returnDocument: "after",
              session,
              runValidators: true,
            }
          );

          if (!updatedUser) {
            const err = new Error("Already claimed or state changed");
            err.statusCode = 409;
            throw err;
          }

          await addHybridLedgerEntries(
            [
              {
                userId,
                entryType: "credit",
                balanceType: "rewardBalance",
                amount: rewardAmount,
                source: "salary_claim",
                meta: {
                  stage: nextStage,
                  directCountFresh: direct,
                  teamCountFresh: team,
                },
              },
            ],
            session
          );

          return {
            stage: nextStage,
            amount: rewardAmount,
            claimedAt: now,
          };
      });

      await invalidateSalaryCountCache(userId);

      bumpClaimSalary(true);

      return result;
    } catch (err) {
      lastErr = err;
      if (err?.statusCode === 409) {
        throw err;
      }
      if (attempt < MAX_ATTEMPTS - 1 && isTransientTxnError(err)) {
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
        continue;
      }
      bumpClaimSalary(false);
      throw err;
    }
  }

  bumpClaimSalary(false);
  throw lastErr || new Error("Salary claim failed");
};

/** Salary UI block on hybrid dashboard */
export const getSalaryUiMeta = async (userId) => {
  const payload = await buildSalaryProgressPayload(
    typeof userId === "object" && userId?._id != null ? userId._id : userId
  );

  if (!payload) {
    return {
      claimableStage: 0,
      claimableAmount: 0,
      nextStage: null,
      nextDirectNeed: null,
      nextTeamNeed: null,
      nextReward: null,
      directCount: 0,
      teamCount: 0,
      claimedSalaryStages: [],
    };
  }

  const nextRule = payload.salaryComplete
    ? null
    : SALARY_RULES.find((r) => r.stage === nextSalaryStageAfterClaim(payload.lastClaimedStage)) ??
      null;

  const claimRule = SALARY_RULES.find((r) => r.stage === payload.claimableStage);

  return {
    claimableStage: payload.claimableStage,
    claimableAmount: claimRule?.amount ?? 0,
    nextStage: nextRule?.stage ?? null,
    nextDirectNeed: nextRule?.directCount ?? null,
    nextTeamNeed: nextRule?.teamCount ?? null,
    nextReward: nextRule?.amount ?? null,
    directCount: payload.direct,
    teamCount: payload.team,
    claimedSalaryStages: payload.claimedSalaryStages ?? [],
  };
};

export const refreshSalaryStage = async (userId, session = null) =>
  migrateSalaryProgressFields(userId, session);
