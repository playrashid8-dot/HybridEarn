import mongoose from "mongoose";
import { getReadyRedis } from "../../config/redis.js";
import { depositQueue } from "../../queues/depositQueue.js";
import { checkRpcHealth, getRpcHealthSnapshot } from "./provider.js";
import PendingDeposit from "../models/PendingDeposit.js";
import HybridWithdrawal from "../models/HybridWithdrawal.js";
import HybridSetting from "../models/HybridSetting.js";
import { getHybridWithdrawExecutorStatus } from "../engine/index.js";
import { getDepositRecoveryHealth } from "../services/depositBackfill.js";
import {
  HYBRID_SETTING_LAST_RECOVERY_BLOCK,
  HYBRID_SETTING_LAST_RECOVERY_FINISHED_AT,
  HYBRID_SETTING_LAST_RECOVERY_STARTED_AT,
} from "../services/depositBackfill.js";
import { getPollingDepositClusterStatus } from "../services/pollingDepositEngine.js";
import depositPipelineConfig from "../../config/depositPipelineConfig.js";
import { isHybridEarnEnabled } from "./hybridEarnEnv.js";
import { WORKER_HEARTBEAT_KEY, PAYOUT_WORKER_HEARTBEAT_KEY } from "../../queues/workerSignals.js";
import { payoutQueue } from "../../queues/payoutQueue.js";
import { getProcessLifecycleStatus } from "../../infra/processLifecycle.js";
import logger from "../../utils/logger.js";
import { payoutObservabilitySnapshot } from "./payoutObservability.js";
import {
  HYBRID_SETTING_LAST_PROCESSED_DEPOSIT_AT,
  HYBRID_SETTING_LAST_PROCESSED_DEPOSIT_TX,
} from "./depositTelemetry.js";

const WORKER_HEARTBEAT_MAX_AGE_MS = 120000;
/** Stricter “worker responding” signal for ops (nested `worker.alive`). */
const WORKER_ALIVE_MAX_AGE_MS = 60000;
/** Deposit reliability: heartbeat must be newer than this (ms). Same as WORKER_ALIVE_MAX_AGE_MS. */
const WORKER_RELIABILITY_MAX_AGE_MS = WORKER_ALIVE_MAX_AGE_MS;
/** Warn when `hybridLastDetectedTxAt` is olderMs than this (deposit silence). */
const DEPOSIT_DETECTION_STALE_MS = Number(
  process.env.DEPOSIT_DETECTION_STALE_MS || 48 * 60 * 60 * 1000
);

const HEALTH_ALERT_COOLDOWN_MS = 120_000;
/** @type {Map<string, number>} */
const healthAlertCooldown = new Map();

function throttledHealthAlert(reason, emit) {
  const now = Date.now();
  const last = healthAlertCooldown.get(reason) ?? 0;
  if (now - last < HEALTH_ALERT_COOLDOWN_MS) {
    return;
  }
  healthAlertCooldown.set(reason, now);
  emit();
}

