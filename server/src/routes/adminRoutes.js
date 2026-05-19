import express from "express";
import mongoose from "mongoose";
import auth from "../middleware/auth.js";
import User from "../models/User.js";
import AdminAuditLog from "../models/AdminAuditLog.js";
import AdminFinancialCreditLimit from "../models/AdminFinancialCreditLimit.js";
import HybridDeposit from "../hybrid/models/HybridDeposit.js";
import HybridLedger from "../hybrid/models/HybridLedger.js";
import HybridWithdrawal from "../hybrid/models/HybridWithdrawal.js";
import {
  adminApproveHybridWithdrawal,
  adminForcePayoutHybridWithdrawal,
  adminRejectAllHybridWithdrawals,
  adminRejectHybridWithdrawal,
} from "../hybrid/services/withdrawService.js";
import { scanHybridDeposits } from "../hybrid/services/depositListener.js";
import { addHybridLedgerEntries } from "../hybrid/services/ledgerService.js";
import { getProvider } from "../hybrid/utils/provider.js";
import {
  getAdminDashboardSystemStatus,
  getHybridAdminSystemStatus,
} from "../hybrid/utils/adminSystemStatus.js";
import { getSystemHealth } from "../hybrid/utils/systemHealth.js";
import { getHybridWithdrawExecutorStatus } from "../hybrid/engine/index.js";
import { getReadyRedis } from "../config/redis.js";
import { runMongoTransaction } from "../config/mongoTransactions.js";
import { depositQueue } from "../queues/depositQueue.js";
import { payoutQueue } from "../queues/payoutQueue.js";
import { writeAdminAudit } from "../utils/adminAudit.js";
import {
  beginIdempotentAction,
  completeIdempotency,
  failIdempotency,
} from "../hybrid/services/idempotencyService.js";
import {
  creditActiveUsdtBalance,
  getSpendableHybridBalance,
} from "../hybrid/services/balanceService.js";
import logger from "../utils/logger.js";
import { syncUserLevel } from "../hybrid/services/levelService.js";
import {
  buildAdminOverview,
  buildFraudSignals,
  salaryPayoutsPage,
  logFeed,
  getUserAdminDetail,
} from "../services/adminPanelService.js";
import { buildAdminOpsCenterSnapshot } from "../services/adminOpsCenterService.js";
import {
  auditRoiRecoveryState,
  inspectRoiRecoveryJob,
  markStaleRoiJobFailed,
  repairIncompleteRoiClaim,
  resolveCompletedRoiJob,
  retryStuckRoiJob,
} from "../hybrid/services/roiRecoveryService.js";

const router = express.Router();
const QUEUE_JOB_STATES = new Set(["waiting", "active", "delayed", "completed", "failed"]);
const ADMIN_CREDIT_CATEGORIES = new Set([
  "cashback",
  "compensation",
  "promotion",
  "recovery",
  "referral_bonus",
  "marketing_reward",
]);
const ADMIN_CREDIT_ACTIONS = new Set([
  "add_reward",
  "add_bonus",
  "promotional_credit",
  "compensation_credit",
  "cashback_credit",
  "recovery_credit",
]);
const ADMIN_CREDIT_IDEMPOTENCY_TYPE = "admin_credit";
const INTERNAL_ADMIN_CREDIT_SOURCE = "internal_admin_credit";
const ADMIN_CREDIT_LEDGER_SOURCES = ["admin_credit", INTERNAL_ADMIN_CREDIT_SOURCE];
const ADMIN_USERS_PAGE_LIMIT = 100;
const ADMIN_USERS_DEFAULT_LIMIT = 25;
const ADMIN_USERS_POLL_MS = 15000;
const ADMIN_USER_EARNING_SOURCES = [
  "roi_claim",
  "roi_referral_bonus",
  "referral_bonus",
  "first_deposit_bonus",
  "admin_credit",
  INTERNAL_ADMIN_CREDIT_SOURCE,
  "stake_claim",
  "salary_claim",
  "level_bonus",
];
const TEAM_EARNING_SOURCES = new Set([
  "roi_referral_bonus",
  "referral_bonus",
  "first_deposit_bonus",
]);
const BONUS_EARNING_SOURCES = new Set(["salary_claim", "level_bonus"]);

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPositivePage(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function toAdminUsersLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return ADMIN_USERS_DEFAULT_LIMIT;
  return Math.min(Math.floor(n), ADMIN_USERS_PAGE_LIMIT);
}

function roundFinancialAmount(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 1e8) / 1e8 : 0;
}

function maskWalletAddress(value) {
  const wallet = String(value || "").trim();
  if (!wallet) return "";
  if (wallet.length <= 12) return wallet;
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

function getAdminUsersSort(filter) {
  if (filter === "highest_available") return { availableUSDT: -1, createdAt: -1 };
  if (filter === "newest") return { createdAt: -1 };
  if (filter === "pending_withdrawals") return { pendingWithdraw: -1, createdAt: -1 };
  return { createdAt: -1 };
}

const sendAdminError = (res, err, context) => {
  logger.error(context, { error: err?.message || String(err) });
  const statusCode =
    typeof err?.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 600
      ? err.statusCode
      : 500;

  if (statusCode < 500) {
    return res.status(statusCode).json({
      success: false,
      msg: err.message,
      data: null,
    });
  }

  return res.status(500).json({
    success: false,
    msg: "Internal server error",
    data: null,
  });
};

function adminCreditLimitFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function roundCreditAmount(value) {
  return Math.round(Number(value) * 1e6) / 1e6;
}

function parseAdminCreditAmount(value) {
  const amount = roundCreditAmount(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error("Amount must be greater than 0");
    err.statusCode = 400;
    throw err;
  }
  return amount;
}

function getAdminCreditDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function getRequestAuditContext(req) {
  return {
    ip:
      String(req.headers["x-forwarded-for"] || "")
        .split(",")[0]
        .trim() ||
      req.ip ||
      req.socket?.remoteAddress ||
      null,
    userAgent: req.headers["user-agent"] || null,
    sessionId:
      req.headers["x-session-id"] ||
      req.headers["x-request-id"] ||
      req.headers["cf-ray"] ||
      null,
  };
}

async function consumeAdminCreditDailyLimit({ adminId, amount, dailyLimit, dayKey, session }) {
  const allowedBeforeIncrement = roundCreditAmount(dailyLimit - amount);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const updated = await AdminFinancialCreditLimit.findOneAndUpdate(
      {
        adminId,
        dayKey,
        amountUsed: { $lte: allowedBeforeIncrement },
      },
      {
        $inc: { amountUsed: amount, count: 1 },
      },
      { new: true, session }
    );

    if (updated) {
      const used = Number(updated.amountUsed || 0);
      return { amountUsed: used, remaining: Math.max(dailyLimit - used, 0) };
    }

    const current = await AdminFinancialCreditLimit.findOne({ adminId, dayKey })
      .session(session)
      .lean();

    if (current) {
      const currentUsed = Number(current.amountUsed || 0);
      const err = new Error(
        `Daily admin credit limit exceeded. Remaining limit: ${Math.max(dailyLimit - currentUsed, 0).toFixed(2)} USDT`
      );
      err.statusCode = 400;
      throw err;
    }

    try {
      await AdminFinancialCreditLimit.create(
        [{ adminId, dayKey, amountUsed: amount, count: 1 }],
        { session }
      );
      return { amountUsed: amount, remaining: Math.max(dailyLimit - amount, 0) };
    } catch (err) {
      if (err?.code !== 11000 || attempt === 1) {
        throw err;
      }
    }
  }

  const err = new Error("Daily admin credit limit could not be reserved");
  err.statusCode = 409;
  throw err;
}

