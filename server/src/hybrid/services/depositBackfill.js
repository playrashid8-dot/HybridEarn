import { id, Interface } from "ethers";

import {
  processDepositLog,
  CONFIRMATIONS,
  getLastProcessedBlock,
  saveLastProcessedBlock,
  selectDepositCandidateLogs,
} from "./depositListener.js";
import { BSC_USDT_ABI } from "../utils/constants.js";
import {
  getRpcUrls,
  withProviderRetry,
} from "../utils/provider.js";
import {
  describeHybridEarnDisabledReason,
  isHybridEarnEnabled,
} from "../utils/hybridEarnEnv.js";
import {
  connectRedisInBackground,
  getRedis,
  isRedisReady,
} from "../../config/redis.js";
import depositPipelineConfig from "../../config/depositPipelineConfig.js";
import { registerShutdownHook } from "../../infra/processLifecycle.js";
import logger from "../../utils/logger.js";
import {
  resolveRecipientsUsersByWalletMap,
} from "../utils/walletUserLookup.js";

const MAYBE_GC =
  typeof global.gc === "function" &&
  String(process.env.HYBRID_ENABLE_GC_HINTS || "").trim().toLowerCase() === "true";

const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");
const transferIface = new Interface(BSC_USDT_ABI);

const REORG_BUFFER = 5;

const shouldAbortRecoveryChunk = (result) =>
  Boolean(
    result?.creditFailure ||
      (result?.holdCheckpoint &&
        result?.processedDelta === 0 &&
        result?.queued !== true)
  );

const RECOVERY_MAX_LOGS_PER_FETCH = 200;
const recoveryChunkGcPause = () =>
  new Promise((r) => setTimeout(r, 200));

/** Prevents nested full recovery in the same Node process (Redis NX still protects cross-process). */
let fullRecoveryLocallyBusy = false;

async function processFullRecoveryLogWindow(
  logs,
  startIdx,
  endIdxExclusive,
  fromBlock,
  toBlock
) {
  const windowLogs =
    startIdx === 0 && endIdxExclusive === logs.length
      ? logs
      : logs.slice(startIdx, endIdxExclusive);

  const candidateLogs = selectDepositCandidateLogs(windowLogs);
  const toAddresses = [
    ...new Set(candidateLogs.map((candidate) => candidate.toAddress)),
  ];

  let usersByWallet = new Map();
  if (toAddresses.length > 0) {
    usersByWallet = await resolveRecipientsUsersByWalletMap(toAddresses);
  }

  for (const candidate of candidateLogs) {
    const { log } = candidate;
    const result = await processDepositLog(log, transferIface, usersByWallet, {
      skipQueue: false,
      fullRecovery: true,
    });
    if (shouldAbortRecoveryChunk(result)) {
      logger.warn("Full recovery chunk paused — queue defer or credit failure", {
        fromBlock,
        toBlock,
        txHashPartial: String(log.transactionHash || "").toLowerCase().slice(0, 14),
      });
      return true;
    }
  }
  return false;
}

/** Distributed recovery lock + ops telemetry (read by `/system/health`). */
export const DEPOSIT_RECOVERY_LOCK_KEY = "deposit:recovery:lock";
export const DEPOSIT_RECOVERY_LAST_RUN_AT_KEY = "deposit:recovery:lastRunAt";
export const DEPOSIT_RECOVERY_LAST_CHECKPOINT_KEY =
  "deposit:recovery:lastCheckpoint";
export const DEPOSIT_RECOVERY_HEARTBEAT_KEY = "deposit:recovery:heartbeat";

const RECOVERY_LOCK_TTL_SEC = 300;
const RECOVERY_HEARTBEAT_TTL_SEC = 600;
const RECOVERY_STALL_MS = 60000;
/** Health warns when lock is held but heartbeat is older than this (ms). */
const RECOVERY_HEARTBEAT_STALE_MS = 90000;
export const HYBRID_SETTING_LAST_RECOVERY_BLOCK = "hybridLastRecoveryBlock";
export const HYBRID_SETTING_LAST_RECOVERY_STARTED_AT = "hybridLastRecoveryStartedAt";
export const HYBRID_SETTING_LAST_RECOVERY_FINISHED_AT = "hybridLastRecoveryFinishedAt";

