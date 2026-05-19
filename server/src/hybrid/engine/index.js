import { scanHybridDeposits } from "../services/depositListener.js";
import {
  startDepositSafetyRescanInterval,
  stopDepositRecoveryIntervals,
} from "../services/depositBackfill.js";
import { retryPendingDeposits } from "../services/pendingDepositService.js";
import {
  getPollingDepositEngineStatus,
  stopPollingDepositEngine,
} from "../services/pollingDepositEngine.js";
import { runHybridSweepBatch, canSweepHybridFunds } from "../services/sweepService.js";
import {
  autoMarkClaimable,
  runAutoWithdrawExecutorBatch,
} from "../services/withdrawService.js";
import {
  checkRpcHealth,
  getCurrentRpcUrl,
  getProvider,
  getRpcFallbackUsed,
  getRpcUrls,
} from "../utils/provider.js";
import {
  describeHybridEarnDisabledReason,
  isHybridEarnEnabled,
  warnIfHybridEarnEnvInvalid,
} from "../utils/hybridEarnEnv.js";
import { getClaimWindowStartUtc, isAfter5AM } from "../utils/roiPktTime.js";
import { depositQueue } from "../../queues/depositQueue.js";
import {
  isHybridRealtimeListenerStarted,
  isHybridWebSocketRealtimeActive,
} from "../listeners/realtimeListener.js";
import { userMap } from "../services/userMap.js";
import hybridConfig from "../../config/hybridConfig.js";
import { connectRedisInBackground, getReadyRedis, isRedisReady } from "../../config/redis.js";
import { resolveRedisUrlFromEnv } from "../../config/envNormalize.js";
import depositPipelineConfig from "../../config/depositPipelineConfig.js";
import { registerShutdownHook } from "../../infra/processLifecycle.js";
import { Wallet, parseEther, formatEther } from "ethers";
import logger from "../../utils/logger.js";

let hybridTimer = null;
let deepScanTimer = null;
let sweepTimer = null;
let claimableTimer = null;
let roiSchedulerTimer = null;
let pendingDepositTimer = null;
let withdrawExecutorTimer = null;
let sweepRunning = false;
let withdrawExecutorRunning = false;
let withdrawExecutorIntervalMs = null;
let shutdownHookRegistered = false;
let hybridEngineStarted = false;

const WITHDRAW_EXECUTOR_LOCK_KEY =
  String(process.env.HYBRID_WITHDRAW_EXECUTOR_LOCK_KEY || "hybrid:withdraw_executor:leader").trim() ||
  "hybrid:withdraw_executor:leader";

/** Stamped while the leader holds the NX lock so admin API replicas can show live executor status. */
const WITHDRAW_EXECUTOR_PULSE_KEY = "hybrid:withdraw_executor:pulse";

const isHybridRecoverySchedulesEnabled = () =>
  String(process.env.HYBRID_RECOVERY ?? "true").toLowerCase() !== "false";

