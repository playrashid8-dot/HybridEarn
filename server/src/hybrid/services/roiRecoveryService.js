import mongoose from "mongoose";
import { Job } from "bullmq";
import User from "../../models/User.js";
import HybridLedger from "../models/HybridLedger.js";
import {
  HYBRID_PAYOUT_QUEUE_NAME,
  HYBRID_PAYOUT_QUEUE_PREFIX,
  PAYOUT_JOB_OPTIONS,
  getPayoutBullMqRuntimeIdentity,
  payoutQueue,
} from "../../queues/payoutQueue.js";
import { getRedis, isRedisReady } from "../../config/redis.js";
import { runMongoTransaction } from "../../config/mongoTransactions.js";
import logger from "../../utils/logger.js";

const ROI_JOB_NAME = "roi_claim";
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_MINUTES = 30;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_LEDGER_DAYS = 90;
const QUEUE_JOB_TYPES = ["waiting", "active", "delayed", "failed", "completed", "paused"];
const INCOMPLETE_QUEUE_STATES = new Set(["waiting", "active", "delayed", "failed", "paused"]);
const REMOVABLE_STATES = new Set(["waiting", "delayed", "failed", "paused"]);

function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

function clampStaleMs(value) {
  const minutes = Number(value);
  const safeMinutes = Number.isFinite(minutes) ? minutes : DEFAULT_STALE_MINUTES;
  return Math.min(24 * 60, Math.max(5, safeMinutes)) * 60 * 1000;
}

function clampLedgerDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days)) return 14;
  return Math.min(MAX_LEDGER_DAYS, Math.max(1, Math.floor(days)));
}

function toObjectId(value) {
  const id = String(value || "").trim();
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

function parseRoiJobId(jobId) {
  const parts = String(jobId || "").split(":");
  if (parts.length !== 3 || parts[0] !== "roi") {
    return null;
  }
  const userId = parts[1];
  const claimWindowStartMs = Number(parts[2]);
  if (!mongoose.Types.ObjectId.isValid(userId) || !Number.isFinite(claimWindowStartMs)) {
    return null;
  }
  return { userId, claimWindowStartMs };
}

function getJobClaimWindow(job) {
  const fromId = parseRoiJobId(job?.id);
  if (fromId) return fromId;
  const userId = String(job?.data?.userId || "").trim();
  const claimWindowStartMs = Number(job?.data?.claimWindowStartMs);
  if (!mongoose.Types.ObjectId.isValid(userId) || !Number.isFinite(claimWindowStartMs)) {
    return null;
  }
  return { userId, claimWindowStartMs };
}

function getClaimWindowBounds(claimWindowStartMs) {
  const start = new Date(Number(claimWindowStartMs));
  const end = new Date(start.getTime() + DAY_MS);
  return { start, end };
}

function getJobProgress(job) {
  return job?.progress && typeof job.progress === "object" ? job.progress : {};
}

function serializeLedgerDoc(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    userId: String(doc.userId),
    entryType: doc.entryType,
    balanceType: doc.balanceType,
    amount: Number(doc.amount || 0),
    source: doc.source,
    createdAt: doc.createdAt,
    meta: doc.meta || null,
  };
}

async function serializeJob(job, state = null, staleMs = clampStaleMs()) {
  if (!job) return null;
  const resolvedState = state || (await job.getState().catch(() => "unknown"));
  const now = Date.now();
  const progress = getJobProgress(job);
  const processedOn = Number(job.processedOn || 0);
  const enqueuedAt = Number(job.timestamp || 0);
  const ageMs = enqueuedAt > 0 ? now - enqueuedAt : null;
  const activeForMs = processedOn > 0 && !job.finishedOn ? now - processedOn : null;
  const claimWindow = getJobClaimWindow(job);
  return {
    id: String(job.id),
    name: job.name,
    state: resolvedState,
    progress,
    userId: claimWindow?.userId || String(job.data?.userId || ""),
    claimWindowStartMs: claimWindow?.claimWindowStartMs ?? Number(job.data?.claimWindowStartMs || 0),
    attemptsMade: Number(job.attemptsMade || 0),
    attemptsBudget: Number(job.opts?.attempts || 0),
    failedReason: job.failedReason || null,
    timestamp: job.timestamp || null,
    processedOn: job.processedOn || null,
    finishedOn: job.finishedOn || null,
    ageMs,
    activeForMs,
    stale:
      resolvedState === "active"
        ? activeForMs != null && activeForMs >= staleMs
        : ageMs != null && ageMs >= staleMs && INCOMPLETE_QUEUE_STATES.has(resolvedState),
    returnvalue: job.returnvalue || null,
  };
}