/**
 * Snapshot for health checks (Redis optional — falls back to DB checkpoint).
 */
export async function getDepositRecoveryHealth(dbLastProcessedBlock) {
  const redis = getRedis();
  const prepared =
    redis && !isRedisReady(redis)
      ? await connectRedisInBackground().catch(() => null)
      : redis;

  const resolvedRedis = prepared && isRedisReady(prepared) ? prepared : null;

  const base = {
    running: false,
    lastRunAt: null,
    lastProcessedBlock:
      dbLastProcessedBlock != null && Number.isFinite(Number(dbLastProcessedBlock))
        ? Number(dbLastProcessedBlock)
        : null,
    warning: null,
  };

  if (!resolvedRedis) {
    return base;
  }

  try {
    const [lockHeld, lastRunStr, cpStr, hbStr] = await Promise.all([
      resolvedRedis.exists(DEPOSIT_RECOVERY_LOCK_KEY),
      resolvedRedis.get(DEPOSIT_RECOVERY_LAST_RUN_AT_KEY),
      resolvedRedis.get(DEPOSIT_RECOVERY_LAST_CHECKPOINT_KEY),
      resolvedRedis.get(DEPOSIT_RECOVERY_HEARTBEAT_KEY),
    ]);

    const lastRunAt =
      lastRunStr != null && lastRunStr !== ""
        ? Number(lastRunStr)
        : null;
    const redisCp =
      cpStr != null && cpStr !== "" && Number.isFinite(Number(cpStr))
        ? Number(cpStr)
        : null;

    let warning = null;
    if (lockHeld && hbStr != null && hbStr !== "") {
      const hb = Number(hbStr);
      if (Number.isFinite(hb) && Date.now() - hb > RECOVERY_HEARTBEAT_STALE_MS) {
        warning =
          "Deposit recovery holds lock but heartbeat is stale — recovery may be stalled or RPC hung";
      }
    }

    return {
      running: Boolean(lockHeld),
      lastRunAt: Number.isFinite(lastRunAt) ? lastRunAt : null,
      lastProcessedBlock: redisCp ?? base.lastProcessedBlock,
      warning,
    };
  } catch (_) {
    return base;
  }
}

async function touchRecoveryLockAndHeartbeat(redis) {
  const now = String(Date.now());
  await redis.set(
    DEPOSIT_RECOVERY_HEARTBEAT_KEY,
    now,
    "EX",
    RECOVERY_HEARTBEAT_TTL_SEC
  );
  await redis.expire(DEPOSIT_RECOVERY_LOCK_KEY, RECOVERY_LOCK_TTL_SEC);
}

/**
 * Full checkpoint recovery: every confirmed block from stored checkpoint → chain tip.
 * Batched getLogs, advances checkpoint only after each chunk succeeds (resumable after crash).
 */
