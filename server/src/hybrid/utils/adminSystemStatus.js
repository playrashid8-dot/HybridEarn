import mongoose from "mongoose";
import { getProvider, getWsProvider } from "./provider.js";
import {
  isHybridRealtimeListenerStarted,
  isHybridWebSocketRealtimeActive,
} from "../listeners/realtimeListener.js";
import { userMap } from "../services/userMap.js";
import { depositQueue } from "../../queues/depositQueue.js";
import {
  connectRedisInBackground,
  getRedis,
  getReadyRedis,
  isRedisReady,
} from "../../config/redis.js";
import { getHybridWithdrawExecutorStatus } from "../engine/index.js";

const WORKER_HEARTBEAT_KEYS = ["worker:heartbeat", "depositQueue:worker:heartbeat"];
const WORKER_HEARTBEAT_MAX_AGE_MS = 120000;
/** Hybrid process stamps this when executor runs while holding leader lock; API replicas read it for live status. */
const WITHDRAW_EXECUTOR_PULSE_KEY = "hybrid:withdraw_executor:pulse";

function isWsSocketOpen() {
  try {
    const p = getWsProvider();
    const sock = p?.websocket ?? p?._websocket;
    return Boolean(sock && sock.readyState === 1);
  } catch (_) {
    return false;
  }
}

async function redisStatusAndClient() {
  await connectRedisInBackground();
  const redisClient = getRedis();
  const statusReady =
    Boolean(redisClient) && redisClient.status === "ready";
  let redisBool = false;
  if (!statusReady || !redisClient) {
    return { redis: false, redisClient: null };
  }
  try {
    redisBool = (await redisClient.ping()) === "PONG";
  } catch (_) {
    redisBool = false;
  }
  const redis =
    redisClient.status === "ready" && redisBool === true;
  return { redis, redisClient };
}

async function workerReachableFromRedis(redisClient) {
  if (!redisClient || !isRedisReady(redisClient)) {
    return false;
  }
  for (const key of WORKER_HEARTBEAT_KEYS) {
    try {
      const raw = await redisClient.get(key);
      const heartbeat = Number(raw);
      if (
        Number.isFinite(heartbeat) &&
        heartbeat > 0 &&
        Date.now() - heartbeat <= WORKER_HEARTBEAT_MAX_AGE_MS
      ) {
        return true;
      }
    } catch (_) {
      /* try next key */
    }
  }
  return false;
}

async function queueWorking(redisForQueue) {
  if (!redisForQueue || !depositQueue) {
    return false;
  }
  try {
    await depositQueue.getJobCounts();
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Executor “running” for dashboards: this process has the interval, or another hybrid
 * leader is actively ticking (Redis pulse), with WITHDRAW_EXECUTOR_ENABLED=true.
 */
async function resolveExecutorRunning(redisClient) {
  const exec = getHybridWithdrawExecutorStatus();
  const enabled = process.env.WITHDRAW_EXECUTOR_ENABLED === "true";
  if (!enabled) {
    return false;
  }
  if (exec?.scheduled) {
    return true;
  }
  if (!redisClient || !isRedisReady(redisClient)) {
    return false;
  }
  try {
    const pulse = await redisClient.get(WITHDRAW_EXECUTOR_PULSE_KEY);
    const ts = Number(pulse);
    const intervalMs = Math.max(
      Number(process.env.HYBRID_WITHDRAW_EXECUTOR_MS || 30000),
      5000,
    );
    const maxAge = Math.min(Math.max(intervalMs * 4, 120000), 600000);
    return (
      Number.isFinite(ts) &&
      ts > 0 &&
      Date.now() - ts <= maxAge
    );
  } catch (_) {
    return false;
  }
}

/**
 * Canonical flat shape for `GET /api/admin/system/status` and live dashboards.
 */
export async function getAdminDashboardSystemStatus() {
  try {
    await connectRedisInBackground();
  } catch (_) {
    /* status checks below still report disconnected */
  }

  const mongo = mongoose.connection.readyState === 1;

  const { redis, redisClient } = await redisStatusAndClient();

  let rpc = false;
  try {
    const provider = getProvider();
    await provider.getBlockNumber();
    rpc = true;
  } catch (_) {
    rpc = false;
  }

  const listener = isHybridRealtimeListenerStarted();
  const websocket =
    listener ||
    isHybridWebSocketRealtimeActive() ||
    isWsSocketOpen();

  const usersLoaded = userMap.size;

  const redisForQueue = getReadyRedis();
  const queue = await queueWorking(redisForQueue);

  const worker = await workerReachableFromRedis(redisClient);

  const executorRunning = await resolveExecutorRunning(redisClient);

  return {
    mongo,
    redis,
    rpc,
    listener,
    websocket,
    queue,
    worker,
    usersLoaded,
    executorRunning,
  };
}

/**
 * @deprecated Prefer {@link getAdminDashboardSystemStatus}; kept for older admin clients.
 */
export async function getHybridAdminSystemStatus() {
  const flat = await getAdminDashboardSystemStatus();
  return {
    mongodb: flat.mongo,
    redis: flat.redis,
    rpc: flat.rpc,
    listener: flat.listener,
    websocket: flat.websocket,
    usersLoaded: flat.usersLoaded,
    queueWorking: flat.queue,
    workerActive: flat.worker,
    executorRunning: flat.executorRunning,
  };
}
