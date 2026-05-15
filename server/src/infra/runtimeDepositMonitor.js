import mongoose from "mongoose";
import logger from "../utils/logger.js";
import depositPipelineConfig from "../config/depositPipelineConfig.js";
import { depositQueue } from "../queues/depositQueue.js";
import {
  connectRedisInBackground,
  getRedis,
  isRedisReady,
  pingRedisDeadline,
} from "../config/redis.js";
import { getWsRuntimeSnapshot } from "../hybrid/utils/wsProvider.js";
import { isHybridWebSocketRealtimeActive } from "../hybrid/listeners/realtimeListener.js";
import { WORKER_HEARTBEAT_KEY } from "../queues/workerSignals.js";
import { withProviderRetry, getRpcUrls } from "../hybrid/utils/provider.js";

/** @typedef {{ role: string, forceWorkerAssumeAlive?: boolean }} MonitorOptions */

let monitorStarted = false;

async function mongoReadyLabel() {
  const st = mongoose.connection.readyState;
  return st === 1 ? "connected" : `state_${st}`;
}

/**
 * Periodic lightweight infra snapshot for Railway stdout shipping.
 * @param {MonitorOptions} opts
 */
export function startDepositPipelineMonitor(opts = {}) {
  if (monitorStarted) {
    return;
  }

  monitorStarted = true;

  const role = String(opts.role || "deposit-pipeline");

  global.setInterval(async () => {
    const mem = process.memoryUsage();
    const redis = await connectRedisInBackground().catch(() => getRedis());

    /** @type {Record<string, unknown>} */
    const payload = {
      role,
      mongo: await mongoReadyLabel(),
      wsRuntime: typeof getWsRuntimeSnapshot === "function"
        ? getWsRuntimeSnapshot()
        : null,
      realtimeHealthy:
        typeof isHybridWebSocketRealtimeActive === "function"
          ? isHybridWebSocketRealtimeActive()
          : false,
      bullmq: depositQueue ? "online" : "disabled",
      memoryMb: Number((mem.heapUsed / (1024 * 1024)).toFixed(1)),
      rssMb: Number((mem.rss / (1024 * 1024)).toFixed(1)),
    };

    if (depositQueue && isRedisReady(redis)) {
      try {
        const counts = await depositQueue.getJobCounts(
          "waiting",
          "delayed",
          "active",
          "failed",
          "completed",
        );
        payload.queueCounts = counts;
      } catch (err) {
        payload.queueCounts = null;
        payload.queueWarn = err?.message || String(err);
      }
    }

    if (redis) {
      const redisPingStarted = Date.now();
      const redisPingBudget = Math.min(
        4000,
        Math.max(1500, Number(process.env.REDIS_HEALTH_PING_MS || 2500)),
      );
      const redisAlive = await pingRedisDeadline(redis, redisPingBudget);
      payload.redisPingMs =
        redisAlive === false ? null : Number(Date.now() - redisPingStarted);
      payload.redis = redisAlive ? "ready" : redis.status ?? "offline";
      if (!redisAlive && isRedisReady(redis) === false) {
        payload.redis = `not_ready:${redis.status}`;
      }

      try {
        if (WORKER_HEARTBEAT_KEY) {
          const hb = await redis.get(WORKER_HEARTBEAT_KEY);
          const ts = Number(hb);
          const workerFresh =
            Number.isFinite(ts) &&
            ts > 0 &&
            Date.now() - ts <= depositPipelineConfig.monitorIntervalMs + 4000;
          payload.workerHeartbeatFresh = workerFresh;
        }
      } catch (_) {
        payload.workerHeartbeatFresh = false;
      }
    } else {
      payload.redis = "missing_redis_env";
      payload.workerHeartbeatFresh = Boolean(opts.forceWorkerAssumeAlive);
    }

    const urls = typeof getRpcUrls === "function" ? getRpcUrls() : [];
    if (urls.length > 0) {
      const rpcStart = Date.now();
      try {
        await withProviderRetry((p) => p.getBlockNumber(), Math.min(6, urls.length * 2));
        payload.rpcGetBlockMs = Number(Date.now() - rpcStart);
      } catch (err) {
        payload.rpcGetBlockMs = null;
        payload.rpcWarn = err?.message || String(err);
      }
    }

    logger.info("DEPOSIT_PIPELINE_MONITOR", payload);
  }, depositPipelineConfig.monitorIntervalMs);
}