export async function runFullRecoveryScan() {
  if (!isHybridEarnEnabled()) {
    logger.warn("Full recovery skipped — hybrid earn disabled", {
      reason: describeHybridEarnDisabledReason(),
    });
    return;
  }
  if (getRpcUrls().length === 0) {
    logger.warn("Full recovery skipped — missing RPC configuration", {});
    return;
  }
  const usdt = String(process.env.HYBRID_USDT_CONTRACT || "").trim();
  if (!usdt) {
    logger.warn("Full recovery skipped — HYBRID_USDT_CONTRACT missing", {});
    return;
  }

  if (fullRecoveryLocallyBusy === true) {
    logger.warn("FULL_RECOVERY_BLOCKED: process-local overlap prevented", {});
    return;
  }

  fullRecoveryLocallyBusy = true;

  try {
    await connectRedisInBackground().catch(() => null);
  const redis = getRedis();
  const redisConnected = redis && isRedisReady(redis);
  /** Without Redis there is no distributed lock — still run recovery (duplicate-safe > missed deposits). */
  let lockHeld = false;
  let useRedisLock = false;

  if (redisConnected) {
    const lockAcquired = await redis.set(
      DEPOSIT_RECOVERY_LOCK_KEY,
      "1",
      "NX",
      "EX",
      RECOVERY_LOCK_TTL_SEC
    );
    if (lockAcquired !== "OK") {
      logger.debug?.("FULL_RECOVERY_SKIPPED — redis NX lock held elsewhere", {});
      return;
    }
    lockHeld = true;
    useRedisLock = true;
  } else {
    logger.warn(
      "Running full recovery without Redis leader lock — prefer REDIS_URL for multi-replica deployments",
      {}
    );
  }

  try {
    const envConfigured = Number(process.env.HYBRID_FULL_RECOVERY_BATCH_SIZE || 0);
    const minBlocks = depositPipelineConfig.recoveryMinBatchBlocks;
    const maxBlocks = depositPipelineConfig.recoveryMaxBatchBlocks;
    const baseline =
      Number.isFinite(envConfigured) && envConfigured > 0
        ? envConfigured
        : Math.floor((minBlocks + maxBlocks) / 2);
    let dynamicBlocks = Math.min(maxBlocks, Math.max(minBlocks, baseline));

    const stored = await getLastProcessedBlock();
    let from = Math.max(0, stored + 1 - REORG_BUFFER);
    const startBlock = from;
    let lastProgressTime = Date.now();

    logger.info("FULL_RECOVERY_START", {
      checkpointStored: stored,
      firstBlock: from,
      dynamicBatchBlocks: dynamicBlocks,
    });
    await HybridSetting.findOneAndUpdate(
      { key: HYBRID_SETTING_LAST_RECOVERY_STARTED_AT },
      { $set: { value: Date.now() } },
      { upsert: true, new: true },
    ).catch(() => {});

    recoveryLoop: while (true) {
      const now = Date.now();
      if (now - lastProgressTime > RECOVERY_STALL_MS) {
        logger.error("Full recovery stalled — aborting checkpoint loop until next invocation", {});
        break;
      }

      if (useRedisLock && redisConnected) {
        await touchRecoveryLockAndHeartbeat(redis);
      }

      const chainTip = await withProviderRetry((p) => p.getBlockNumber());
      const latest = Math.max(0, chainTip - CONFIRMATIONS);

      if (from > latest) {
        logger.info("FULL_RECOVERY_COMPLETE", {
          throughBlock: latest,
          chainTip,
        });
        lastProgressTime = Date.now();
        break;
      }

      let to = Math.min(from + dynamicBlocks, latest);
      let logs;

      fetchChunk: for (;;) {
        try {
          logs = await withProviderRetry((provider) =>
            provider.getLogs({
              address: usdt,
              fromBlock: from,
              toBlock: to,
              topics: [TRANSFER_TOPIC],
            })
          );
        } catch (err) {
          logger.warn("Full recovery RPC chunk degraded — delaying before retry sweep", {
            error: err?.message || String(err),
            from,
            toPreview: `${from}-${to}`,
          });
          await new Promise((r) => setTimeout(r, 2500));
          continue recoveryLoop;
        }

        if (logs.length > RECOVERY_MAX_LOGS_PER_FETCH && to > from) {
          to = from + Math.max(1, Math.floor((to - from) / 2));
          continue fetchChunk;
        }

        break;
      }

      // RPC advanced — avoids false stall while chunk processing is slow (large logs).
      lastProgressTime = Date.now();

      let chunkAborted = false;
      const chunkLogCount = logs.length;
      if (chunkLogCount > RECOVERY_MAX_LOGS_PER_FETCH) {
        for (
          let i = 0;
          i < chunkLogCount && !chunkAborted;
          i += RECOVERY_MAX_LOGS_PER_FETCH
        ) {
          const end = Math.min(i + RECOVERY_MAX_LOGS_PER_FETCH, chunkLogCount);
          chunkAborted = await processFullRecoveryLogWindow(
            logs,
            i,
            end,
            from,
            to
          );
          if (MAYBE_GC) {
            global.gc();
          }
          await recoveryChunkGcPause();
        }
      } else {
        chunkAborted = await processFullRecoveryLogWindow(
          logs,
          0,
          logs.length,
          from,
          to
        );
      }

      logs.length = 0;
      if (MAYBE_GC) {
        global.gc();
      }
      await recoveryChunkGcPause();

      if (chunkAborted) {
        break;
      }

      const checkpointHasConfirmationDepth = chainTip >= to + CONFIRMATIONS;
      if (!checkpointHasConfirmationDepth) {
        logger.warn("FULL_RECOVERY_WAIT — confirmations insufficient to seal checkpoint yet", {
          to,
          chainTip,
        });
        break;
      }

      try {
        await saveLastProcessedBlock(to);
        await HybridSetting.findOneAndUpdate(
          { key: HYBRID_SETTING_LAST_RECOVERY_BLOCK },
          { $set: { value: to } },
          { upsert: true, new: true },
        );
      } catch (err) {
        logger.error("Full recovery mongo checkpoint persistence failed mid-scan", {
          error: err?.message || String(err),
        });
        break;
      }

      if (useRedisLock && redisConnected) {
        try {
          await redis.set(DEPOSIT_RECOVERY_LAST_CHECKPOINT_KEY, String(to));
        } catch (e) {
          logger.warn("Redis checkpoint telemetry key failed — non-blocking", {
            error: e?.message || String(e),
          });
        }
      }

      const span = Math.max(1, latest - startBlock);
      const done = Math.min(Math.max(0, to - startBlock), span);
      const progress = ((done / span) * 100).toFixed(2);

      logger.debug?.("FULL_RECOVERY_PROGRESS_CHUNK", {
        progressPct: Number(progress),
        from,
        to,
        logBurst: chunkLogCount,
        dynamicBlocks,
      });

      if (chunkLogCount > RECOVERY_MAX_LOGS_PER_FETCH * 0.8) {
        dynamicBlocks = Math.max(minBlocks, dynamicBlocks - 10);
      } else if (
        chunkLogCount < Math.max(4, RECOVERY_MAX_LOGS_PER_FETCH * 0.06) &&
        dynamicBlocks < maxBlocks
      ) {
        dynamicBlocks = Math.min(maxBlocks, dynamicBlocks + 14);
      }

      lastProgressTime = Date.now();
      from = to + 1;
    }
  } catch (err) {
    logger.error("FULL_RECOVERY_INNER_CATCH", {
      error: err?.message || String(err),
    });
  } finally {
    if (useRedisLock && redisConnected) {
      try {
        await redis.set(DEPOSIT_RECOVERY_LAST_RUN_AT_KEY, String(Date.now()));
      } catch (e) {
        logger.warn("recovery lastRunAt redis telemetry noop", {
          error: e?.message || String(e),
        });
      }
    }
    await HybridSetting.findOneAndUpdate(
      { key: HYBRID_SETTING_LAST_RECOVERY_FINISHED_AT },
      { $set: { value: Date.now() } },
      { upsert: true, new: true },
    ).catch(() => {});
    if (lockHeld && useRedisLock && redisConnected) {
      try {
        await redis.del(DEPOSIT_RECOVERY_LOCK_KEY);
      } catch (e) {
        logger.error("Recovery NX lock delete failed — manual Redis inspection may be needed", {
          error: e?.message || String(e),
        });
      }
    }
  }
  } finally {
    fullRecoveryLocallyBusy = false;
  }
}

