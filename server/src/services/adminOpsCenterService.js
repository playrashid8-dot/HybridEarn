import os from "os";
import mongoose from "mongoose";
import User from "../models/User.js";
import HybridDeposit from "../hybrid/models/HybridDeposit.js";
import HybridWithdrawal from "../hybrid/models/HybridWithdrawal.js";
import AdminAuditLog from "../models/AdminAuditLog.js";
import { depositQueue } from "../queues/depositQueue.js";
import { payoutQueue } from "../queues/payoutQueue.js";
import { getSystemHealth } from "../hybrid/utils/systemHealth.js";
import { getAdminDashboardSystemStatus } from "../hybrid/utils/adminSystemStatus.js";
import { getHybridWithdrawExecutorStatus } from "../hybrid/engine/index.js";
import { getMongoTopologyDiagnostics } from "../config/mongoTransactions.js";

const QUEUE_STATES = [
  "waiting",
  "active",
  "delayed",
  "completed",
  "failed",
  "paused",
  "prioritized",
  "waiting-children",
];

const money = (value) => Number(Number(value || 0).toFixed(6));

function summarizeJob(job) {
  return {
    id: String(job?.id || ""),
    name: String(job?.name || "unknown"),
    attemptsMade: Number(job?.attemptsMade || 0),
    failedReason: job?.failedReason || null,
    timestamp: job?.timestamp || null,
    processedOn: job?.processedOn || null,
    finishedOn: job?.finishedOn || null,
    progress: job?.progress ?? null,
    payloadPreview: job?.data && typeof job.data === "object" ? Object.keys(job.data).slice(0, 8) : [],
  };
}

function extractRpcLatencyMs(rpcDetails) {
  const endpoints = rpcDetails?.endpoints;
  const rows = Array.isArray(endpoints) ? endpoints : Object.values(endpoints || {});
  const latencies = rows
    .map((row) => Number(row?.latencyMs ?? row?.lastLatencyMs ?? row?.responseMs))
    .filter((value) => Number.isFinite(value) && value >= 0);

  if (latencies.length === 0) return null;
  return Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length);
}

function statusRows(rows = []) {
  return rows.reduce((acc, row) => {
    const key = row?._id || "unknown";
    acc[key] = {
      count: Number(row?.count || 0),
      amount: money(row?.amount || 0),
    };
    return acc;
  }, {});
}

async function getBullQueueSnapshot(label, queue, jobName = null) {
  if (!queue) {
    return {
      label,
      ok: false,
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
      stalled: 0,
      deadLetter: 0,
      retryAttempts: 0,
      note: "BullMQ queue is not available in this process",
    };
  }

  try {
    const counts = await queue.getJobCounts(...QUEUE_STATES);
    let retryAttempts = 0;
    let sampledFailedJobs = 0;
    let failedJobsPreview = [];

    try {
      const failedJobs = await queue.getFailed(0, 24);
      const relevant = jobName ? failedJobs.filter((job) => job?.name === jobName) : failedJobs;
      sampledFailedJobs = relevant.length;
      retryAttempts = relevant.reduce((sum, job) => sum + Number(job?.attemptsMade || 0), 0);
      failedJobsPreview = relevant.slice(0, 8).map(summarizeJob);
    } catch {
      retryAttempts = 0;
    }

    return {
      label,
      ok: true,
      waiting: Number(counts.waiting || 0),
      active: Number(counts.active || 0),
      delayed: Number(counts.delayed || 0),
      completed: Number(counts.completed || 0),
      failed: Number(counts.failed || 0),
      stalled: 0,
      deadLetter: Number(counts.failed || 0),
      retryAttempts,
      sampledFailedJobs,
      failedJobsPreview,
      sharedJobName: jobName,
      note: jobName
        ? `Shares this BullMQ queue; counts are queue-level and retry sample is filtered to ${jobName}`
        : undefined,
    };
  } catch (err) {
    return {
      label,
      ok: false,
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
      stalled: 0,
      deadLetter: 0,
      retryAttempts: 0,
      error: err?.message || "Queue unavailable",
    };
  }
}