const logHybridBootstrapStatus = async () => {
  warnIfHybridEarnEnvInvalid();

  const verboseBoot =
    process.env.NODE_ENV !== "production" ||
    String(process.env.HYBRID_ENGINE_VERBOSE_BOOT || "").toLowerCase() === "true";

  const backupScanOk = hybridTimer != null;
  const pollingStatus = getPollingDepositEngineStatus();
  const realtimeOk = isHybridRealtimeListenerStarted();
  const rpcOk = await checkRpcHealth();
  const usdt = String(process.env.HYBRID_USDT_CONTRACT || "").trim().toLowerCase();
  const contractOk = usdt === "0x55d398326f99059ff775485246999027b3197955";
  let gasOk = false;
  let queueOk = false;

  if (getReadyRedis() && depositQueue) {
    try {
      await depositQueue.getJobCounts();
      queueOk = true;
    } catch (_) {
      queueOk = false;
    }
  }

  try {
    if (!hybridConfig.gasKey) {
      logger.error("HYBRID gas funder unset — HYBRID_FUNDER_PRIVATE_KEY or HYBRID_GAS_PK required", {});
    } else if (rpcOk) {
      const provider = getProvider();
      const gf = new Wallet(hybridConfig.gasKey, provider);
      const fb = await provider.getBalance(gf.address);
      gasOk = fb >= parseEther("0.001");
      if (verboseBoot) {
        logger.debug?.("Hybrid gas funder snapshot", {
          address: gf.address?.slice?.(0, 10),
          balanceBnb: formatEther(fb),
        });
      }
      if (!gasOk) {
        logger.error("Gas funder BNB below 0.001", {
          balanceBnb: formatEther(fb),
        });
      }
    }
  } catch (err) {
    logger.error("Hybrid gas funder probe failed", { error: err?.message || String(err) });
  }

  const sweepReady = canSweepHybridFunds() && gasOk;
  const earnOn = isHybridEarnEnabled();
  const depositDetectOk = rpcOk && contractOk && earnOn;
  const creditOk = earnOn;
  const wsConfigured = Boolean(
    String(process.env.HYBRID_BSC_WS_URL || process.env.BSC_WS_URL || "").trim()
  );
  /** WS module implements close/error → destroy + delay + resubscribe */
  const autoReconnectOk =
    creditOk &&
    rpcOk &&
    contractOk &&
    wsConfigured &&
    realtimeOk;
  const recoveryOk =
    creditOk &&
    rpcOk &&
    contractOk &&
    getRpcUrls().length > 0 &&
    Boolean(String(process.env.HYBRID_USDT_CONTRACT || "").trim());
  const duplicateProtectionOk =
    creditOk &&
    rpcOk &&
    Boolean(String(process.env.HYBRID_USDT_CONTRACT || "").trim());

  const wsActive = isHybridWebSocketRealtimeActive();
  const pollingActive = Boolean(pollingStatus.active);
  const workerProcessingOk = queueOk;
  const workerRunningOk = workerProcessingOk;
  const deepScanOk = deepScanTimer != null;

  const systemStable =
    rpcOk &&
    realtimeOk &&
    depositDetectOk &&
    queueOk &&
    backupScanOk &&
    duplicateProtectionOk &&
    contractOk;

  if (!verboseBoot) {
    logger.info("HYBRID_ENGINE_SUMMARY", {
      rpcOk,
      realtimeOk,
      queueOk,
      websocketActive: wsActive,
      pollingActive,
      systemStable,
      userMapLoaded: userMap.size,
      gasFunded: gasOk,
      depositDetectOk,
      duplicateProtectionOk,
      recoveryOk,
      deepScanOk,
    });
    return;
  }

  logger.debug?.(`RPC Working ${rpcOk ? "ok" : "down"} ${rpcOk && getCurrentRpcUrl() ? getCurrentRpcUrl() : ""}`, {});
  const listenerLabel = realtimeOk ? "✅" : "❌";
  logger.debug?.("HYBRID_ENGINE_VERBOSE_DETAIL", {
    realtimeOk,
    backupScanOk,
    deepScanOk,
    recoveryOk,
    rpcFallbackUsed: getRpcFallbackUsed(),
    autoReconnectOk,
    creditOk,
    gasOk,
    sweepReady,
    rpcOk,
    listenerActive: listenerLabel,
    websocketActiveLabel: wsActive ? "✅" : wsConfigured ? "❌" : "❌ (not configured)",
    pollingActive,
    usersLoaded: userMap.size,
    depositDetectOk,
    queueOk,
    workerRunningOk,
    workerProcessingOk,
    duplicateProtectionOk,
    systemStable,
  });
};

const runSweepEngine = async () => {
  if (sweepRunning) {
    logger.debug?.("Sweep batch skipped — previous run still in progress", {});
    return;
  }

  sweepRunning = true;

  try {
    const result = await runHybridSweepBatch();

    if (result.ran && result.attempted > 0) {
      logger.debug?.(
        `HYBRID sweep attempted ${result.attempted}, succeeded ${result.succeeded ?? 0}`,
        {},
      );
    }
  } catch (error) {
    logger.error("Hybrid sweep batch failed", { error: error?.message || String(error) });
  } finally {
    sweepRunning = false;
  }
};