async function fetchUsdtTransferLogs(fromBlock, toBlock) {
  const address = String(process.env.HYBRID_USDT_CONTRACT || "").trim();
  if (!address) return [];
  return withProviderRetry((provider) =>
    provider.getLogs({
      address,
      fromBlock,
      toBlock,
      topics: [TRANSFER_TOPIC],
    })
  );
}

async function processLogsThroughPipeline(logs) {
  const candidateLogs = selectDepositCandidateLogs(logs);
  const toAddresses = [
    ...new Set(candidateLogs.map((candidate) => candidate.toAddress)),
  ];

  if (toAddresses.length === 0) {
    return;
  }

  const usersByWallet = await resolveRecipientsUsersByWalletMap(toAddresses);

  for (const candidate of candidateLogs) {
    const { log } = candidate;
    await processDepositLog(log, transferIface, usersByWallet, {
      skipQueue: false,
    });
  }
}

/**
 * Startup: full checkpoint → tip recovery (no block cap).
 */
export async function runDepositBackfillOnStartup() {
  await runFullRecoveryScan();
}

/**
 * Periodic catch-up: last 20 confirmed blocks (websocket / downtime gaps).
 */
export async function runDepositTailRescan20Blocks() {
  if (!isHybridEarnEnabled()) {
    return;
  }
  if (getRpcUrls().length === 0) {
    return;
  }
  if (!String(process.env.HYBRID_USDT_CONTRACT || "").trim()) {
    return;
  }

  try {
    const chainTip = await withProviderRetry((p) => p.getBlockNumber());
    const latestBlock = Math.max(0, chainTip - CONFIRMATIONS);
    const spanBlocks = depositPipelineConfig.tailSafetyRescanBlocks;
    const fromBlock = Math.max(0, latestBlock - (spanBlocks - 1));

    const logs = await fetchUsdtTransferLogs(fromBlock, latestBlock);
    if (logs.length > 0) {
      logger.debug?.("deposit tail sweep executed", {
        logs: logs.length,
        blocks: `${fromBlock}-${latestBlock}`,
      });
    }
    await processLogsThroughPipeline(logs);
  } catch (err) {
    logger.warn("deposit tail sweep encountered RPC/mongo noise", {
      error: err?.message || String(err),
    });
  }
}