async function getRoiClaimEvidence(userId, claimWindowStartMs, session = null) {
  const oid = toObjectId(userId);
  if (!oid || !Number.isFinite(Number(claimWindowStartMs))) {
    return {
      valid: false,
      reason: "invalid_user_or_window",
      user: null,
      ledgerEntries: [],
      ledgerCount: 0,
      ledgerTotal: 0,
      claimedByUserMarker: false,
      completed: false,
      incompleteClaimMarker: false,
    };
  }

  const { start, end } = getClaimWindowBounds(claimWindowStartMs);
  const userQuery = User.findById(oid).select(
    "username email lastDailyClaim rewardBalance depositBalance totalEarnings todayProfit level",
  );
  const ledgerQuery = HybridLedger.find({
    userId: oid,
    source: "roi_claim",
    entryType: "credit",
    balanceType: "rewardBalance",
    createdAt: { $gte: start, $lt: end },
  }).sort({ createdAt: 1 });

  if (session) {
    userQuery.session(session);
    ledgerQuery.session(session);
  }

  const [user, ledgerEntries] = await Promise.all([userQuery.lean(), ledgerQuery.lean()]);
  const lastDailyClaimMs = user?.lastDailyClaim ? new Date(user.lastDailyClaim).getTime() : null;
  const claimedByUserMarker =
    lastDailyClaimMs != null &&
    lastDailyClaimMs >= start.getTime() &&
    lastDailyClaimMs < end.getTime();
  const ledgerTotal = ledgerEntries.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const completed = ledgerEntries.length > 0 && claimedByUserMarker;

  return {
    valid: true,
    claimWindowStart: start,
    claimWindowEnd: end,
    user: user
      ? {
          id: String(user._id),
          username: user.username,
          email: user.email,
          lastDailyClaim: user.lastDailyClaim || null,
          rewardBalance: Number(user.rewardBalance || 0),
          depositBalance: Number(user.depositBalance || 0),
          totalEarnings: Number(user.totalEarnings || 0),
          todayProfit: Number(user.todayProfit || 0),
          level: Number(user.level || 0),
        }
      : null,
    ledgerEntries: ledgerEntries.map(serializeLedgerDoc),
    ledgerCount: ledgerEntries.length,
    ledgerTotal: Number(ledgerTotal.toFixed(8)),
    claimedByUserMarker,
    completed,
    incompleteClaimMarker: claimedByUserMarker && ledgerEntries.length === 0,
    duplicateLedger: ledgerEntries.length > 1,
  };
}

async function getQueueCounts() {
  if (!payoutQueue || !isRedisReady(getRedis())) {
    return { available: false, reason: "no_queue" };
  }
  const counts = await payoutQueue.getJobCounts(
    "waiting",
    "active",
    "delayed",
    "failed",
    "completed",
    "paused",
  );
  return {
    available: true,
    runtime: getPayoutBullMqRuntimeIdentity(getRedis()),
    counts,
  };
}

async function getRoiQueueJobs(limit, staleMs) {
  if (!payoutQueue || !isRedisReady(getRedis())) {
    return [];
  }
  const jobs = await payoutQueue.getJobs(QUEUE_JOB_TYPES, 0, limit - 1, false);
  const serialized = [];
  for (const job of jobs) {
    if (job?.name !== ROI_JOB_NAME) continue;
    serialized.push(await serializeJob(job, null, staleMs));
  }
  return serialized;
}

function groupByClaimKey(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const key = `${job.userId}:${job.claimWindowStartMs}`;
    const current = groups.get(key) || [];
    current.push(job);
    groups.set(key, current);
  }
  return [...groups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => ({ key, jobs: rows }));
}

async function getDuplicateRoiLedgerClaims(ledgerDays, limit) {
  const since = new Date(Date.now() - ledgerDays * DAY_MS);
  return HybridLedger.aggregate([
    {
      $match: {
        source: "roi_claim",
        entryType: "credit",
        balanceType: "rewardBalance",
        createdAt: { $gte: since },
      },
    },
    {
      $group: {
        _id: {
          userId: "$userId",
          day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } },
        },
        count: { $sum: 1 },
        totalAmount: { $sum: "$amount" },
        ledgerIds: { $push: "$_id" },
        firstCreatedAt: { $min: "$createdAt" },
        lastCreatedAt: { $max: "$createdAt" },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { lastCreatedAt: -1 } },
    { $limit: limit },
  ]);
}