/**
 * Retries pending deposit records after startup full recovery (scan runs in depositBackfill).
 */
export async function runHybridStartupRecovery(_options = {}) {
  if (!isHybridEarnEnabled()) {
    logger.warn("HYBRID startup recovery skipped", {
      reason: describeHybridEarnDisabledReason(),
    });
    return;
  }
  if (getRpcUrls().length === 0) {
    logger.warn("HYBRID startup recovery skipped — no RPC URLs", {
      hint: "HYBRID_BSC_RPC_URL or BSC_RPC_URL",
    });
    return;
  }
  if (!String(process.env.HYBRID_USDT_CONTRACT || "").trim()) {
    logger.warn("HYBRID startup recovery skipped — HYBRID_USDT_CONTRACT missing", {});
    return;
  }
  try {
    await retryPendingDeposits(50);
  } catch (err) {
    logger.error("HYBRID pending deposit retry crashed", {
      error: err?.message || String(err),
    });
  }
}

export const startDepositListener = (options = {}) => {
  if (!isHybridEarnEnabled()) {
    logger.error("HYBRID engine not started", {
      reason: describeHybridEarnDisabledReason(),
    });
    return;
  }

  if (hybridEngineStarted) {
    return;
  }
  hybridEngineStarted = true;

  if (!shutdownHookRegistered) {
    shutdownHookRegistered = true;
    registerShutdownHook("hybrid_engine_timers", async () => {
      stopHybridEngine();
    });
  }

  const {
    enableDepositRecovery = true,
    enableDepositSafetyRescan = true,
    enablePendingDepositRetry = true,
    enableSweeps = true,
    enableClaimable = true,
    enableWithdrawExecutor = true,
    role = "hybrid",
  } = options || {};

  const sweepEngineMs = Number(process.env.HYBRID_SWEEP_ENGINE_INTERVAL_MS || 60000);

  logger.debug?.("Hybrid engine started", { role });

  if (enableDepositRecovery && isHybridRecoverySchedulesEnabled()) {
    const periodicMs = depositPipelineConfig.recoveryPeriodicIntervalMs;
    const deepMs = depositPipelineConfig.recoveryDeepIntervalMs;
    const periodicBlocks = depositPipelineConfig.recoveryPeriodicTailBlocks;
    const deepBlocks = depositPipelineConfig.recoveryDeepTailBlocks;

    hybridTimer = setInterval(async () => {
      try {
        await scanHybridDeposits(null, null, {
          blocks: periodicBlocks,
          logEmptyOnZero: false,
        });
      } catch (error) {
        logger.error("Hybrid periodic recovery crashed", {
          error: error?.message || String(error),
        });
      }
    }, periodicMs);

    deepScanTimer = setInterval(async () => {
      try {
        await scanHybridDeposits(null, null, {
          blocks: deepBlocks,
          logEmptyOnZero: false,
        });
      } catch (e) {
        logger.error("Hybrid deep recovery crashed", {
          error: e?.message || String(e),
        });
      }
    }, deepMs);
  } else if (enableDepositRecovery) {
    logger.warn("HYBRID_RECOVERY=false — periodic recovery scans disabled", {});
  }

  if (enableSweeps) {
    runSweepEngine();
    sweepTimer = setInterval(runSweepEngine, sweepEngineMs);
  }

  const claimableMs = Number(
    process.env.HYBRID_CLAIMABLE_INTERVAL_MS ||
      process.env.HYBRID_CLAIMABLE_MARK_INTERVAL_MS ||
      60000
  );
  const runAutoClaimable = async () => {
    try {
      await autoMarkClaimable();
    } catch (err) {
      logger.error("autoMarkClaimable failed", { error: err?.message || String(err) });
    }
  };
  if (enableClaimable) {
    void runAutoClaimable();
    claimableTimer = setInterval(runAutoClaimable, claimableMs);
  }

  roiSchedulerTimer = null;
  logger.warn("AUTO ROI DISABLED", {
    mode: "manual_roi_claim_only",
    disabledTriggers: ["startup_roi_run", "recurring_roi_scheduler"],
  });
  logger.info("Manual ROI mode active", {
    manualEndpoint: "POST /api/roi/claim",
    queueName: "hybridPayout",
    jobName: "roi_claim",
  });

  const retryPendingDepositMs = Number(process.env.HYBRID_PENDING_DEPOSIT_RETRY_MS || 60000);
  if (enablePendingDepositRetry) {
    const runPendingDepositRetry = async () => {
      try {
        const result = await retryPendingDeposits(25);
        if (result.credited > 0 || result.failed > 0) {
          logger.debug?.("Pending deposit retry batch result", result);
        }
      } catch (err) {
        logger.error("Pending deposit retry failed", {
          error: err?.message || String(err),
        });
      }
    };
    void runPendingDepositRetry();
    pendingDepositTimer = setInterval(runPendingDepositRetry, retryPendingDepositMs);
  }

  let withdrawExecutorLogPart = "withdraw executor off";
  const startWithdrawExecutor = () => {
    const withdrawExecutorMs = Number(process.env.HYBRID_WITHDRAW_EXECUTOR_MS || 30000);
    withdrawExecutorIntervalMs = withdrawExecutorMs;
    withdrawExecutorLogPart = `withdraw executor ${withdrawExecutorMs}ms`;
    if (!String(resolveRedisUrlFromEnv() || "").trim()) {
      logger.warn(
        "Withdraw executor: REDIS_URL unset — leader lock unavailable; duplicates possible if WITHDRAW_EXECUTOR_ENABLED on multiple replicas",
        {},
      );
    }
    const runWithdrawExecutor = async () => {
      if (withdrawExecutorRunning) {
        return;
      }

      let redis = null;
      let lockToken = "";
      try {
        redis = await connectRedisInBackground();
      } catch {
        redis = null;
      }

      const lockMs = Math.min(
        Math.max(Number(withdrawExecutorMs || 30000) * 10, 120000),
        900000,
      );

      if (redis && isRedisReady(redis)) {
        try {
          lockToken = `pid:${process.pid}:${Date.now()}`;
          const nx = await redis.set(
            WITHDRAW_EXECUTOR_LOCK_KEY,
            lockToken,
            "PX",
            lockMs,
            "NX",
          );
          if (nx !== "OK") {
            return;
          }
          const pulseTtl = Math.min(
            Math.max(Number(withdrawExecutorMs || 30000) * 10, 120000),
            900000,
          );
          try {
            await redis.set(
              WITHDRAW_EXECUTOR_PULSE_KEY,
              String(Date.now()),
              "PX",
              pulseTtl,
            );
          } catch {
            /* non-fatal */
          }
        } catch {
          return;
        }
      }

      withdrawExecutorRunning = true;
      try {
        const batch = Number(process.env.HYBRID_WITHDRAW_EXECUTOR_BATCH ?? 1);
        const usePayoutQueue =
          String(process.env.HYBRID_PAYOUT_USE_QUEUE || "").toLowerCase() === "true";

        if (usePayoutQueue) {
          try {
            const { enqueuePayoutWithdrawBatch } = await import("../../queues/payoutQueue.js");
            const enq = await enqueuePayoutWithdrawBatch(batch);
            if (enq.ok) {
              return;
            }
            logger.throttledWarn(
              "payout_queue_inline_fallback",
              "Payout BullMQ enqueue failed — running inline executor batch",
              { reason: enq.reason ?? "unknown" },
              90_000,
            );
          } catch (err) {
            logger.throttledWarn(
              "payout_queue_import_fallback",
              "Payout queue unavailable — inline executor batch",
              { error: err?.message || String(err) },
              90_000,
            );
          }
        }

        const result = await runAutoWithdrawExecutorBatch(batch);
        if (result.processed > 0 || result.failed > 0) {
          logger.info("Auto withdraw executor batch", {
            processed: result.processed,
            failed: result.failed,
            payoutCounters: result.observability?.counters ?? null,
          });
        }
      } catch (err) {
        logger.error("Auto withdraw executor crashed", {
          error: err?.message || String(err),
        });
      } finally {
        if (redis && isRedisReady(redis) && lockToken) {
          const script =
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
          await redis.eval(script, 1, WITHDRAW_EXECUTOR_LOCK_KEY, lockToken).catch(() => {});
        }
        withdrawExecutorRunning = false;
      }
    };
    void runWithdrawExecutor();
    withdrawExecutorTimer = setInterval(runWithdrawExecutor, withdrawExecutorMs);
  };

  if (enableWithdrawExecutor && process.env.WITHDRAW_EXECUTOR_ENABLED === "true") {
    startWithdrawExecutor();
    logger.info("Withdraw executor enabled on this hybrid instance", {});
  } else {
    logger.debug?.("Withdraw executor disabled on this instance", {});
  }

  if (enableDepositSafetyRescan) {
    startDepositSafetyRescanInterval();
  }

  logger.info("HYBRID engine schedules armed", {
    role,
    tailRescanMs: depositPipelineConfig.tailSafetyRescanIntervalMs,
    recoveryPeriodicMs: isHybridRecoverySchedulesEnabled()
      ? depositPipelineConfig.recoveryPeriodicIntervalMs
      : null,
    recoveryDeepMs: isHybridRecoverySchedulesEnabled()
      ? depositPipelineConfig.recoveryDeepIntervalMs
      : null,
    recoveryBlocksPeriodic: isHybridRecoverySchedulesEnabled()
      ? depositPipelineConfig.recoveryPeriodicTailBlocks
      : null,
    recoveryBlocksDeep: isHybridRecoverySchedulesEnabled()
      ? depositPipelineConfig.recoveryDeepTailBlocks
      : null,
    sweepMs: enableSweeps ? sweepEngineMs : null,
    claimableMs: enableClaimable ? claimableMs : null,
    roiSchedulerMs: null,
    withdrawExecutor: withdrawExecutorLogPart,
    depositRecovery: Boolean(enableDepositRecovery),
    depositSafetyRescan: Boolean(enableDepositSafetyRescan),
    pendingDepositRetry: Boolean(enablePendingDepositRetry),
  });

  void logHybridBootstrapStatus().catch((err) => {
    logger.warn("HYBRID engine bootstrap status escaped local guard", {
      error: err?.message || String(err),
    });
  });
};