let safetyRescanIntervalId = null;
let recoveryIntervalId = null;
let deepRecoveryIntervalId = null;
let shutdownHookRegistered = false;

function registerRecoveryShutdownHook() {
  if (shutdownHookRegistered) {
    return;
  }
  shutdownHookRegistered = true;
  registerShutdownHook("hybrid_deposit_recovery_intervals", async () => {
    stopDepositRecoveryIntervals();
  });
}

/** Periodic narrow tail sweep (complements websocket + checkpoint recovery). */
export function startDepositSafetyRescanInterval() {
  if (safetyRescanIntervalId != null) {
    return;
  }
  if (!isHybridEarnEnabled()) {
    return;
  }

  registerRecoveryShutdownHook();
  const EveryMs = depositPipelineConfig.tailSafetyRescanIntervalMs;
  safetyRescanIntervalId = setInterval(() => {
    void runDepositTailRescan20Blocks().catch((err) => {
      logger.warn("deposit tail sweep interval contained local fault", {
        error: err?.message || String(err),
      });
    });
  }, EveryMs);
}

export function startDepositRecoveryIntervals() {
  if (recoveryIntervalId != null || deepRecoveryIntervalId != null) {
    return;
  }
  if (!isHybridEarnEnabled()) {
    return;
  }

  registerRecoveryShutdownHook();
  recoveryIntervalId = setInterval(() => {
    void runFullRecoveryScan().catch((err) => {
      logger.warn("Periodic deposit checkpoint recovery failed — isolated from polling", {
        error: err?.message || String(err),
      });
    });
  }, depositPipelineConfig.recoveryPeriodicIntervalMs);

  deepRecoveryIntervalId = setInterval(() => {
    void runFullRecoveryScan().catch((err) => {
      logger.warn("Deep deposit checkpoint recovery failed — isolated from polling", {
        error: err?.message || String(err),
      });
    });
  }, depositPipelineConfig.recoveryDeepIntervalMs);

  recoveryIntervalId?.unref?.();
  deepRecoveryIntervalId?.unref?.();
}

export function stopDepositRecoveryIntervals() {
  if (safetyRescanIntervalId != null) {
    clearInterval(safetyRescanIntervalId);
    safetyRescanIntervalId = null;
  }
  if (recoveryIntervalId != null) {
    clearInterval(recoveryIntervalId);
    recoveryIntervalId = null;
  }
  if (deepRecoveryIntervalId != null) {
    clearInterval(deepRecoveryIntervalId);
    deepRecoveryIntervalId = null;
  }
}
