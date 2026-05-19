/**
 * Periodic payout / infrastructure telemetry (Railway-friendly, throttled).
 */
import os from "os";
import mongoose from "mongoose";
import { getReadyRedis, isRedisReady } from "../../config/redis.js";
import { depositQueue } from "../../queues/depositQueue.js";
import { payoutQueue } from "../../queues/payoutQueue.js";
import HybridWithdrawal from "../models/HybridWithdrawal.js";
import { payoutObservabilitySnapshot } from "./payoutObservability.js";
import { registerShutdownHook } from "../../infra/processLifecycle.js";
import logger from "../../utils/logger.js";

let payoutMonitorTimer = null;
let shutdownHookRegistered = false;

function monitorIntervalMs() {
  return Math.min(300_000, Math.max(30_000, Number(process.env.HYBRID_PAYOUT_MONITOR_MS || 60_000)));
}

export function startPayoutInfrastructureMonitor() {
  if (payoutMonitorTimer) {
    return;
  }
  if (!shutdownHookRegistered) {
    shutdownHookRegistered = true;
    registerShutdownHook("hybrid_payout_infra_monitor", async () => {
      stopPayoutInfrastructureMonitor();
    });
  }
  const intervalMs = monitorIntervalMs();
  payoutMonitorTimer = setInterval(() => {
    void emitPayoutInfraSnapshot(intervalMs);
  }, intervalMs);
  payoutMonitorTimer.unref?.();
  void emitPayoutInfraSnapshot(intervalMs);
}

export function stopPayoutInfrastructureMonitor() {
  if (payoutMonitorTimer != null) {
    clearInterval(payoutMonitorTimer);
    payoutMonitorTimer = null;
  }
}

async function emitPayoutInfraSnapshot(intervalMs) {
  try {
    const memMb = Math.round((process.memoryUsage().rss / 1048576) * 10) / 10;
    const mongoOk = mongoose.connection.readyState === 1;
    const redis = getReadyRedis();
    let redisOk = false;
    let redisLatencyMs = null;
    if (redis && isRedisReady(redis)) {
      const t0 = Date.now();
      try {
        redisOk = (await redis.ping()) === "PONG";
        redisLatencyMs = Date.now() - t0;
      } catch {
        redisOk = false;
      }
    }

    let depositQ = null;
    let payoutQ = null;
    try {
      if (depositQueue) {
        const c = await depositQueue.getJobCounts("waiting", "delayed", "active", "failed");
        depositQ = {
          waiting: Number(c.waiting || 0) + Number(c.delayed || 0),
          active: Number(c.active || 0),
          failed: Number(c.failed || 0),
        };
      }
    } catch {
      depositQ = null;
    }
    try {
      if (payoutQueue) {
        const c = await payoutQueue.getJobCounts("waiting", "delayed", "active", "failed");
        payoutQ = {
          waiting: Number(c.waiting || 0) + Number(c.delayed || 0),
          active: Number(c.active || 0),
          failed: Number(c.failed || 0),
        };
      }
    } catch {
      payoutQ = null;
    }

    let pendingTxHybrid = null;
    try {
      pendingTxHybrid = await HybridWithdrawal.countDocuments({
        status: "approved",
        paidAt: null,
        payoutStatus: { $in: ["sending", "verifying"] },
      });
    } catch {
      pendingTxHybrid = null;
    }

    let executorSnap = null;
    try {
      const eng = await import("../engine/index.js");
      executorSnap = eng.getHybridWithdrawExecutorStatus?.() ?? null;
    } catch {
      executorSnap = null;
    }

    logger.throttledInfo(
      "payout_infra_pulse",
      "PAYOUT_INFRA_SNAPSHOT",
      {
        memRssMb: memMb,
        loadAvg: os.loadavg?.()[0],
        mongoOk,
        redisOk,
        redisLatencyMs,
        depositQueue: depositQ,
        payoutQueue: payoutQ,
        hybridPendingBroadcastRows: pendingTxHybrid,
        withdrawExecutor: executorSnap,
        payoutObservability: payoutObservabilitySnapshot(),
      },
      Math.min(intervalMs, 60_000),
    );
  } catch (err) {
    logger.throttledWarn(
      "payout_monitor_err",
      "Payout infra monitor tick failed",
      { error: err?.message || String(err) },
      120_000,
    );
  }
}