export const startHybridEngine = startDepositListener;

export const startHybridTreasuryEngine = () =>
  startDepositListener({
    role: "hybrid2-treasury",
    enableDepositRecovery: false,
    enableDepositSafetyRescan: false,
    enablePendingDepositRetry: false,
    enableSweeps: true,
    enableClaimable: true,
    enableWithdrawExecutor: true,
  });

export function stopHybridEngine() {
  const timers = [
    ["hybridTimer", hybridTimer],
    ["deepScanTimer", deepScanTimer],
    ["sweepTimer", sweepTimer],
    ["claimableTimer", claimableTimer],
    ["roiSchedulerTimer", roiSchedulerTimer],
    ["pendingDepositTimer", pendingDepositTimer],
    ["withdrawExecutorTimer", withdrawExecutorTimer],
  ];

  for (const [, timer] of timers) {
    if (timer != null) {
      clearInterval(timer);
    }
  }

  hybridTimer = null;
  deepScanTimer = null;
  sweepTimer = null;
  claimableTimer = null;
  roiSchedulerTimer = null;
  pendingDepositTimer = null;
  withdrawExecutorTimer = null;
  withdrawExecutorIntervalMs = null;
  hybridEngineStarted = false;
  stopPollingDepositEngine();
  stopDepositRecoveryIntervals();
  logger.info("Hybrid engine timers stopped", {});
}

export const getHybridWithdrawExecutorStatus = () => ({
  scheduled: withdrawExecutorTimer != null,
  running: withdrawExecutorRunning,
  intervalMs: withdrawExecutorIntervalMs,
  enabled: process.env.WITHDRAW_EXECUTOR_ENABLED === "true",
  roiSchedulerScheduled: roiSchedulerTimer != null,
  roiSchedulerRunning: false,
});