async function getIncompleteClaimMarkers(ledgerDays, limit) {
  const since = new Date(Date.now() - ledgerDays * DAY_MS);
  const users = await User.find({ lastDailyClaim: { $gte: since } })
    .select("username email lastDailyClaim rewardBalance totalEarnings")
    .sort({ lastDailyClaim: -1 })
    .limit(limit)
    .lean();

  const incomplete = [];
  for (const user of users) {
    const claimWindowStartMs = Date.UTC(
      new Date(user.lastDailyClaim).getUTCFullYear(),
      new Date(user.lastDailyClaim).getUTCMonth(),
      new Date(user.lastDailyClaim).getUTCDate(),
      0,
      0,
      0,
      0,
    );
    const evidence = await getRoiClaimEvidence(user._id, claimWindowStartMs);
    if (evidence.incompleteClaimMarker) {
      incomplete.push({
        userId: String(user._id),
        username: user.username,
        email: user.email,
        lastDailyClaim: user.lastDailyClaim,
        claimWindowStartMs,
        risk: "user_lastDailyClaim_set_but_no_roi_ledger_for_window",
      });
    }
  }
  return incomplete;
}

async function getOrphanRoiLedgerClaims(ledgerDays, limit) {
  const since = new Date(Date.now() - ledgerDays * DAY_MS);
  return HybridLedger.aggregate([
    {
      $match: {
        source: "roi_claim",
        entryType: "credit",
        balanceType: "rewardBalance",
        createdAt: { $gte: since },
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "userId",
        foreignField: "_id",
        as: "user",
      },
    },
    { $match: { user: { $size: 0 } } },
    { $sort: { createdAt: -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 1,
        userId: 1,
        amount: 1,
        createdAt: 1,
        meta: 1,
      },
    },
  ]);
}

