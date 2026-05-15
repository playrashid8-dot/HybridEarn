import Redis from "ioredis";
import logger from "../utils/logger.js";
import { resolveRedisUrlFromEnv } from "./envNormalize.js";

let client;
let redisErrorLogged = false;

export function getRedis() {
  const url = resolveRedisUrlFromEnv();
  if (!url) {
    return null;
  }
  if (!String(process.env.REDIS_URL || "").trim()) {
    process.env.REDIS_URL = url;
  }

  if (!client) {
    try {
      client = new Redis(url, {
        enableReadyCheck: false,
        enableOfflineQueue: true,
        maxRetriesPerRequest: null,
        keepAlive: 30000,
        connectTimeout: 10000,
        lazyConnect: true,
        retryStrategy: (times) => {
          if (times > 24) return null;
          return Math.min(times * 500, 10_000);
        },
      });
    } catch (err) {
      logger.error("Redis init failed", { error: err?.message || String(err) });
      client = null;
      return null;
    }

    client.on("connect", () => {
      logger.info("Redis connected");
    });

    client.on("error", (err) => {
      if (!redisErrorLogged) {
        redisErrorLogged = true;
        logger.error("Redis unavailable", {
          error: err?.message || String(err),
        });
      }
    });
  }

  return client;
}

export function isRedisReady(redis = client) {
  return Boolean(redis && redis.status === "ready");
}

export async function pingRedisDeadline(redisConn, deadlineMs = 2500) {
  if (!redisConn) return false;

  /** @returns {Promise<unknown>} */
  const ping = redisConn.ping();
  try {
    const budget =
      typeof deadlineMs === "number" && Number.isFinite(deadlineMs)
        ? deadlineMs
        : 2500;
    await Promise.race([
      ping,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("redis ping timeout")), Math.max(200, budget)),
      ),
    ]);
    return redisConn.status === "ready";
  } catch (_) {
    return false;
  }
}

export async function disconnectRedisQuietly() {
  if (!client || client.status === "end") {
    return;
  }
  try {
    await client.quit().catch(async () => {
      try {
        client.disconnect(false);
      } catch (_) {
        /* noop */
      }
    });
    client = null;
    redisErrorLogged = false;
    logger.info("Redis client closed cleanly");
  } catch (err) {
    logger.warn("Redis disconnect raised", {
      error: err?.message || String(err),
    });
  }
}

export function getReadyRedis() {
  const redis = getRedis();
  return isRedisReady(redis) ? redis : null;
}

export async function ensureRedisReady(maxWaitMs = 8000) {
  const redis = getRedis();
  if (!redis) {
    return null;
  }

  await connectRedisInBackground();

  const capMs =
    typeof maxWaitMs === "number" && Number.isFinite(maxWaitMs)
      ? Math.max(250, maxWaitMs)
      : 8000;
  const start = Date.now();

  try {
    if (redis.status === "wait") {
      await redis.connect();
    }
  } catch {
    /* connect may reject if already progressing */
  }

  while (Date.now() - start < capMs) {
    if (isRedisReady(redis)) {
      return redis;
    }
    if (redis.status === "end") {
      return null;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  return isRedisReady(redis) ? redis : null;
}

export async function connectRedisInBackground() {
  const redisIns = getRedis();
  if (!redisIns || isRedisReady(redisIns) || redisIns.status === "connecting") {
    return redisIns;
  }

  try {
    await redisIns.connect();
  } catch (err) {
    if (!redisErrorLogged) {
      redisErrorLogged = true;
      logger.error("Redis handshake failed", {
        error: err?.message || String(err),
      });
    }
  }

  return redisIns;
}