function buildOperationalAlerts({ system, status, financial, queues }) {
  const alerts = [];
  const add = (severity, title, detail) => alerts.push({ severity, title, detail });

  if (!status?.mongo) add("critical", "MongoDB degraded", "Database connection is not healthy.");
  if (!status?.redis) add("critical", "Redis degraded", "BullMQ orchestration may be unavailable.");
  if (!status?.rpc) add("critical", "RPC degraded", "Blockchain reads are failing or timing out.");
  if (status?.fallbackModeHealthy) {
    add("info", "JSON-RPC polling fallback active", "WebSocket is disabled or unavailable, but polling mode is healthy.");
  } else if (!status?.listener && !status?.pollingActive) {
    add("warning", "Deposit listener inactive", "No active websocket listener or polling fallback was reported.");
  }
  if (!system?.worker?.alive) add("warning", "Deposit worker heartbeat stale", "Deposit queue processing heartbeat is missing or stale.");
  if (!system?.payoutWorker?.alive) add("warning", "Payout worker heartbeat stale", "Payout queue processing heartbeat is missing or stale.");
  if (Number(system?.blockedPayouts || 0) > 0) {
    add("critical", "Blocked payouts require review", `${system.blockedPayouts} payout(s) are blocked by safety controls.`);
  }
  for (const queue of Object.values(queues || {})) {
    if (Number(queue?.failed || 0) > 0) {
      add("warning", `${queue.label} has failed jobs`, `${queue.failed} failed job(s), ${queue.retryAttempts || 0} sampled attempts.`);
    }
  }
  if (Number(financial?.payoutExposure || 0) > Number(financial?.pendingLiabilities || 0) && Number(financial?.payoutExposure || 0) > 0) {
    add("warning", "Payout exposure exceeds pending liability", "Review withdrawal queue and balance snapshots before manual intervention.");
  }

  return alerts.slice(0, 12);
}

async function buildRealtimeEventFeed() {
  const [deposits, withdrawals, audits] = await Promise.all([
    HybridDeposit.find()
      .populate("userId", "username email")
      .sort({ createdAt: -1 })
      .limit(8)
      .lean(),
    HybridWithdrawal.find()
      .populate("userId", "username email")
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(8)
      .lean(),
    AdminAuditLog.find()
      .populate("adminId", "username email")
      .populate("targetUserId", "username email")
      .sort({ createdAt: -1 })
      .limit(8)
      .lean(),
  ]);

  const events = [
    ...deposits.map((deposit) => ({
      id: `deposit:${deposit._id}`,
      type: `deposit_${deposit.status}`,
      title: `Deposit ${deposit.status}`,
      user: deposit.userId?.username || deposit.userId?.email || "unknown",
      amount: money(deposit.amount),
      txHash: deposit.txHash || null,
      at: deposit.updatedAt || deposit.createdAt,
    })),
    ...withdrawals.map((withdrawal) => ({
      id: `withdrawal:${withdrawal._id}`,
      type: `withdrawal_${withdrawal.status}`,
      title: `Withdrawal ${withdrawal.status}`,
      user: withdrawal.userId?.username || withdrawal.userId?.email || "unknown",
      amount: money(withdrawal.netAmount),
      txHash: withdrawal.txHash || null,
      at: withdrawal.updatedAt || withdrawal.createdAt,
    })),
    ...audits.map((audit) => ({
      id: `audit:${audit._id}`,
      type: "admin_action",
      title: audit.action,
      user: audit.targetUserId?.username || audit.targetUserId?.email || audit.adminId?.username || "admin",
      category: audit.category,
      at: audit.createdAt,
    })),
  ];

  return events
    .filter((event) => event.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 20);
}

