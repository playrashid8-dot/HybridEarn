import HybridDeposit from "../models/HybridDeposit.js";
import HybridSetting from "../models/HybridSetting.js";
import depositPipelineConfig from "../../config/depositPipelineConfig.js";
import { depositQueue } from "../../queues/depositQueue.js";
import { scanHybridDeposits, getLastProcessedBlock } from "./depositListener.js";
import { isHybridEarnEnabled } from "../utils/hybridEarnEnv.js";
import {
  getCurrentRpcUrl,
  getRpcFallbackUsed,
  getRpcHealthSnapshot,
  getRpcUrls,
  withProviderRetry,
} from "../utils/provider.js";
import logger from "../../utils/logger.js";

export const POLLING_LAST_RUN_AT_KEY = "hybridDepositPollingLastRunAt";
export const POLLING_LAST_LATENCY_MS_KEY = "hybridDepositPollingLastLatencyMs";
export const POLLING_FAILED_SCANS_KEY = "hybridDepositPollingFailedScans";
export const POLLING_DEPOSITS_DETECTED_KEY = "hybridDepositPollingDepositsDetected";

let pollingTimer = null;
let pollingRunning = false;
let startedAt = null;

const metrics = {
  active: false,
  running: false,
  lastRunAt: null,
  lastErrorAt: null,
  lastError: null,
  lastScannedBlock: null,
  latestChainBlock: null,
  pollingLatencyMs: null,
  depositsDetected: 0,
  failedScans: 0,
  pendingSweeps: null,
};

async function persistPollingMetric(key, value) {
  try {
    await HybridSetting.findOneAndUpdate(
      { key },
      { $set: { value } },
      { upsert: true, new: true },
    );
  } catch (err) {
    logger.debug?.("Polling deposit metric persist skipped", {
      key,
      error: err?.message || String(err),
    });
  }
}

async function refreshSnapshot() {
  const [checkpoint, chainBlock, pendingSweeps, queueCounts] = await Promise.all([
    getLastProcessedBlock().catch(() => null),
    withProviderRetry((p) => p.getBlockNumber(), null, {
      purpose: "deposit_polling_chain_head",
    }).catch(() => null),
    HybridDeposit.countDocuments({
      status: "credited",
      sweeped: { $ne: true },
    }).catch(() => null),
    depositQueue
      ? depositQueue.getJobCounts("waiting", "delayed", "active", "failed").catch(() => null)
      : Promise.resolve(null),
  ]);

  metrics.lastScannedBlock = Number.isFinite(Number(checkpoint)) ? Number(checkpoint) : null;
  metrics.latestChainBlock = Number.isFinite(Number(chainBlock)) ? Number(chainBlock) : null;
  metrics.pendingSweeps = pendingSweeps;
  metrics.queue = queueCounts
    ? {
        waiting: Number(queueCounts.waiting || 0) + Number(queueCounts.delayed || 0),
        active: Number(queueCounts.active || 0),
        failed: Number(queueCounts.failed || 0),
      }
    : null;
}

export async function runPollingDepositTick(reason = "interval") {
  if (!isHybridEarnEnabled()) {
    metrics.active = false;
    return { skipped: true, reason: "hybrid_earn_disabled" };
  }

  if (getRpcUrls().length === 0) {
    metrics.active = false;
    return { skipped: true, reason: "missing_rpc" };
  }

  if (pollingRunning) {
    return { skipped: true, reason: "already_running" };
  }

  pollingRunning = true;
  metrics.running = true;
  const started = Date.now();

  try {
    const result = await scanHybridDeposits(null, null, {
      quiet: true,
      skipProbe: true,
      logEmptyOnZero: false,
    });
    const latencyMs = Date.now() - started;
    const processed = Number(result?.processed || 0);
    metrics.pollingLatencyMs = latencyMs;
    metrics.lastRunAt = Date.now();
    metrics.depositsDetected += processed;
    metrics.lastError = null;
    metrics.lastErrorAt = null;
    await refreshSnapshot();
    await Promise.all([
      persistPollingMetric(POLLING_LAST_RUN_AT_KEY, metrics.lastRunAt),
      persistPollingMetric(POLLING_LAST_LATENCY_MS_KEY, latencyMs),
      processed > 0
        ? persistPollingMetric(POLLING_DEPOSITS_DETECTED_KEY, metrics.depositsDetected)
        : Promise.resolve(),
    ]);
    logger.debug?.("HTTP polling deposit tick complete", {
      reason,
      processed,
      latencyMs,
      lastScannedBlock: metrics.lastScannedBlock,
      latestChainBlock: metrics.latestChainBlock,
    });
    return result;
  } catch (err) {
    metrics.failedScans += 1;
    metrics.lastErrorAt = Date.now();
    metrics.lastError = err?.message || String(err);
    await persistPollingMetric(POLLING_FAILED_SCANS_KEY, metrics.failedScans);
    logger.error("HTTP polling deposit tick failed — runtime remains alive", {
      reason,
      error: metrics.lastError,
    });
    return { skipped: true, error: metrics.lastError };
  } finally {
    pollingRunning = false;
    metrics.running = false;
  }
}