function getAdminQueueTarget(queueKey) {
  const key = String(queueKey || "").toLowerCase();
  if (key === "deposit") {
    return {
      key,
      label: "deposit queue",
      queue: depositQueue,
      jobName: null,
      safeRetryNames: new Set(["deposit"]),
    };
  }
  if (key === "payout") {
    return {
      key,
      label: "payout queue",
      queue: payoutQueue,
      jobName: "withdraw_batch",
      safeRetryNames: new Set(),
    };
  }
  if (key === "roi") {
    return {
      key,
      label: "ROI queue",
      queue: payoutQueue,
      jobName: "roi_claim",
      safeRetryNames: new Set(["roi_claim"]),
    };
  }
  return null;
}

async function serializeAdminQueueJob(job) {
  const state = typeof job?.getState === "function" ? await job.getState().catch(() => "unknown") : "unknown";
  return {
    id: String(job?.id || ""),
    name: String(job?.name || "unknown"),
    state,
    attemptsMade: Number(job?.attemptsMade || 0),
    failedReason: job?.failedReason || null,
    timestamp: job?.timestamp || null,
    processedOn: job?.processedOn || null,
    finishedOn: job?.finishedOn || null,
    progress: job?.progress ?? null,
    data: job?.data ?? null,
    returnvalue: job?.returnvalue ?? null,
  };
}

function getQueueLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 25;
  return Math.min(Math.max(Math.floor(n), 1), 100);
}


/** Legacy withdrawals may omit risk fields — keep admin UI stable. */
function normalizeHybridWithdrawRows(rows) {
  return (rows || []).map((w) => {
    const o = w && typeof w.toObject === "function" ? w.toObject() : { ...(w || {}) };
    return {
      ...o,
      riskScore: o.riskScore ?? 0,
      priority: o.priority ?? "normal",
    };
  });
}

/* ==============================
   🔐 ADMIN CHECK
============================== */
const isAdmin = async (req, res, next) => {
  try {
    if (!req.user?._id || req.user.isAdmin !== true) {
      return res.status(403).json({
        success: false,
        msg: "Admin access only",
        data: null,
      });
    }

    next();
  } catch (err) {
    logger.error("ADMIN CHECK ERROR", { error: err?.message || String(err) });
    res.status(500).json({ success: false, msg: "Internal server error", data: null });
  }
};