async function buildFinancialOverview() {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const [
    balanceAgg,
    depositStatusAgg,
    withdrawalStatusAgg,
    inflowAgg,
    outflowAgg,
    pendingDeposits,
    pendingWithdrawals,
  ] = await Promise.all([
    User.aggregate([
      {
        $group: {
          _id: null,
          depositBalance: { $sum: "$depositBalance" },
          rewardBalance: { $sum: "$rewardBalance" },
          pendingWithdraw: { $sum: "$pendingWithdraw" },
          legacyBalance: { $sum: "$balance" },
          totalEarnings: { $sum: "$totalEarnings" },
          totalWithdraw: { $sum: "$totalWithdraw" },
        },
      },
    ]),
    HybridDeposit.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          amount: { $sum: "$amount" },
        },
      },
    ]),
    HybridWithdrawal.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          amount: { $sum: "$netAmount" },
        },
      },
    ]),
    HybridDeposit.aggregate([
      { $match: { createdAt: { $gte: oneHourAgo }, status: { $in: ["credited", "swept"] } } },
      { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
    HybridWithdrawal.aggregate([
      { $match: { paidAt: { $gte: oneHourAgo }, status: "paid" } },
      { $group: { _id: null, amount: { $sum: "$netAmount" }, count: { $sum: 1 } } },
    ]),
    HybridDeposit.countDocuments({ status: { $in: ["detected"] } }),
    HybridWithdrawal.countDocuments({ status: { $in: ["review", "pending", "claimable", "approved"] } }),
  ]);

  const balances = balanceAgg[0] || {};
  const depositsByStatus = statusRows(depositStatusAgg);
  const withdrawalsByStatus = statusRows(withdrawalStatusAgg);
  const totalDeposits =
    Number(depositsByStatus.credited?.amount || 0) + Number(depositsByStatus.swept?.amount || 0);
  const totalWithdrawals = Number(withdrawalsByStatus.paid?.amount || 0);
  const payoutExposure =
    Number(withdrawalsByStatus.approved?.amount || 0) +
    Number(withdrawalsByStatus.claimable?.amount || 0) +
    Number(withdrawalsByStatus.pending?.amount || 0) +
    Number(withdrawalsByStatus.review?.amount || 0);

  return {
    totalDeposits: money(totalDeposits),
    totalWithdrawals: money(totalWithdrawals),
    pendingLiabilities: money(balances.pendingWithdraw),
    payoutExposure: money(payoutExposure),
    pendingWithdrawals,
    pendingDeposits,
    realtimeInflow: money(inflowAgg[0]?.amount || 0),
    realtimeOutflow: money(outflowAgg[0]?.amount || 0),
    userBalances: {
      depositBalance: money(balances.depositBalance),
      rewardBalance: money(balances.rewardBalance),
      pendingWithdraw: money(balances.pendingWithdraw),
      legacyBalance: money(balances.legacyBalance),
      totalEarnings: money(balances.totalEarnings),
      totalWithdraw: money(balances.totalWithdraw),
    },
    depositsByStatus,
    withdrawalsByStatus,
  };
}

function buildRuntimeSafetyMap(system, status) {
  const pollingFallbackHealthy = Boolean(
    system?.realtime?.fallbackModeHealthy || status?.fallbackModeHealthy
  );
  const websocketDisabled = Boolean(
    system?.realtime?.websocketIntentionallyDisabled || status?.websocketIntentionallyDisabled
  );

  return {
    depositListener: pollingFallbackHealthy
      ? "ACTIVE - JSON-RPC POLLING FALLBACK"
      : status?.listener
        ? "ACTIVE"
        : "DEGRADED",
    websocketMode: websocketDisabled ? "DISABLED INTENTIONALLY" : status?.websocket ? "ACTIVE" : "INACTIVE",
    pollingMode: pollingFallbackHealthy ? "ACTIVE - HEALTHY" : status?.pollingActive ? "ACTIVE" : "INACTIVE",
    mongoTransactions:
      getMongoTopologyDiagnostics().topologyType === "Single"
        ? "DEGRADED - standalone MongoDB, multi-document transactions unavailable"
        : "TRANSACTION CAPABLE",
    payoutExecutor: status?.executorRunning ? "RUNNING" : "NOT RUNNING IN THIS PROCESS",
    depositWorker: system?.worker?.alive ? "HEARTBEAT OK" : "HEARTBEAT MISSING OR STALE",
    payoutWorker: system?.payoutWorker?.alive ? "HEARTBEAT OK" : "HEARTBEAT MISSING OR STALE",
    duplicateProtections: [
      "HybridDeposit.txHash unique",
      "HybridWithdrawal.txHash partial unique",
      "deposit BullMQ jobId = txHash",
      "withdraw idempotency key per user",
      "payout idempotency records",
      "ROI queue deterministic jobId",
    ],
    replayProtections: [
      "deposit tx lock",
      "duplicate ledger/deposit checks",
      "payout nonce reconciliation",
      "payout wallet mutex",
      "safe ROI recovery refuses active locked jobs",
    ],
    treasuryIsolation: [
      "deposit hot wallets",
      "gas funder key",
      "payout signer key",
      "sweep destination wallet",
    ],
  };
}