export function startPollingDepositEngine() {
  if (pollingTimer != null) {
    return;
  }

  if (!isHybridEarnEnabled()) {
    logger.warn("HTTP polling deposit engine skipped — hybrid earn disabled", {});
    return;
  }

  metrics.active = true;
  startedAt = Date.now();
  const intervalMs = depositPipelineConfig.pollingIntervalMs;
  logger.info("HTTP polling deposit engine active", {
    intervalMs,
    confirmations: depositPipelineConfig.depositConfirmations,
    chunkBlocks: depositPipelineConfig.depositScanChunkBlocks,
    websocketDisabled: depositPipelineConfig.websocketDisabled,
    forcePolling: depositPipelineConfig.forcePolling,
  });

  void runPollingDepositTick("startup").catch((err) => {
    logger.error("HTTP polling deposit startup tick escaped local guard", {
      error: err?.message || String(err),
    });
  });
  pollingTimer = setInterval(() => {
    void runPollingDepositTick("interval").catch((err) => {
      logger.error("HTTP polling deposit interval tick escaped local guard", {
        error: err?.message || String(err),
      });
    });
  }, intervalMs);
  pollingTimer?.unref?.();
}

export function stopPollingDepositEngine() {
  if (pollingTimer != null) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
  metrics.active = false;
}

export function getPollingDepositEngineStatus() {
  return {
    ...metrics,
    active: pollingTimer != null && metrics.active,
    running: pollingRunning,
    startedAt,
    intervalMs: depositPipelineConfig.pollingIntervalMs,
    confirmations: depositPipelineConfig.depositConfirmations,
    websocketDisabled: depositPipelineConfig.websocketDisabled,
    forcePolling: depositPipelineConfig.forcePolling,
    rpcFallbackUsed: getRpcFallbackUsed(),
    rpcHealth: getRpcHealthSnapshot(),
    currentRpcConfigured: Boolean(getCurrentRpcUrl()),
  };
}


export async function getPollingDepositClusterStatus() {
  const local = getPollingDepositEngineStatus();
  const keys = [
    POLLING_LAST_RUN_AT_KEY,
    POLLING_LAST_LATENCY_MS_KEY,
    POLLING_FAILED_SCANS_KEY,
    POLLING_DEPOSITS_DETECTED_KEY,
  ];

  let persisted = {};
  try {
    const docs = await HybridSetting.find({ key: { $in: keys } }).lean();
    persisted = Object.fromEntries(docs.map((doc) => [doc.key, doc.value]));
  } catch (err) {
    logger.debug?.("Polling deposit cluster status read skipped", {
      error: err?.message || String(err),
    });
  }

  const persistedLastRunAt = Number(persisted[POLLING_LAST_RUN_AT_KEY]);
  const persistedLatencyMs = Number(persisted[POLLING_LAST_LATENCY_MS_KEY]);
  const persistedFailedScans = Number(persisted[POLLING_FAILED_SCANS_KEY]);
  const persistedDepositsDetected = Number(persisted[POLLING_DEPOSITS_DETECTED_KEY]);
  const activeTtlMs = Math.min(
    600_000,
    Math.max(
      local.intervalMs * 4,
      Number(process.env.HYBRID_DEPOSIT_POLLING_ACTIVE_TTL_MS || 120_000),
    ),
  );
  const persistedActive =
    Number.isFinite(persistedLastRunAt) &&
    persistedLastRunAt > 0 &&
    Date.now() - persistedLastRunAt <= activeTtlMs;

  return {
    ...local,
    active: Boolean(local.active || persistedActive),
    running: Boolean(local.running),
    lastRunAt: local.lastRunAt ?? (Number.isFinite(persistedLastRunAt) ? persistedLastRunAt : null),
    pollingLatencyMs:
      local.pollingLatencyMs ??
      (Number.isFinite(persistedLatencyMs) ? persistedLatencyMs : null),
    failedScans: Math.max(
      Number(local.failedScans || 0),
      Number.isFinite(persistedFailedScans) ? persistedFailedScans : 0,
    ),
    depositsDetected: Math.max(
      Number(local.depositsDetected || 0),
      Number.isFinite(persistedDepositsDetected) ? persistedDepositsDetected : 0,
    ),
    cluster: {
      active: Boolean(persistedActive),
      lastRunAt: Number.isFinite(persistedLastRunAt) ? persistedLastRunAt : null,
      activeTtlMs,
    },
  };
}