/* ==============================
   💚 SYSTEM STATUS
============================== */
router.get("/system-status", auth, isAdmin, async (req, res) => {
  try {
    const status = await getHybridAdminSystemStatus();
    return res.json({
      success: true,
      msg: "System status",
      data: { status },
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN SYSTEM STATUS ERROR");
  }
});

router.get("/system/status", auth, isAdmin, async (req, res) => {
  try {
    const status = await getAdminDashboardSystemStatus();
    return res.json({
      success: true,
      msg: "System status",
      data: status,
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN SYSTEM STATUS ERROR");
  }
});

router.get("/system-health", auth, isAdmin, async (req, res) => {
  try {
    const system = await getSystemHealth();
    const executorStatus = getHybridWithdrawExecutorStatus();
    let queue = null;
    try {
      if (getReadyRedis() && depositQueue) {
        queue = await depositQueue.getJobCounts();
      }
    } catch (err) {
      logger.warn("ADMIN SYSTEM HEALTH QUEUE ERROR", { error: err?.message || String(err) });
      queue = { error: "Queue unavailable" };
    }
    return res.json({
      success: true,
      msg: "System health",
      data: {
        redis: !!getReadyRedis(),
        queue,
        system,
        pendingDeposits: system.pendingDeposits,
        failedPayouts: system.failedPayouts,
        rpc: system.rpc,
        executorStatus,
        executor: system.executor,
        uptime: process.uptime(),
      },
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN SYSTEM HEALTH ERROR");
  }
});

router.get("/ops-center", auth, isAdmin, async (req, res) => {
  try {
    const data = await buildAdminOpsCenterSnapshot();
    return res.json({
      success: true,
      msg: "Admin operations center snapshot",
      data,
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN OPS CENTER ERROR");
  }
});

router.get("/ops-center/queues/:queueKey/jobs", auth, isAdmin, async (req, res) => {
  try {
    const target = getAdminQueueTarget(req.params.queueKey);
    if (!target) {
      return res.status(400).json({ success: false, msg: "Unknown queue", data: null });
    }
    if (!target.queue) {
      return res.status(503).json({ success: false, msg: "Queue unavailable in this process", data: null });
    }

    const state = String(req.query.state || "failed").toLowerCase();
    if (!QUEUE_JOB_STATES.has(state)) {
      return res.status(400).json({
        success: false,
        msg: `state must be one of: ${Array.from(QUEUE_JOB_STATES).join(", ")}`,
        data: null,
      });
    }

    const limit = getQueueLimit(req.query.limit);
    const jobs = await target.queue.getJobs([state], 0, limit - 1, false);
    const filtered = target.jobName ? jobs.filter((job) => job?.name === target.jobName) : jobs;
    const rows = await Promise.all(filtered.map(serializeAdminQueueJob));

    return res.json({
      success: true,
      msg: "Queue jobs fetched",
      data: { queue: target.key, state, jobs: rows },
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN OPS QUEUE JOBS ERROR");
  }
});

router.get("/ops-center/queues/:queueKey/jobs/:jobId", auth, isAdmin, async (req, res) => {
  try {
    const target = getAdminQueueTarget(req.params.queueKey);
    if (!target) {
      return res.status(400).json({ success: false, msg: "Unknown queue", data: null });
    }
    if (!target.queue) {
      return res.status(503).json({ success: false, msg: "Queue unavailable in this process", data: null });
    }

    const job = await target.queue.getJob(String(req.params.jobId || ""));
    if (!job || (target.jobName && job.name !== target.jobName)) {
      return res.status(404).json({ success: false, msg: "Job not found", data: null });
    }

    return res.json({
      success: true,
      msg: "Queue job inspected",
      data: { queue: target.key, job: await serializeAdminQueueJob(job) },
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN OPS QUEUE JOB INSPECT ERROR");
  }
});

router.post("/ops-center/queues/:queueKey/:action", auth, isAdmin, async (req, res) => {
  try {
    const target = getAdminQueueTarget(req.params.queueKey);
    const action = String(req.params.action || "").toLowerCase();
    if (!target) {
      return res.status(400).json({ success: false, msg: "Unknown queue", data: null });
    }
    if (!target.queue) {
      return res.status(503).json({ success: false, msg: "Queue unavailable in this process", data: null });
    }
    if (!["pause", "resume"].includes(action)) {
      return res.status(400).json({ success: false, msg: "Unsupported queue action", data: null });
    }

    if (action === "pause") {
      await target.queue.pause();
    } else {
      await target.queue.resume();
    }

    await writeAdminAudit({
      adminId: req.user._id,
      category: "queue",
      action: `Queue ${action}`,
      meta: { queue: target.key, label: target.label },
    });

    return res.json({
      success: true,
      msg: `Queue ${action} requested`,
      data: { queue: target.key, action },
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN OPS QUEUE ACTION ERROR");
  }
});

router.post("/ops-center/queues/:queueKey/jobs/:jobId/retry", auth, isAdmin, async (req, res) => {
  try {
    const target = getAdminQueueTarget(req.params.queueKey);
    if (!target) {
      return res.status(400).json({ success: false, msg: "Unknown queue", data: null });
    }
    if (!target.queue) {
      return res.status(503).json({ success: false, msg: "Queue unavailable in this process", data: null });
    }

    const job = await target.queue.getJob(String(req.params.jobId || ""));
    if (!job || (target.jobName && job.name !== target.jobName)) {
      return res.status(404).json({ success: false, msg: "Job not found", data: null });
    }
    if (!target.safeRetryNames.has(job.name)) {
      return res.status(409).json({
        success: false,
        msg: "Retry blocked: this queue job is not marked recovery-safe for admin replay",
        data: { queue: target.key, jobId: job.id, jobName: job.name },
      });
    }

    const state = await job.getState().catch(() => "unknown");
    if (state !== "failed") {
      return res.status(409).json({
        success: false,
        msg: "Only failed jobs can be retried from admin controls",
        data: { queue: target.key, jobId: job.id, state },
      });
    }

    await job.retry("failed");
    await writeAdminAudit({
      adminId: req.user._id,
      category: "queue",
      action: "Queue job retry requested",
      meta: {
        queue: target.key,
        jobId: String(job.id),
        jobName: String(job.name),
        recoverySafe: true,
      },
    });

    return res.json({
      success: true,
      msg: "Queue job retry requested",
      data: { queue: target.key, jobId: job.id, jobName: job.name },
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN OPS QUEUE JOB RETRY ERROR");
  }
});

router.get("/ledger", auth, isAdmin, async (req, res) => {
  try {
    const ledger = await HybridLedger.find()
      .sort({ createdAt: -1 })
      .limit(100);

    return res.json({
      success: true,
      msg: "Ledger data",
      data: ledger,
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN LEDGER ERROR");
  }
});

/* ==============================
   🛟 ROI QUEUE RECOVERY
============================== */

function parseRecoveryDryRun(req) {
  return String(req.body?.dryRun ?? req.query?.dryRun ?? "true").toLowerCase() !== "false";
}

router.get("/roi-recovery/audit", auth, isAdmin, async (req, res) => {
  try {
    const data = await auditRoiRecoveryState({
      limit: req.query.limit,
      staleMinutes: req.query.staleMinutes,
      ledgerDays: req.query.ledgerDays,
    });
    return res.json({
      success: true,
      msg: "ROI recovery audit",
      data,
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN ROI RECOVERY AUDIT ERROR");
  }
});

router.get("/roi-recovery/job/:jobId", auth, isAdmin, async (req, res) => {
  try {
    const data = await inspectRoiRecoveryJob(req.params.jobId);
    return res.status(data.ok === false ? 400 : 200).json({
      success: data.ok !== false,
      msg: data.ok === false ? data.reason || "Failed to inspect ROI job" : "ROI job state",
      data,
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN ROI RECOVERY JOB INSPECT ERROR");
  }
});

router.post("/roi-recovery/job/:jobId/retry", auth, isAdmin, async (req, res) => {
  try {
    const data = await retryStuckRoiJob(req.params.jobId, {
      dryRun: parseRecoveryDryRun(req),
    });
    await writeAdminAudit({
      adminId: req.user._id,
      category: "admin",
      action: "ROI recovery retry requested",
      meta: {
        jobId: String(req.params.jobId),
        dryRun: data.dryRun,
        result: data.action || data.reason || null,
      },
    });
    return res.status(data.ok === false ? 400 : 200).json({
      success: data.ok !== false,
      msg: data.ok === false ? data.reason || "ROI retry blocked" : "ROI retry evaluated",
      data,
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN ROI RECOVERY RETRY ERROR");
  }
});

router.post("/roi-recovery/job/:jobId/resolve-completed", auth, isAdmin, async (req, res) => {
  try {
    const data = await resolveCompletedRoiJob(req.params.jobId, {
      dryRun: parseRecoveryDryRun(req),
    });
    await writeAdminAudit({
      adminId: req.user._id,
      category: "admin",
      action: "ROI recovery resolve completed requested",
      meta: {
        jobId: String(req.params.jobId),
        dryRun: data.dryRun,
        result: data.action || data.reason || null,
      },
    });
    return res.status(data.ok === false ? 400 : 200).json({
      success: data.ok !== false,
      msg: data.ok === false ? data.reason || "ROI resolve blocked" : "ROI resolve evaluated",
      data,
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN ROI RECOVERY RESOLVE ERROR");
  }
});

router.post("/roi-recovery/job/:jobId/mark-stale-failed", auth, isAdmin, async (req, res) => {
  try {
    const data = await markStaleRoiJobFailed(req.params.jobId, {
      dryRun: parseRecoveryDryRun(req),
      staleMinutes: req.body?.staleMinutes ?? req.query?.staleMinutes,
    });
    await writeAdminAudit({
      adminId: req.user._id,
      category: "admin",
      action: "ROI recovery mark stale failed requested",
      meta: {
        jobId: String(req.params.jobId),
        dryRun: data.dryRun,
        result: data.action || data.reason || null,
      },
    });
    return res.status(data.ok === false ? 400 : 200).json({
      success: data.ok !== false,
      msg: data.ok === false ? data.reason || "ROI mark stale failed blocked" : "ROI stale failure evaluated",
      data,
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN ROI RECOVERY MARK FAILED ERROR");
  }
});

router.post("/roi-recovery/job/:jobId/repair-incomplete-claim", auth, isAdmin, async (req, res) => {
  try {
    const data = await repairIncompleteRoiClaim(req.params.jobId, {
      dryRun: parseRecoveryDryRun(req),
    });
    await writeAdminAudit({
      adminId: req.user._id,
      category: "admin",
      action: "ROI recovery repair incomplete claim requested",
      meta: {
        jobId: String(req.params.jobId),
        dryRun: data.dryRun,
        result: data.action || data.reason || null,
      },
    });
    return res.status(data.ok === false ? 400 : 200).json({
      success: data.ok !== false,
      msg: data.ok === false ? data.reason || "ROI repair blocked" : "ROI repair evaluated",
      data,
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN ROI RECOVERY REPAIR ERROR");
  }
});

/* ==============================
   📥 HYBRID DEPOSITS
============================== */
router.get("/overview", auth, isAdmin, async (req, res) => {
  try {
    const overview = await buildAdminOverview();
    return res.json({
      success: true,
      msg: "Overview",
      data: { overview },
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN OVERVIEW ERROR");
  }
});

router.get("/fraud-signals", auth, isAdmin, async (req, res) => {
  try {
    const signals = await buildFraudSignals();
    return res.json({
      success: true,
      msg: "Fraud signals",
      data: { signals },
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN FRAUD SIGNALS ERROR");
  }
});

router.get("/salary-payouts", auth, isAdmin, async (req, res) => {
  try {
    const page = req.query.page;
    const limit = req.query.limit;
    const search = req.query.search;
    const data = await salaryPayoutsPage({
      page,
      limit,
      search,
    });
    return res.json({
      success: true,
      msg: "Salary payouts",
      data,
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN SALARY PAYOUTS ERROR");
  }
});

router.get("/log-feed", auth, isAdmin, async (req, res) => {
  try {
    const type = String(req.query.type || "").toLowerCase();
    const allowed = ["admin", "withdraw", "deposit", "salary"];
    if (!allowed.includes(type)) {
      return res.status(400).json({
        success: false,
        msg: `type must be one of: ${allowed.join(", ")}`,
        data: null,
      });
    }
    const data = await logFeed({
      type,
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
      adminId: req.query.adminId,
      userId: req.query.userId,
      actionType: req.query.actionType,
    });
    return res.json({
      success: true,
      msg: "Log feed",
      data,
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN LOG FEED ERROR");
  }
});

router.get("/users/:id/detail", auth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        msg: "Invalid user id",
        data: null,
      });
    }
    const detail = await getUserAdminDetail(id);
    if (!detail) {
      return res.status(404).json({ success: false, msg: "User not found", data: null });
    }
    return res.json({
      success: true,
      msg: "User detail",
      data: detail,
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN USER DETAIL ERROR");
  }
});

router.post("/users/:id/fraud-flag", auth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid user id", data: null });
    }
    const note = String(reason || "").trim().slice(0, 500);
    if (!note) {
      return res.status(400).json({
        success: false,
        msg: "Reason is required to flag user",
        data: null,
      });
    }
    const user = await User.findByIdAndUpdate(
      id,
      { $set: { adminFraudFlag: true, adminFraudReason: note } },
      { new: true }
    ).select("username email adminFraudFlag adminFraudReason");
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found", data: null });
    }
    await writeAdminAudit({
      adminId: req.user._id,
      category: "fraud",
      action: "User flagged for fraud review",
      targetUserId: id,
      meta: { reason: note },
    });
    return res.json({
      success: true,
      msg: "User flagged",
      data: { user },
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN FRAUD FLAG ERROR");
  }
});

router.post("/users/:id/fraud-unflag", auth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid user id", data: null });
    }
    const unflagReason = String(reason || "").trim();
    if (!unflagReason) {
      return res.status(400).json({
        success: false,
        msg: "Reason is required to clear fraud flag",
        data: null,
      });
    }
    const user = await User.findByIdAndUpdate(
      id,
      { $set: { adminFraudFlag: false, adminFraudReason: "" } },
      { new: true }
    ).select("username email adminFraudFlag adminFraudReason");
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found", data: null });
    }
    await writeAdminAudit({
      adminId: req.user._id,
      category: "fraud",
      action: "Fraud flag cleared",
      targetUserId: id,
      meta: { reason: unflagReason.slice(0, 500) },
    });
    return res.json({
      success: true,
      msg: "Fraud flag cleared",
      data: { user },
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN FRAUD UNFLAG ERROR");
  }
});

router.post("/users/:id/financial-credit", auth, isAdmin, async (req, res) => {
  const idempotencyKey = String(req.headers["idempotency-key"] || "").trim();
  let idempotencyStarted = false;

  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid user id", data: null });
    }

    if (!idempotencyKey || idempotencyKey.length < 12 || idempotencyKey.length > 120) {
      return res.status(400).json({
        success: false,
        msg: "Idempotency-Key header is required",
        data: null,
      });
    }

    const body = req.body || {};
    const amount = parseAdminCreditAmount(body.amount);
    const category = String(body.category || "").trim().toLowerCase();
    const reason = String(body.reason || "").trim().slice(0, 500);
    const internalAdminNote = String(body.internalAdminNote || "").trim().slice(0, 1000);
    const actionType = String(body.actionType || "add_reward").trim().toLowerCase();

    if (!ADMIN_CREDIT_CATEGORIES.has(category)) {
      return res.status(400).json({
        success: false,
        msg: "Invalid credit category",
        data: null,
      });
    }

    if (!ADMIN_CREDIT_ACTIONS.has(actionType)) {
      return res.status(400).json({
        success: false,
        msg: "Invalid credit action",
        data: null,
      });
    }

    if (!reason) {
      return res.status(400).json({
        success: false,
        msg: "Reason is required",
        data: null,
      });
    }

    const perTransactionLimit = adminCreditLimitFromEnv("ADMIN_CREDIT_MAX_AMOUNT", 500);
    const dailyLimit = adminCreditLimitFromEnv("ADMIN_CREDIT_DAILY_MAX_AMOUNT", 2500);
    if (amount > perTransactionLimit) {
      return res.status(400).json({
        success: false,
        msg: `Amount exceeds per-transaction limit of ${perTransactionLimit} USDT`,
        data: null,
      });
    }

    const replay = await beginIdempotentAction(ADMIN_CREDIT_IDEMPOTENCY_TYPE, idempotencyKey);
    if (!replay.shouldProcess) {
      return res.json(replay.existing?.response || {
        success: true,
        msg: "Admin credit already processed",
        data: null,
      });
    }
    idempotencyStarted = true;

    const auditContext = getRequestAuditContext(req);
    const dayKey = getAdminCreditDayKey();
    let responsePayload = null;

    await runMongoTransaction("admin.financialCredit", async (session) => {
      const target = await User.findById(id)
        .select(
          "username email balance depositBalance rewardBalance totalEarnings isBlocked adminFraudFlag adminFraudReason"
        )
        .session(session);

      if (!target) {
        const err = new Error("User not found");
        err.statusCode = 404;
        throw err;
      }

      if (target.isBlocked) {
        const err = new Error("Blocked users cannot receive admin financial credits");
        err.statusCode = 400;
        throw err;
      }

      if (target.adminFraudFlag) {
        const err = new Error("Fraud-flagged users cannot receive admin financial credits");
        err.statusCode = 400;
        throw err;
      }

      const limitState = await consumeAdminCreditDailyLimit({
        adminId: req.user._id,
        amount,
        dailyLimit,
        dayKey,
        session,
      });

      const beforeDepositBalance = Number(target.depositBalance || 0);
      const beforeRewardBalance = Number(target.rewardBalance || 0);
      const beforeLegacyBalance = Number(target.balance || 0);
      const beforeSpendableBalance =
        beforeDepositBalance + beforeRewardBalance;
      const afterDepositBalance = roundCreditAmount(beforeDepositBalance + amount);
      const afterSpendableBalance = roundCreditAmount(beforeSpendableBalance + amount);
      const ledgerMeta = {
        type: "INTERNAL_ADMIN_CREDIT",
        transactionType: "INTERNAL_ADMIN_CREDIT",
        financialSourceType: "INTERNAL_ADMIN_CREDIT",
        sourceType: category,
        adminId: String(req.user._id),
        adminUsername: req.user.username || "admin",
        targetUsername: target.username,
        category,
        reason,
        internalAdminNote,
        actionType,
        beforeBalance: beforeSpendableBalance,
        afterBalance: afterSpendableBalance,
        beforeDepositBalance,
        afterDepositBalance,
        beforeRewardBalance,
        afterRewardBalance: beforeRewardBalance,
        beforeLegacyBalance,
        idempotencyKey,
        dailyLimit,
        dayKey,
        balanceBucket: "depositBalance",
        eligibility: {
          withdrawable: true,
          roiEligible: true,
          stakingEligible: true,
          referralTeamEligible: true,
        },
        createdBy: "admin_financial_control_center",
        ...auditContext,
      };

      const { ledgerEntry } = await creditActiveUsdtBalance({
        userId: target._id,
        amount,
        source: INTERNAL_ADMIN_CREDIT_SOURCE,
        referenceId: target._id,
        meta: ledgerMeta,
        session,
      });

      await syncUserLevel(target._id, session);
      const updated = await User.findById(target._id)
        .select("username email balance depositBalance rewardBalance totalEarnings level vipLevel")
        .session(session);
      const finalSpendableBalance = roundCreditAmount(
        Number(updated?.depositBalance || 0) + Number(updated?.rewardBalance || 0)
      );

      const auditMeta = {
        adminUsername: req.user.username || "admin",
        targetUsername: target.username,
        amount,
        oldBalance: beforeSpendableBalance,
        newBalance: finalSpendableBalance,
        postCreditBalance: afterSpendableBalance,
        oldDepositBalance: beforeDepositBalance,
        newDepositBalance: Number(updated.depositBalance || 0),
        oldRewardBalance: beforeRewardBalance,
        newRewardBalance: Number(updated.rewardBalance || 0),
        category,
        reason,
        internalAdminNote,
        actionType,
        financialSourceType: "INTERNAL_ADMIN_CREDIT",
        sourceType: category,
        balanceBucket: "depositBalance",
        ledgerId: String(ledgerEntry?._id || ""),
        idempotencyKey,
        dailyLimit,
        dailyAmountUsed: limitState.amountUsed,
        dailyRemaining: limitState.remaining,
        ...auditContext,
      };

      await AdminAuditLog.create(
        [
          {
            adminId: req.user._id,
            category: "financial",
            action: "Admin financial credit issued",
            targetUserId: target._id,
            meta: auditMeta,
          },
        ],
        { session }
      );

      responsePayload = {
        success: true,
        msg: "Admin financial credit applied",
        data: {
          credit: {
            ledgerId: String(ledgerEntry?._id || ""),
            transactionType: "INTERNAL_ADMIN_CREDIT",
            financialSourceType: "INTERNAL_ADMIN_CREDIT",
            amount,
            category,
            reason,
            oldBalance: beforeSpendableBalance,
            newBalance: finalSpendableBalance,
            postCreditBalance: afterSpendableBalance,
            oldDepositBalance: beforeDepositBalance,
            newDepositBalance: Number(updated.depositBalance || 0),
            oldRewardBalance: beforeRewardBalance,
            newRewardBalance: Number(updated.rewardBalance || 0),
            newAvailableUSDT: finalSpendableBalance,
            dailyRemaining: limitState.remaining,
          },
          user: updated,
        },
      };

      await completeIdempotency(
        ADMIN_CREDIT_IDEMPOTENCY_TYPE,
        idempotencyKey,
        responsePayload,
        session
      );
    });

    return res.json(responsePayload);
  } catch (err) {
    if (idempotencyStarted) {
      await failIdempotency(ADMIN_CREDIT_IDEMPOTENCY_TYPE, idempotencyKey, err).catch((auditErr) => {
        logger.error("ADMIN CREDIT IDEMPOTENCY FAIL ERROR", {
          error: auditErr?.message || String(auditErr),
        });
      });
    }
    return sendAdminError(res, err, "ADMIN FINANCIAL CREDIT ERROR");
  }
});

router.get("/deposits", auth, isAdmin, async (req, res) => {
  try {
    const q = {};
    const { from, to } = req.query || {};
    if (from || to) {
      q.createdAt = {};
      if (from) {
        const d = new Date(from);
        if (!Number.isNaN(d.getTime())) q.createdAt.$gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (!Number.isNaN(d.getTime())) q.createdAt.$lte = d;
      }
    }
    const limRaw = Number(req.query.limit);
    const lim = Math.min(Math.max(Number.isFinite(limRaw) ? limRaw : 2500, 1), 5000);

    const deposits = await HybridDeposit.find(q)
      .populate("userId", "username email")
      .sort({ createdAt: -1 })
      .limit(lim);
    const latestDeposits = deposits.map((d) => ({
      txHash: d.txHash,
      wallet: d.walletAddress,
      amount: d.amount,
      status: d.status,
      createdAt: d.createdAt,
    }));
    res.json({
      success: true,
      msg: "Deposits fetched successfully",
      data: { deposits, latestDeposits },
      deposits,
      latestDeposits,
    });
  } catch (err) {
    sendAdminError(res, err, "ADMIN DEPOSITS ERROR");
  }
});

router.get("/deposits/pending", auth, isAdmin, async (req, res) => {
  try {
    const deposits = await HybridDeposit.find({ status: { $in: ["credited", "swept"] } })
      .populate("userId", "username email")
      .sort({ createdAt: -1 });
    res.json({
      success: true,
      msg: "Credited hybrid deposits fetched successfully",
      data: { deposits },
      deposits,
    });
  } catch (err) {
    sendAdminError(res, err, "ADMIN PENDING DEPOSITS ERROR");
  }
});

/* ==============================
   💸 HYBRID WITHDRAWALS
============================== */
router.get("/withdrawals", auth, isAdmin, async (req, res) => {
  try {
    const rows = await HybridWithdrawal.find()
      .populate("userId", "username email")
      .sort({ priority: 1, riskScore: -1, createdAt: -1 });
    const withdrawals = normalizeHybridWithdrawRows(rows);
    res.json({
      success: true,
      msg: "Withdrawals fetched successfully",
      data: { withdrawals },
      withdrawals,
    });
  } catch (err) {
    sendAdminError(res, err, "ADMIN WITHDRAWALS ERROR");
  }
});

router.get("/withdrawals/pending", auth, isAdmin, async (req, res) => {
  try {
    const rows = await HybridWithdrawal.find({
      status: { $in: ["review", "pending", "claimable", "approved"] },
    })
      .populate("userId", "username email")
      .sort({ priority: 1, riskScore: -1, createdAt: -1 });
    const withdrawals = normalizeHybridWithdrawRows(rows);
    res.json({
      success: true,
      msg: "Pending withdrawals fetched successfully",
      data: { withdrawals },
      withdrawals,
    });
  } catch (err) {
    sendAdminError(res, err, "ADMIN PENDING WITHDRAWALS ERROR");
  }
});

router.post("/hybrid/withdraw/force/:id", auth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || String(id).trim() === "") {
      return res.status(400).json({ success: false, msg: "Invalid ID", data: {} });
    }
    const result = await adminForcePayoutHybridWithdrawal(id, req.user._id);
    await writeAdminAudit({
      adminId: req.user._id,
      category: "withdraw",
      action: "Hybrid withdrawal force payout",
      targetUserId: result?.withdrawal?.userId,
      meta: {
        withdrawalId: String(id),
        status: result?.withdrawal?.status,
        forcePayout: true,
        netAmount: result?.withdrawal?.netAmount,
        txHash: result?.txHash || result?.payout?.txHash || null,
      },
    });
    return res.json({
      success: true,
      msg: "Force payout completed",
      data: result,
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN HYBRID FORCE PAYOUT ERROR");
  }
});

router.post("/hybrid/withdraw/approve", auth, isAdmin, async (req, res) => {
  try {
    const { withdrawalId } = req.body || {};
    if (!withdrawalId || String(withdrawalId).trim() === "") {
      return res.status(400).json({ success: false, msg: "Invalid ID", data: {} });
    }
    const data = await adminApproveHybridWithdrawal(withdrawalId, req.user._id);
    await writeAdminAudit({
      adminId: req.user._id,
      category: "withdraw",
      action: "Withdrawal approved",
      targetUserId: data?.userId,
      meta: { withdrawalId: String(withdrawalId), status: data?.status, netAmount: data?.netAmount },
    });
    return res.json({ success: true, msg: "Withdrawal approved", data: { withdrawal: data } });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN WITHDRAW APPROVE ERROR");
  }
});

router.post("/hybrid/withdraw/pay", auth, isAdmin, async (req, res) => {
  return res.status(410).json({
    success: false,
    msg: "Manual payout is disabled; approved withdrawals are paid by the auto executor",
    data: null,
  });
});

router.post("/hybrid/withdraw/reject", auth, isAdmin, async (req, res) => {
  try {
    const { withdrawalId } = req.body || {};
    logger.info("Admin hybrid withdrawal reject requested", {
      adminId: String(req.user._id),
      withdrawalId,
    });
    if (!withdrawalId || String(withdrawalId).trim() === "") {
      return res.status(400).json({ success: false, msg: "Invalid ID", data: {} });
    }
    const data = await adminRejectHybridWithdrawal(withdrawalId);
    await writeAdminAudit({
      adminId: req.user._id,
      category: "withdraw",
      action: "Withdrawal rejected",
      targetUserId: data?.userId,
      meta: { withdrawalId: String(withdrawalId) },
    });
    return res.json({ success: true, msg: "Withdrawal rejected and refunded", data: { withdrawal: data } });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN WITHDRAW REJECT ERROR");
  }
});

router.post("/hybrid/withdraw/reject-all", auth, isAdmin, async (req, res) => {
  try {
    const result = await adminRejectAllHybridWithdrawals(req.user._id);
    await writeAdminAudit({
      adminId: req.user._id,
      category: "withdraw",
      action: "All eligible hybrid withdrawals rejected (bulk)",
      meta: { totalRejected: result?.totalRejected ?? 0 },
    });
    return res.json({
      success: true,
      msg: "All withdrawals rejected successfully",
      data: result,
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN WITHDRAW REJECT ALL ERROR");
  }
});

/** REST-style withdraw actions (same services as body-based hybrid routes) */
router.post("/withdraw/approve/:id", auth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || String(id).trim() === "") {
      return res.status(400).json({ success: false, msg: "Invalid ID", data: {} });
    }
    const data = await adminApproveHybridWithdrawal(id, req.user._id);
    await writeAdminAudit({
      adminId: req.user._id,
      category: "withdraw",
      action: "Withdrawal approved",
      targetUserId: data?.userId,
      meta: { withdrawalId: String(id), status: data?.status, netAmount: data?.netAmount },
    });
    return res.json({ success: true, msg: "Withdrawal approved", data: { withdrawal: data } });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN REST WITHDRAW APPROVE ERROR");
  }
});

router.post("/withdraw/reject/:id", auth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    logger.info("Admin withdrawal reject requested", {
      adminId: String(req.user._id),
      withdrawalId: id,
    });
    if (!id || String(id).trim() === "") {
      return res.status(400).json({ success: false, msg: "Invalid ID", data: {} });
    }
    const data = await adminRejectHybridWithdrawal(id);
    await writeAdminAudit({
      adminId: req.user._id,
      category: "withdraw",
      action: "Withdrawal rejected",
      targetUserId: data?.userId,
      meta: { withdrawalId: String(id) },
    });
    return res.json({ success: true, msg: "Withdrawal rejected and refunded", data: { withdrawal: data } });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN REST WITHDRAW REJECT ERROR");
  }
});

/* ==============================
   🔁 DEPOSIT RESCAN & RECOVERY
============================== */

/** Last-N-blocks backup sweep (admin trigger; duplicate-safe via listener) */
router.post("/recover-deposits", auth, isAdmin, async (req, res) => {
  try {
    logger.info("Admin triggered deposit recovery scan", {
      adminId: String(req.user._id),
      blocks: 1000,
    });
    const result = await scanHybridDeposits(null, null, {
      blocks: 1000,
      logEmptyOnZero: true,
    });
    logger.info("Admin deposit recovery scan completed", {
      adminId: String(req.user._id),
      processed: result?.processed ?? 0,
    });
    await writeAdminAudit({
      adminId: req.user._id,
      category: "admin",
      action: "Recovery scan triggered (recover-deposits)",
      meta: { processed: result?.processed ?? 0 },
    });
    return res.json({
      success: true,
      msg: "Recovery scan executed",
      data: result,
    });
  } catch (err) {
    logger.error("Admin deposit recovery scan failed", { error: err?.message || String(err) });
    return res.status(500).json({ success: false, msg: "Internal server error", data: null });
  }
});

router.post("/hybrid/deposit/scan", auth, isAdmin, async (req, res) => {
  return res.redirect(307, "/api/admin/recover-deposits");
});

/** Deep scan between explicit blocks (manual rescan) */
router.post("/rescan-deposits", auth, isAdmin, async (req, res) => {
  try {
    const { fromBlock, toBlock } = req.body || {};
    const fromN = Number(fromBlock);
    const toN = Number(toBlock);
    if (
      fromBlock === undefined ||
      fromBlock === null ||
      toBlock === undefined ||
      toBlock === null ||
      !Number.isFinite(fromN) ||
      !Number.isFinite(toN) ||
      fromN < 0 ||
      toN < 0 ||
      fromN > toN
    ) {
      return res.status(400).json({
        success: false,
        msg: "Valid fromBlock and toBlock (0 ≤ fromBlock ≤ toBlock) required",
        data: null,
      });
    }
    logger.info("Admin deposit deep rescan requested", {
      adminId: String(req.user._id),
      fromBlock: fromN,
      toBlock: toN,
    });
    const result = await scanHybridDeposits(fromN, toN, { isManualRescan: true });
    await writeAdminAudit({
      adminId: req.user._id,
      category: "admin",
      action: "Deep rescan deposits",
      meta: { fromBlock: fromN, toBlock: toN },
    });
    return res.json({
      success: true,
      msg: "Deep rescan completed",
      data: result,
    });
  } catch (err) {
    logger.error("Admin deposit deep rescan failed", { error: err?.message || String(err) });
    return res.status(500).json({ success: false, msg: "Internal server error", data: null });
  }
});

/** Resolve tx → block window and scan (±5 blocks) */
router.post("/recover-by-tx", auth, isAdmin, async (req, res) => {
  try {
    const { txHash } = req.body || {};
    const normalized = String(txHash || "").trim();
    if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
      return res.status(400).json({
        success: false,
        msg: "Valid txHash (0x + 64 hex chars) required",
        data: null,
      });
    }
    logger.info("Admin recover-by-tx resolving receipt", {
      adminId: String(req.user._id),
      txHashPartial: `${normalized.slice(0, 10)}…${normalized.slice(-6)}`,
    });
    const provider = getProvider();
    const receipt = await provider.getTransactionReceipt(normalized);
    if (!receipt) {
      return res.status(400).json({
        success: false,
        msg: "Transaction not found or not yet mined",
        data: null,
      });
    }
    const bn = Number(receipt.blockNumber);
    if (!Number.isFinite(bn)) {
      return res.status(400).json({
        success: false,
        msg: "Invalid block number on receipt",
        data: null,
      });
    }
    const fromBlk = Math.max(0, bn - 5);
    const toBlk = bn + 5;
    logger.info("Admin recover-by-tx scan range resolved", {
      adminId: String(req.user._id),
      fromBlock: fromBlk,
      toBlock: toBlk,
    });
    const result = await scanHybridDeposits(fromBlk, toBlk, { isManualRescan: true });
    await writeAdminAudit({
      adminId: req.user._id,
      category: "admin",
      action: "Recover deposit by TX",
      meta: { txHashNormalized: normalized.slice(0, 12) + "…" },
    });
    return res.json({
      success: true,
      msg: "Recover by TX completed",
      data: { ...result, blockNumber: bn },
    });
  } catch (err) {
    logger.error("Admin recover-by-tx failed", { error: err?.message || String(err) });
    return res.status(500).json({ success: false, msg: "Internal server error", data: null });
  }
});

/* ==============================
   👤 USER MANAGEMENT
============================== */

// 📄 all users
router.get("/users", auth, isAdmin, async (req, res) => {
  try {
    const page = toPositivePage(req.query.page);
    const limit = toAdminUsersLimit(req.query.limit);
    const skip = (page - 1) * limit;
    const filter = String(req.query.filter || "newest").trim().toLowerCase();
    const search = String(req.query.search || "").trim().slice(0, 80);
    const minAvailable = Number(req.query.minAvailable || 0);
    const match = {};

    if (search.length >= 2) {
      const rx = new RegExp(`^${escapeRegex(search.toLowerCase())}`);
      match.$or = [
        { username: rx },
        { email: rx },
        { walletAddress: rx },
      ];
    }

    if (filter === "blocked") {
      match.isBlocked = true;
    } else if (filter === "admin_users") {
      match.isAdmin = true;
    } else if (filter === "pending_withdrawals") {
      match.pendingWithdraw = { $gt: 0 };
    } else if (filter === "active_earnings") {
      match.totalEarnings = { $gt: 0 };
    } else if (filter === "admin_rewards") {
      const adminRewardUserIds = await HybridLedger.distinct("userId", {
        source: { $in: ADMIN_CREDIT_LEDGER_SOURCES },
        entryType: "credit",
        balanceType: { $in: ["rewardBalance", "depositBalance"] },
      });
      match._id = adminRewardUserIds.length ? { $in: adminRewardUserIds } : { $in: [] };
    }

    const pipeline = [
      {
        $addFields: {
          availableUSDT: {
            $add: [
              { $ifNull: ["$depositBalance", 0] },
              { $ifNull: ["$rewardBalance", 0] },
            ],
          },
        },
      },
    ];

    if (Number.isFinite(minAvailable) && minAvailable > 0) {
      match.availableUSDT = { $gte: minAvailable };
    }

    if (Object.keys(match).length) {
      pipeline.push({ $match: match });
    }

    pipeline.push({
      $facet: {
        users: [
          { $sort: getAdminUsersSort(filter) },
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              password: 0,
              privateKey: 0,
              depositAddress: 0,
              normalizedAddress: 0,
              trialSourceIp: 0,
            },
          },
        ],
        total: [{ $count: "count" }],
      },
    });

    const [pageResult = {}] = await User.aggregate(pipeline);
    const rawUsers = pageResult.users || [];
    const total = Number(pageResult.total?.[0]?.count || 0);
    const userIds = rawUsers.map((u) => u._id).filter(Boolean);

    const ledgerBreakdownRows = userIds.length
      ? await HybridLedger.aggregate([
          {
            $match: {
              userId: { $in: userIds },
              entryType: "credit",
              balanceType: { $in: ["rewardBalance", "depositBalance"] },
              source: { $in: ADMIN_USER_EARNING_SOURCES },
            },
          },
          {
            $group: {
              _id: { userId: "$userId", source: "$source" },
              amount: { $sum: "$amount" },
            },
          },
        ])
      : [];

    const breakdownByUser = new Map();
    for (const row of ledgerBreakdownRows) {
      const userId = String(row?._id?.userId || "");
      const source = String(row?._id?.source || "");
      if (!userId || !source) continue;
      const amount = roundFinancialAmount(row.amount);
      const current = breakdownByUser.get(userId) || {
        roiEarnings: 0,
        teamEarnings: 0,
        adminCredits: 0,
        stakingRewards: 0,
        bonusRewards: 0,
        activeCreditedEarnings: 0,
      };

      current.activeCreditedEarnings = roundFinancialAmount(current.activeCreditedEarnings + amount);
      if (source === "roi_claim") current.roiEarnings = roundFinancialAmount(current.roiEarnings + amount);
      if (TEAM_EARNING_SOURCES.has(source)) {
        current.teamEarnings = roundFinancialAmount(current.teamEarnings + amount);
      }
      if (ADMIN_CREDIT_LEDGER_SOURCES.includes(source)) {
        current.adminCredits = roundFinancialAmount(current.adminCredits + amount);
      }
      if (source === "stake_claim") {
        current.stakingRewards = roundFinancialAmount(current.stakingRewards + amount);
      }
      if (BONUS_EARNING_SOURCES.has(source)) {
        current.bonusRewards = roundFinancialAmount(current.bonusRewards + amount);
      }
      breakdownByUser.set(userId, current);
    }

    const users = rawUsers.map((u) => {
      const breakdown = breakdownByUser.get(String(u._id)) || {
        roiEarnings: 0,
        teamEarnings: 0,
        adminCredits: 0,
        stakingRewards: 0,
        bonusRewards: 0,
        activeCreditedEarnings: 0,
      };
      const availableUSDT = roundFinancialAmount(getSpendableHybridBalance(u));
      return {
        _id: u._id,
        username: u.username,
        email: u.email,
        walletPreview: maskWalletAddress(u.walletAddress),
        depositBalance: roundFinancialAmount(u.depositBalance),
        rewardBalance: roundFinancialAmount(u.rewardBalance),
        availableUSDT,
        pendingWithdraw: roundFinancialAmount(u.pendingWithdraw),
        totalEarnings: roundFinancialAmount(u.totalEarnings),
        referralEarnings: roundFinancialAmount(u.referralEarnings),
        totalInvested: roundFinancialAmount(u.totalInvested),
        totalWithdraw: roundFinancialAmount(u.totalWithdraw),
        teamVolume: roundFinancialAmount(u.teamVolume),
        vipLevel: Number(u.vipLevel || 0),
        isAdmin: Boolean(u.isAdmin),
        isBlocked: Boolean(u.isBlocked),
        adminFraudFlag: Boolean(u.adminFraudFlag),
        adminFraudReason: u.adminFraudReason || "",
        lastLogin: u.lastLogin || null,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        financial: breakdown,
      };
    });

    const [summary = {}] = await User.aggregate([
      {
        $group: {
          _id: null,
          userCount: { $sum: 1 },
          totalAvailableUSDT: {
            $sum: {
              $add: [
                { $ifNull: ["$depositBalance", 0] },
                { $ifNull: ["$rewardBalance", 0] },
              ],
            },
          },
          totalPendingWithdraw: { $sum: { $ifNull: ["$pendingWithdraw", 0] } },
          activeEarningUsers: {
            $sum: {
              $cond: [{ $gt: [{ $ifNull: ["$totalEarnings", 0] }, 0] }, 1, 0],
            },
          },
          blockedUsers: {
            $sum: { $cond: [{ $eq: ["$isBlocked", true] }, 1, 0] },
          },
          adminUsers: {
            $sum: { $cond: [{ $eq: ["$isAdmin", true] }, 1, 0] },
          },
        },
      },
    ]);

    const userSummaries = users.map((u) => ({
      _id: u._id,
      username: u.username,
      wallet: u.walletPreview,
      depositBalance: u.depositBalance,
      rewardBalance: u.rewardBalance,
      availableUSDT: u.availableUSDT,
      totalEarned: u.totalEarnings,
      vipLevel: u.vipLevel,
    }));

    return res.json({
      success: true,
      msg: "Users fetched",
      data: {
        users,
        userSummaries,
        total,
        page,
        pageSize: limit,
        pollingMs: ADMIN_USERS_POLL_MS,
        updatedAt: new Date().toISOString(),
        summary: {
          userCount: Number(summary.userCount || 0),
          totalAvailableUSDT: roundFinancialAmount(summary.totalAvailableUSDT),
          totalPendingWithdraw: roundFinancialAmount(summary.totalPendingWithdraw),
          activeEarningUsers: Number(summary.activeEarningUsers || 0),
          blockedUsers: Number(summary.blockedUsers || 0),
          adminUsers: Number(summary.adminUsers || 0),
        },
      },
      users,
      userSummaries,
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN USERS ERROR");
  }
});

router.post("/set-vip", auth, isAdmin, async (req, res) => {
  try {
    const { userId, vipLevel } = req.body || {};
    const id = String(userId || "").trim();
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        msg: "Valid userId required",
        data: null,
      });
    }
    const level = Number(vipLevel);
    if (!Number.isFinite(level) || level < 0) {
      return res.status(400).json({
        success: false,
        msg: "vipLevel must be a non-negative number",
        data: null,
      });
    }
    const nextLevel = Math.floor(level);
    const user = await User.findByIdAndUpdate(
      id,
      { $set: { vipLevel: nextLevel, level: nextLevel } },
      { new: true }
    ).select("-password");
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found", data: null });
    }
    logger.info("Admin VIP level updated", {
      adminId: String(req.user._id),
      userId: id,
      vipLevel: nextLevel,
    });
    await writeAdminAudit({
      adminId: req.user._id,
      category: "admin",
      action: `VIP set to ${nextLevel}`,
      targetUserId: id,
      meta: { vipLevel: nextLevel, level: nextLevel },
    });
    return res.json({
      success: true,
      msg: "VIP level updated",
      data: { user },
    });
  } catch (err) {
    return sendAdminError(res, err, "ADMIN SET VIP ERROR");
  }
});

// 🔒 block
router.post("/block/:id", auth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || String(id).trim() === "") {
      return res.status(400).json({ success: false, msg: "Invalid ID", data: {} });
    }

    const user = await User.findByIdAndUpdate(req.params.id, { isBlocked: true }, { new: true });
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found", data: null });
    }
    await writeAdminAudit({
      adminId: req.user._id,
      category: "user",
      action: "User blocked",
      targetUserId: id,
      meta: {},
    });
    res.json({ success: true, msg: "User blocked", data: null });
  } catch (err) {
    sendAdminError(res, err, "ADMIN BLOCK ERROR");
  }
});

// 🔓 unblock
router.post("/unblock/:id", auth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || String(id).trim() === "") {
      return res.status(400).json({ success: false, msg: "Invalid ID", data: {} });
    }

    const user = await User.findByIdAndUpdate(req.params.id, { isBlocked: false }, { new: true });
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found", data: null });
    }
    await writeAdminAudit({
      adminId: req.user._id,
      category: "user",
      action: "User unblocked",
      targetUserId: id,
      meta: {},
    });
    res.json({ success: true, msg: "User unblocked", data: null });
  } catch (err) {
    sendAdminError(res, err, "ADMIN UNBLOCK ERROR");
  }
});

// 💰 reset wallet (dangerous → admin only)
router.post("/reset-wallet/:id", auth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || String(id).trim() === "") {
      return res.status(400).json({ success: false, msg: "Invalid ID", data: {} });
    }

    let user = null;
    let beforeBalances = null;

    await runMongoTransaction("admin.resetWallet", async (session) => {
      const existing = await User.findById(req.params.id)
        .select("balance totalEarnings totalWithdraw depositBalance rewardBalance pendingWithdraw")
        .session(session);

      if (!existing) {
        return;
      }

      beforeBalances = {
        balance: Number(existing.balance || 0),
        totalEarnings: Number(existing.totalEarnings || 0),
        totalWithdraw: Number(existing.totalWithdraw || 0),
        depositBalance: Number(existing.depositBalance || 0),
        rewardBalance: Number(existing.rewardBalance || 0),
        pendingWithdraw: Number(existing.pendingWithdraw || 0),
      };

      const ledgerEntries = [];
      if (beforeBalances.balance > 0) {
        ledgerEntries.push({
          userId: existing._id,
          entryType: "debit",
          balanceType: "balance",
          amount: beforeBalances.balance,
          source: "admin_reset",
          referenceId: existing._id,
          meta: { adminId: String(req.user._id) },
        });
      }
      if (beforeBalances.depositBalance > 0) {
        ledgerEntries.push({
          userId: existing._id,
          entryType: "debit",
          balanceType: "depositBalance",
          amount: beforeBalances.depositBalance,
          source: "admin_reset",
          referenceId: existing._id,
          meta: { adminId: String(req.user._id) },
        });
      }
      if (beforeBalances.rewardBalance > 0) {
        ledgerEntries.push({
          userId: existing._id,
          entryType: "debit",
          balanceType: "rewardBalance",
          amount: beforeBalances.rewardBalance,
          source: "admin_reset",
          referenceId: existing._id,
          meta: { adminId: String(req.user._id) },
        });
      }
      if (beforeBalances.pendingWithdraw > 0) {
        ledgerEntries.push({
          userId: existing._id,
          entryType: "debit",
          balanceType: "pendingWithdraw",
          amount: beforeBalances.pendingWithdraw,
          source: "admin_reset",
          referenceId: existing._id,
          meta: { adminId: String(req.user._id) },
        });
      }

      await addHybridLedgerEntries(ledgerEntries, session);

      user = await User.findByIdAndUpdate(
        req.params.id,
        {
          $inc: {
            balance: -beforeBalances.balance,
            depositBalance: -beforeBalances.depositBalance,
            rewardBalance: -beforeBalances.rewardBalance,
            pendingWithdraw: -beforeBalances.pendingWithdraw,
          },
        },
        { new: true, session }
      );
    });

    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found", data: null });
    }
    await writeAdminAudit({
      adminId: req.user._id,
      category: "admin",
      action: "Wallet reset by admin with ledger adjustment",
      targetUserId: id,
      meta: { beforeBalances },
    });
    res.json({ success: true, msg: "Wallet reset", data: null });
  } catch (err) {
    sendAdminError(res, err, "ADMIN RESET WALLET ERROR");
  }
});

/* ==============================
   📊 ADMIN STATS
============================== */
router.get("/stats", auth, isAdmin, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalDeposits = await HybridDeposit.countDocuments({
      status: { $in: ["credited", "swept"] },
    });
    const totalWithdrawals = await HybridWithdrawal.countDocuments({ status: "paid" });

    const users = await User.find();

    let totalBalance = 0;
    let totalEarnings = 0;

    users.forEach((u) => {
      totalBalance += u.balance;
      totalEarnings += u.totalEarnings;
    });

    const statsPayload = {
      totalUsers,
      totalDeposits,
      totalWithdrawals,
      totalBalance,
      totalEarnings,
    };

    res.json({
      success: true,
      msg: "Stats fetched",
      data: { stats: statsPayload },
      stats: statsPayload,
    });
  } catch (err) {
    sendAdminError(res, err, "ADMIN STATS ERROR");
  }
});

export default router;