export async function buildAdminOpsCenterSnapshot() {
  const [system, status, financial, depositQueueSnapshot, payoutQueueSnapshot, roiQueueSnapshot, events] =
    await Promise.all([
      getSystemHealth(),
      getAdminDashboardSystemStatus(),
      buildFinancialOverview(),
      getBullQueueSnapshot("deposit queue", depositQueue),
      getBullQueueSnapshot("payout queue", payoutQueue, "withdraw_batch"),
      getBullQueueSnapshot("ROI queue", payoutQueue, "roi_claim"),
      buildRealtimeEventFeed(),
    ]);

  const memory = process.memoryUsage();
  const loadAvg = os.loadavg?.() || [0, 0, 0];
  const runtime = {
    uptime: process.uptime(),
    memory: {
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
    },
    cpu: {
      loadAvg1m: Number(loadAvg[0] || 0),
      loadAvg5m: Number(loadAvg[1] || 0),
      cores: os.cpus?.().length || null,
    },
    mongo: getMongoTopologyDiagnostics(),
    mongooseReadyState: mongoose.connection.readyState,
  };

  const queues = {
    payout: payoutQueueSnapshot,
    deposit: depositQueueSnapshot,
    roi: roiQueueSnapshot,
    sweep: {
      label: "sweep runtime",
      ok: true,
      waiting: 0,
      active: Number(system.pendingSweeps || 0),
      delayed: 0,
      completed: 0,
      failed: 0,
      stalled: 0,
      deadLetter: 0,
      retryAttempts: 0,
      note: "Sweep is timer/runtime driven, not a BullMQ queue",
    },
    recovery: {
      label: "recovery runtime",
      ok: !system.recovery?.warning,
      waiting: 0,
      active: system.recovery?.active ? 1 : 0,
      delayed: 0,
      completed: 0,
      failed: system.recovery?.warning ? 1 : 0,
      stalled: 0,
      deadLetter: 0,
      retryAttempts: 0,
      note: "Recovery scans are runtime intervals and admin-triggered scans",
    },
  };

  return {
    generatedAt: new Date().toISOString(),
    status: system.status,
    health: {
      mongo: Boolean(status.mongo),
      redis: Boolean(status.redis),
      bullmq: Boolean(depositQueueSnapshot.ok || payoutQueueSnapshot.ok),
      queueConnectivity: Boolean(status.queue),
      rpc: Boolean(status.rpc),
      rpcDetails: system.rpc,
      rpcLatencyMs: extractRpcLatencyMs(system.rpc),
      websocketMode: status.websocketIntentionallyDisabled ? "disabled-intentionally" : status.websocket ? "active" : "inactive",
      pollingMode: status.fallbackModeHealthy ? "active-json-rpc-fallback" : status.pollingActive ? "active" : "inactive",
      depositListener: status.fallbackModeHealthy
        ? "ACTIVE - JSON-RPC POLLING FALLBACK"
        : status.realtimeHealthy
          ? "ACTIVE"
          : "DEGRADED",
      payoutWorker: Boolean(system.payoutWorker?.alive),
      depositWorker: Boolean(system.worker?.alive || status.worker),
      treasurySweep: system.pendingSweeps == null ? "not-reported" : "reported",
      recoveryWorker: system.recovery?.warning ? "degraded" : "healthy",
      queueHeartbeat: {
        depositAgeMs: system.workerHeartbeatAgeMs ?? null,
        payoutAgeMs: system.payoutWorker?.heartbeatAgeMs ?? null,
      },
      api: "healthy",
    },
    queues,
    financial,
    treasury: {
      treasuryUsdt: null,
      treasuryBnb: null,
      gasReserves: null,
      pendingLiabilities: financial.pendingLiabilities,
      payoutExposure: financial.payoutExposure,
      hotWalletHealth: system.executor?.enabled ? "configured" : "payout signer not fully configured",
      note: "On-chain treasury balances are intentionally not read here until a read-only treasury endpoint is wired to safe public addresses.",
    },
    runtime,
    executor: {
      ...getHybridWithdrawExecutorStatus(),
      reportedRunning: Boolean(status.executorRunning),
      failedPayouts: system.failedPayouts,
      blockedPayouts: system.blockedPayouts,
      approvedQueue: system.executor?.approvedQueue ?? null,
    },
    alerts: buildOperationalAlerts({ system, status, financial, queues }),
    events,
    safety: buildRuntimeSafetyMap(system, status),
  };
}