export async function auditRoiRecoveryState(options = {}) {
  const limit = clampLimit(options.limit);
  const staleMs = clampStaleMs(options.staleMinutes);
  const ledgerDays = clampLedgerDays(options.ledgerDays);
  const [queue, jobs, duplicateLedgerClaims, incompleteClaimMarkers, orphanLedgerClaims] =
    await Promise.all([
      getQueueCounts(),
      getRoiQueueJobs(limit, staleMs),
      getDuplicateRoiLedgerClaims(ledgerDays, limit),
      getIncompleteClaimMarkers(ledgerDays, limit),
      getOrphanRoiLedgerClaims(ledgerDays, limit),
    ]);

  const staleJobs = jobs.filter((job) => job.stale && INCOMPLETE_QUEUE_STATES.has(job.state));
  const staleJobsWithEvidence = [];
  for (const job of staleJobs.slice(0, limit)) {
    staleJobsWithEvidence.push({
      job,
      evidence: await getRoiClaimEvidence(job.userId, job.claimWindowStartMs),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    policy: {
      noAutoCredit: true,
      ledgerImmutable: true,
      retryRequiresNoCompletedClaimEvidence: true,
      completedEvidenceRequiresRoiLedgerAndUserClaimMarker: true,
    },
    queue,
    roiQueue: {
      scanned: jobs.length,
      stale: staleJobsWithEvidence,
      duplicateJobs: groupByClaimKey(jobs),
      deadLetterJobs: jobs.filter(
        (job) =>
          job.state === "failed" &&
          Number(job.attemptsBudget || 0) > 0 &&
          Number(job.attemptsMade || 0) >= Number(job.attemptsBudget || 0),
      ),
      jobs,
    },
    mongo: {
      ledgerWindowDays: ledgerDays,
      duplicateLedgerClaims,
      incompleteClaimMarkers,
      orphanLedgerClaims,
    },
  };
}

export async function inspectRoiRecoveryJob(jobId) {
  if (!payoutQueue || !isRedisReady(getRedis())) {
    return { ok: false, reason: "no_queue" };
  }
  const parsed = parseRoiJobId(jobId);
  if (!parsed) {
    return { ok: false, reason: "invalid_roi_job_id" };
  }
  const job = await payoutQueue.getJob(jobId);
  const serialized = job ? await serializeJob(job) : null;
  const evidence = await getRoiClaimEvidence(parsed.userId, parsed.claimWindowStartMs);
  return {
    ok: true,
    exists: Boolean(job),
    job: serialized,
    evidence,
  };
}

async function enqueueReplacementRoiJob(userId, claimWindowStartMs, reason) {
  const jobId = `roi:${userId}:${claimWindowStartMs}`;
  const job = await payoutQueue.add(
    ROI_JOB_NAME,
    { userId: String(userId), claimWindowStartMs: Number(claimWindowStartMs), recoveryReason: reason },
    {
      ...PAYOUT_JOB_OPTIONS,
      jobId,
    },
  );
  return job;
}

export async function retryStuckRoiJob(jobId, options = {}) {
  if (!payoutQueue || !isRedisReady(getRedis())) {
    return { ok: false, reason: "no_queue" };
  }
  const parsed = parseRoiJobId(jobId);
  if (!parsed) {
    return { ok: false, reason: "invalid_roi_job_id" };
  }
  const dryRun = options.dryRun !== false;
  const job = await payoutQueue.getJob(jobId);
  const state = job ? await job.getState().catch(() => "unknown") : "missing";
  const evidence = await getRoiClaimEvidence(parsed.userId, parsed.claimWindowStartMs);

  if (evidence.completed || evidence.ledgerCount > 0) {
    return {
      ok: true,
      action: "not_retried_completed_claim_evidence",
      dryRun,
      state,
      evidence,
      warning: "ROI ledger/user claim evidence exists; retry would risk duplicate credit.",
    };
  }
  if (evidence.incompleteClaimMarker) {
    return {
      ok: false,
      action: "manual_review_required",
      dryRun,
      state,
      evidence,
      reason: "User claim marker exists without ROI ledger. No automatic retry or credit is safe.",
    };
  }
  if (dryRun) {
    return {
      ok: true,
      action: job ? "would_retry_or_requeue" : "would_enqueue_missing_job",
      dryRun,
      state,
      evidence,
    };
  }

  if (job && state === "failed") {
    await job.retry("failed");
    logger.warn("Admin retried failed ROI job", { jobId, userId: parsed.userId });
    return { ok: true, action: "retried_failed_job", dryRun, state, evidence };
  }

  if (job && REMOVABLE_STATES.has(state)) {
    await job.remove();
    const replacement = await enqueueReplacementRoiJob(
      parsed.userId,
      parsed.claimWindowStartMs,
      "removed_stale_incomplete_job",
    );
    logger.warn("Admin replaced stale ROI job", {
      jobId,
      replacementJobId: replacement.id,
      previousState: state,
    });
    return {
      ok: true,
      action: "removed_and_requeued",
      dryRun,
      previousState: state,
      jobId: replacement.id,
      evidence,
    };
  }

  if (!job) {
    const replacement = await enqueueReplacementRoiJob(
      parsed.userId,
      parsed.claimWindowStartMs,
      "missing_roi_recovery_job",
    );
    logger.warn("Admin enqueued missing ROI recovery job", {
      jobId: replacement.id,
      userId: parsed.userId,
    });
    return { ok: true, action: "enqueued_missing_job", dryRun, state, jobId: replacement.id, evidence };
  }

  return {
    ok: false,
    action: "not_retried",
    dryRun,
    state,
    evidence,
    reason: "Active or locked jobs must be recovered by BullMQ stall handling or retried after failure.",
  };
}

export async function resolveCompletedRoiJob(jobId, options = {}) {
  if (!payoutQueue || !isRedisReady(getRedis())) {
    return { ok: false, reason: "no_queue" };
  }
  const parsed = parseRoiJobId(jobId);
  if (!parsed) {
    return { ok: false, reason: "invalid_roi_job_id" };
  }
  const dryRun = options.dryRun !== false;
  const job = await payoutQueue.getJob(jobId);
  const state = job ? await job.getState().catch(() => "unknown") : "missing";
  const evidence = await getRoiClaimEvidence(parsed.userId, parsed.claimWindowStartMs);

  if (!evidence.completed && evidence.ledgerCount === 0) {
    return {
      ok: false,
      action: "not_resolved",
      dryRun,
      state,
      evidence,
      reason: "No ROI ledger evidence exists for this claim window.",
    };
  }

  if (dryRun) {
    return {
      ok: true,
      action: job && REMOVABLE_STATES.has(state) ? "would_remove_duplicate_queue_job" : "would_noop",
      dryRun,
      state,
      evidence,
    };
  }

  if (job && REMOVABLE_STATES.has(state)) {
    await job.remove();
    logger.warn("Admin removed duplicate ROI queue job after completed claim evidence", {
      jobId,
      state,
      userId: parsed.userId,
    });
    return { ok: true, action: "removed_duplicate_queue_job", dryRun, state, evidence };
  }

  return {
    ok: true,
    action: "completed_evidence_no_queue_mutation",
    dryRun,
    state,
    evidence,
    warning: state === "active" ? "Active job was not mutated without a BullMQ lock token." : null,
  };
}

export async function markStaleRoiJobFailed(jobId, options = {}) {
  if (!payoutQueue || !isRedisReady(getRedis())) {
    return { ok: false, reason: "no_queue" };
  }
  const parsed = parseRoiJobId(jobId);
  if (!parsed) {
    return { ok: false, reason: "invalid_roi_job_id" };
  }
  const dryRun = options.dryRun !== false;
  const staleMs = clampStaleMs(options.staleMinutes);
  const job = await payoutQueue.getJob(jobId);
  if (!job) {
    return { ok: true, action: "missing_job_noop", dryRun };
  }
  const serialized = await serializeJob(job, null, staleMs);
  const evidence = await getRoiClaimEvidence(parsed.userId, parsed.claimWindowStartMs);

  if (evidence.completed || evidence.ledgerCount > 0) {
    return resolveCompletedRoiJob(jobId, options);
  }
  if (!serialized.stale) {
    return {
      ok: false,
      action: "not_stale",
      dryRun,
      job: serialized,
      evidence,
      reason: "Job has not exceeded the configured stale threshold.",
    };
  }
  if (dryRun) {
    return {
      ok: true,
      action: "would_block_external_state_mutation",
      dryRun,
      job: serialized,
      evidence,
      warning: "BullMQ state is not force-failed externally; use retry endpoint to safely requeue removable jobs.",
    };
  }

  return {
    ok: false,
    action: "external_state_mutation_blocked",
    dryRun,
    job: serialized,
    evidence,
    reason:
      "BullMQ jobs are not force-failed without a worker lock token. Retry removable jobs or let active jobs enter failed/stalled state naturally.",
  };
}

export async function repairIncompleteRoiClaim(jobId, options = {}) {
  const parsed = parseRoiJobId(jobId);
  if (!parsed) {
    return { ok: false, reason: "invalid_roi_job_id" };
  }
  const dryRun = options.dryRun !== false;
  const evidence = await getRoiClaimEvidence(parsed.userId, parsed.claimWindowStartMs);

  if (evidence.completed) {
    return { ok: true, action: "already_consistent", dryRun, evidence };
  }
  if (evidence.ledgerCount === 0) {
    return {
      ok: false,
      action: "manual_review_required",
      dryRun,
      evidence,
      reason: "No ROI ledger exists. This utility never auto-credits funds or deletes claim markers.",
    };
  }
  if (evidence.claimedByUserMarker) {
    return {
      ok: true,
      action: "ledger_present_marker_present",
      dryRun,
      evidence,
      warning: evidence.duplicateLedger ? "Duplicate ROI ledgers require manual financial review." : null,
    };
  }

  const ledgerCreatedAt = evidence.ledgerEntries[0]?.createdAt;
  if (!ledgerCreatedAt) {
    return { ok: false, action: "manual_review_required", dryRun, evidence };
  }
  if (dryRun) {
    return {
      ok: true,
      action: "would_set_lastDailyClaim_from_existing_ledger",
      dryRun,
      evidence,
    };
  }

  const result = await runMongoTransaction("hybrid.roi.repairClaimMarker", async (session) => {
    const refreshed = await getRoiClaimEvidence(parsed.userId, parsed.claimWindowStartMs, session);
    if (refreshed.claimedByUserMarker) {
      return { alreadyRepaired: true, evidence: refreshed };
    }
    if (refreshed.ledgerCount === 0) {
      throw new Error("Cannot repair ROI claim marker without existing ROI ledger");
    }
    const updated = await User.findOneAndUpdate(
      {
        _id: toObjectId(parsed.userId),
        $or: [
          { lastDailyClaim: null },
          { lastDailyClaim: { $lt: refreshed.claimWindowStart } },
          { lastDailyClaim: { $gte: refreshed.claimWindowEnd } },
          { lastDailyClaim: { $exists: false } },
        ],
      },
      { $set: { lastDailyClaim: new Date(refreshed.ledgerEntries[0].createdAt) } },
      { returnDocument: "after", session },
    ).select("lastDailyClaim");
    return { updated: Boolean(updated), evidence: refreshed };
  });

  logger.warn("Admin repaired ROI claim marker from existing ledger", {
    jobId,
    userId: parsed.userId,
    updated: result.updated,
  });
  return { ok: true, action: "set_lastDailyClaim_from_existing_ledger", dryRun, result };
}

export async function getRawRoiBullMqJob(jobId) {
  if (!payoutQueue || !isRedisReady(getRedis())) {
    return { ok: false, reason: "no_queue" };
  }
  const job = await Job.fromId(payoutQueue, jobId);
  return {
    ok: true,
    queueName: HYBRID_PAYOUT_QUEUE_NAME,
    prefix: HYBRID_PAYOUT_QUEUE_PREFIX,
    job: job ? await serializeJob(job) : null,
  };
}