export async function getSystemHealth() {
  const mongo = mongoose.connection.readyState === 1;
  const redis = getReadyRedis();

  let redisOk = false;
  let workerHeartbeat = null;
  let workerOk = false;
  let queueLag = null;
  let queueOk = false;
  /** @type {{ active: number; waiting: number; failed: number } | null} */
  let depositQueueStats = null;

  if (redis) {
    try {
      redisOk = (await redis.ping()) === "PONG";
      workerHeartbeat = Number(await redis.get(WORKER_HEARTBEAT_KEY));
      workerOk =
        Number.isFinite(workerHeartbeat) &&
        workerHeartbeat > 0 &&
        Date.now() - workerHeartbeat <= WORKER_HEARTBEAT_MAX_AGE_MS;
    } catch (_) {
      redisOk = false;
    }
  }

  /** @type {{ active: number; waiting: number; failed: number } | null} */
  let payoutQueueStats = null;

  if (redis && depositQueue) {
    try {
      const counts = await depositQueue.getJobCounts(
        "waiting",
        "delayed",
        "active",
        "failed"
      );
      const waitingJobs =
        Number(counts.waiting || 0) + Number(counts.delayed || 0);
      const activeJobs = Number(counts.active || 0);
      const failedJobs = Number(counts.failed || 0);
      depositQueueStats = {
        active: activeJobs,
        waiting: waitingJobs,
        failed: failedJobs,
      };
      queueLag = waitingJobs + activeJobs;
      queueOk = true;
    } catch (_) {
      queueOk = false;
    }
  }

  let payoutWorkerHeartbeat = null;
  if (redis) {
    try {
      payoutWorkerHeartbeat = Number(await redis.get(PAYOUT_WORKER_HEARTBEAT_KEY));
    } catch {
      payoutWorkerHeartbeat = null;
    }
  }
  const payoutWorkerAgeMs =
    Number.isFinite(payoutWorkerHeartbeat) && payoutWorkerHeartbeat > 0
      ? Date.now() - payoutWorkerHeartbeat
      : null;
  const payoutWorkerAlive =
    payoutWorkerAgeMs != null && payoutWorkerAgeMs < WORKER_HEARTBEAT_MAX_AGE_MS;

  if (redis && payoutQueue) {
    try {
      const pc = await payoutQueue.getJobCounts("waiting", "delayed", "active", "failed");
      payoutQueueStats = {
        active: Number(pc.active || 0),
        waiting: Number(pc.waiting || 0) + Number(pc.delayed || 0),
        failed: Number(pc.failed || 0),
      };
    } catch (_) {
      payoutQueueStats = null;
    }
  }

  let rpcOk = false;
  try {
    rpcOk = await checkRpcHealth();
  } catch (_) {
    rpcOk = false;
  }

  let lastProcessedBlock = null;
  let lastDetectedTxTime = null;
  /** @type {number | null} */
  let lastDepositProcessedAt = null;
  /** @type {string | null} */
  let lastDepositTxHash = null;
  let lastRecoveryBlock = null;
  let lastRecoveryStartedAt = null;
  let lastRecoveryFinishedAt = null;
  /** @type {string | null} */
  let depositDetectionWarning = null;

  if (mongo) {
    try {
      const [
        blockDoc,
        detectedDoc,
        processedAtDoc,
        processedTxDoc,
        recoveryBlockDoc,
        recoveryStartedDoc,
        recoveryFinishedDoc,
      ] = await Promise.all([
        HybridSetting.findOne({ key: "hybridLastProcessedBlock" }).lean(),
        HybridSetting.findOne({ key: "hybridLastDetectedTxAt" }).lean(),
        HybridSetting.findOne({ key: HYBRID_SETTING_LAST_PROCESSED_DEPOSIT_AT }).lean(),
        HybridSetting.findOne({ key: HYBRID_SETTING_LAST_PROCESSED_DEPOSIT_TX }).lean(),
        HybridSetting.findOne({ key: HYBRID_SETTING_LAST_RECOVERY_BLOCK }).lean(),
        HybridSetting.findOne({ key: HYBRID_SETTING_LAST_RECOVERY_STARTED_AT }).lean(),
        HybridSetting.findOne({ key: HYBRID_SETTING_LAST_RECOVERY_FINISHED_AT }).lean(),
      ]);
      const bVal = blockDoc?.value;
      if (bVal !== undefined && bVal !== null && bVal !== "") {
        const n = Number(bVal);
        if (Number.isFinite(n)) lastProcessedBlock = n;
      }
      const dVal = detectedDoc?.value;
      if (dVal !== undefined && dVal !== null && dVal !== "") {
        const ts = Number(dVal);
        if (Number.isFinite(ts) && ts > 0) {
          lastDetectedTxTime = ts;
          const age = Date.now() - ts;
          if (age > DEPOSIT_DETECTION_STALE_MS) {
            depositDetectionWarning =
              "No qualifying deposit events recorded recently — verify RPC, listener, and queue worker";
          }
        }
      }

      const pAt = processedAtDoc?.value;
      if (pAt !== undefined && pAt !== null && pAt !== "") {
        const pts = Number(pAt);
        if (Number.isFinite(pts) && pts > 0) {
          lastDepositProcessedAt = pts;
        }
      }

      const pTx = processedTxDoc?.value;
      if (pTx !== undefined && pTx !== null && pTx !== "") {
        lastDepositTxHash = String(pTx).trim().toLowerCase();
      }

      const rb = Number(recoveryBlockDoc?.value);
      if (Number.isFinite(rb)) lastRecoveryBlock = rb;
      const rs = Number(recoveryStartedDoc?.value);
      if (Number.isFinite(rs) && rs > 0) lastRecoveryStartedAt = rs;
      const rf = Number(recoveryFinishedDoc?.value);
      if (Number.isFinite(rf) && rf > 0) lastRecoveryFinishedAt = rf;
    } catch (_) {
      lastProcessedBlock = null;
      lastDetectedTxTime = null;
      lastDepositProcessedAt = null;
      lastDepositTxHash = null;
      lastRecoveryBlock = null;
      lastRecoveryStartedAt = null;
      lastRecoveryFinishedAt = null;
      depositDetectionWarning = null;
    }
  }

  const recovery = await getDepositRecoveryHealth(lastProcessedBlock);
  const polling = await getPollingDepositClusterStatus();

  let pendingDeposits = null;
  let failedPayouts = null;
  let blockedPayouts = null;
  let approvedPayouts = null;
  if (mongo) {
    try {
      [pendingDeposits, failedPayouts, blockedPayouts, approvedPayouts] = await Promise.all([
        PendingDeposit.countDocuments({ status: "pending" }),
        HybridWithdrawal.countDocuments({
          status: "approved",
          payoutStatus: "failed",
        }),
        HybridWithdrawal.countDocuments({
          status: "approved",
          payoutStatus: "blocked",
        }),
        HybridWithdrawal.countDocuments({
          status: "approved",
          paidAt: null,
        }),
      ]);
    } catch (_) {
      pendingDeposits = null;
      failedPayouts = null;
      blockedPayouts = null;
      approvedPayouts = null;
    }
  }

  const requireRedis = String(process.env.REQUIRE_REDIS || "").toLowerCase() === "true";
  const requireWorker =
    String(process.env.REQUIRE_DEPOSIT_WORKER || "").toLowerCase() === "true";
  const requirePayoutForHealth =
    String(process.env.REQUIRE_WITHDRAW_PAYOUT_FOR_HEALTH || "").toLowerCase() === "true";
  const payoutConfigured = Boolean(
    String(process.env.HYBRID_PAYOUT_PRIVATE_KEY || "").trim() &&
      String(process.env.HYBRID_USDT_CONTRACT || "").trim()
  );
  const executor = {
    enabled: payoutConfigured,
    ...getHybridWithdrawExecutorStatus(),
    approvedQueue: approvedPayouts,
    failedHybridPayouts: failedPayouts,
    blockedHybridPayouts: blockedPayouts,
    payoutObservability: payoutObservabilitySnapshot(),
  };
  const heartbeatAgeMs =
    Number.isFinite(workerHeartbeat) && workerHeartbeat > 0
      ? Date.now() - workerHeartbeat
      : null;
  const workerNested = {
    heartbeatAgeMs,
    alive:
      heartbeatAgeMs != null && heartbeatAgeMs < WORKER_ALIVE_MAX_AGE_MS,
  };

  const monitorDeposits = isHybridEarnEnabled();

  /** @type {"SAFE"|"NOT_SAFE"} */
  let depositReliability = "SAFE";
  const depositReliabilityFailures = [];

  if (monitorDeposits && redisOk) {
    const hbAge =
      Number.isFinite(workerHeartbeat) && workerHeartbeat > 0
        ? Date.now() - workerHeartbeat
        : null;
    if (hbAge == null || hbAge > WORKER_RELIABILITY_MAX_AGE_MS) {
      depositReliability = "NOT_SAFE";
      depositReliabilityFailures.push("worker_heartbeat_stale_or_missing");
      throttledHealthAlert("worker_down", () => {
        logger.error("Worker down — deposit heartbeat missing or stale (>60s)", {});
      });
    }
  }

  if (monitorDeposits && recovery.warning) {
    depositReliability = "NOT_SAFE";
    depositReliabilityFailures.push("recovery_stuck_or_stale_heartbeat");
    throttledHealthAlert("recovery_stalled", () => {
      logger.error("Recovery stalled", { warning: recovery.warning });
    });
  }

  const failedDepositJobs =
    redisOk && depositQueueStats ? Number(depositQueueStats.failed || 0) : 0;
  if (monitorDeposits && redisOk && failedDepositJobs > 0) {
    depositReliability = "NOT_SAFE";
    depositReliabilityFailures.push("deposit_queue_has_failed_jobs");
    throttledHealthAlert("deposit_queue_failed", () => {
      logger.error("Deposit missed risk — BullMQ deposit queue has failed jobs", {
        failed: failedDepositJobs,
      });
    });
  }

  if (monitorDeposits && depositDetectionWarning) {
    throttledHealthAlert("deposit_miss_signal", () => {
      logger.error("Deposit missed risk", { detail: depositDetectionWarning });
    });
  }

  const TEN_MIN_MS = 600_000;
  const lastDepositDetectedAt =
    lastDetectedTxTime != null && lastDetectedTxTime > 0 ? lastDetectedTxTime : null;
  if (
    monitorDeposits &&
    lastDepositDetectedAt != null &&
    Date.now() - lastDepositDetectedAt > TEN_MIN_MS
  ) {
    throttledHealthAlert("deposit_silence_10m", () => {
      logger.error("No qualifying deposit telemetry updates in window", {
        windowMinutes: TEN_MIN_MS / 60_000,
      });
    });
  }

  const processLifecycle = getProcessLifecycleStatus();
  const criticalFailures = [
    !mongo ? "mongo" : null,
    !rpcOk ? "rpc" : null,
    requireRedis && !redisOk ? "redis" : null,
    requireWorker && !workerOk ? "worker" : null,
    requirePayoutForHealth && !payoutConfigured ? "withdraw_payout" : null,
    processLifecycle.runtimeUnhealthy ? "process_runtime_unhealthy" : null,
  ].filter(Boolean);

  const degradedForDeposits =
    depositReliability === "NOT_SAFE" && monitorDeposits;

  return {
    status:
      criticalFailures.length > 0 || degradedForDeposits ? "degraded" : "ok",
    criticalFailures,
    processLifecycle,
    depositReliability,
    depositReliabilityFailures,
    redis: {
      ok: redisOk,
      required: requireRedis,
      connected: Boolean(redis),
    },
    rpc: {
      ok: rpcOk,
      endpoints: getRpcHealthSnapshot(),
    },
    realtime: {
      pollingActive: Boolean(polling.active),
      websocketDisabled: depositPipelineConfig.websocketDisabled || depositPipelineConfig.forcePolling,
      websocketIntentionallyDisabled:
        depositPipelineConfig.websocketDisabled || depositPipelineConfig.forcePolling,
      fallbackModeHealthy: Boolean(polling.active && rpcOk),
      healthy: Boolean(polling.active && rpcOk),
      polling,
    },
    checks: {
      mongo,
      redis: redisOk,
      workerHeartbeat: workerOk,
      rpc: rpcOk,
      queue: queueOk,
      polling: Boolean(polling.active),
      withdrawPayout: payoutConfigured,
    },
    queueLag,
    depositQueue: depositQueueStats
      ? {
          active: depositQueueStats.active,
          waiting: depositQueueStats.waiting,
          failed: depositQueueStats.failed,
        }
      : {
          active: 0,
          waiting: 0,
          failed: 0,
        },
    worker: workerNested,
    payoutWorker: {
      heartbeatAgeMs: payoutWorkerAgeMs,
      alive: payoutWorkerAlive,
    },
    workerRuntime: {
      depositWorkerAlive: workerNested.alive,
      payoutWorkerAlive,
      depositQueue: depositQueueStats,
      payoutQueue: payoutQueueStats,
    },
    payoutQueue: payoutQueueStats
      ? {
          active: payoutQueueStats.active,
          waiting: payoutQueueStats.waiting,
          failed: payoutQueueStats.failed,
        }
      : {
          active: 0,
          waiting: 0,
          failed: 0,
        },
    pendingDeposits,
    failedPayouts,
    blockedPayouts,
    executor,
    payoutExecutorStatus: executor,
    workerHeartbeatAgeMs: heartbeatAgeMs,
    lastProcessedBlock,
    lastScannedBlock: polling.lastScannedBlock ?? lastProcessedBlock,
    lastChainBlock: polling.latestChainBlock ?? null,
    pendingSweeps: polling.pendingSweeps ?? null,
    lastDetectedTxTime,
    lastDepositDetectedAt,
    lastDepositProcessedAt,
    lastDepositTxHash,
    depositDetectionWarning,
    recovery,
    recoveryCheckpoint: {
      lastRecoveryBlock,
      lastRecoveryStartedAt,
      lastRecoveryFinishedAt,
    },
  };
}

/**
 * HTTP status for load balancers / Railway: defaults to **lenient** mode so deposit backlog signals
 * do not fail the platform health probe. Set SYSTEM_HEALTH_STRICT_HTTP=true to restore 503 on any degraded state.
 * @param {Awaited<ReturnType<typeof getSystemHealth>>} health
 */
export function getSystemHealthHttpStatus(health) {
  const strict =
    String(process.env.SYSTEM_HEALTH_STRICT_HTTP || "").toLowerCase() === "true";
  if (strict) {
    return health.status === "ok" ? 200 : 503;
  }
  if (health.criticalFailures?.length > 0) {
    return 503;
  }
  return 200;
}
