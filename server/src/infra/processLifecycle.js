/**
 * Graceful shutdown + global error hooks for API, worker, and hybrid services.
 */
import mongoose from "mongoose";
import logger, { sanitizeForLog } from "../utils/logger.js";
import { disconnectRedisQuietly } from "../config/redis.js";
import { destroyHybridWsProvider } from "../hybrid/utils/wsProvider.js";

const shutdownHooks = [];

let shuttingDown = false;
/** @type {import("bullmq").Worker | null} */
let registeredDepositWorker = null;
/** @type {import("bullmq").Worker | null} */
let registeredPayoutWorker = null;

export function registerDepositWorkerInstance(workerInstance) {
  registeredDepositWorker = workerInstance ?? null;
}

export function registerPayoutWorkerInstance(workerInstance) {
  registeredPayoutWorker = workerInstance ?? null;
}

export function registerShutdownHook(name, fn) {
  if (typeof fn !== "function") {
    return;
  }
  shutdownHooks.push({
    name: String(name || "hook"),
    fn,
  });
}

async function flushShutdown(reason) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.warn("Graceful shutdown started", {
    reason: sanitizeForLog(String(reason || "signal")),
    hooks: shutdownHooks.length,
  });

  const reversed = [...shutdownHooks].reverse();
  for (const hook of reversed) {
    try {
      await hook.fn(reason);
    } catch (err) {
      logger.error(`Shutdown hook failed: ${hook.name}`, {
        error: sanitizeForLog(err?.message || String(err)),
      });
    }
  }

  if (registeredDepositWorker) {
    try {
      await registeredDepositWorker.close();
      logger.info("BullMQ deposit worker closed");
    } catch (err) {
      logger.error("BullMQ worker close failed", {
        error: sanitizeForLog(err?.message || String(err)),
      });
    }
    registeredDepositWorker = null;
  }

  if (registeredPayoutWorker) {
    try {
      await registeredPayoutWorker.close();
      logger.info("BullMQ hybrid payout worker closed");
    } catch (err) {
      logger.error("BullMQ payout worker close failed", {
        error: sanitizeForLog(err?.message || String(err)),
      });
    }
    registeredPayoutWorker = null;
  }

  destroyHybridWsProvider();

  try {
    if (mongoose.connection?.readyState === 1) {
      await mongoose.disconnect();
      logger.info("MongoDB disconnected (shutdown)");
    }
  } catch (err) {
    logger.error("Mongo disconnect failed on shutdown", {
      error: sanitizeForLog(err?.message || String(err)),
    });
  }

  await disconnectRedisQuietly();
}

const EXIT_AFTER_MS = Number(process.env.SHUTDOWN_DRAIN_MS || 12_000);
const HARD_EXIT_CODE = Number(process.env.FATAL_EXIT_CODE || 1);
const IGNORE_UNHANDLED_REJECTION_EXIT =
  String(process.env.DISABLE_EXIT_ON_UNHANDLED_REJECTION || "").toLowerCase() === "true";

let globalHandlersInstalled = false;

export function registerGlobalProcessHandlers(role = "process") {
  if (globalHandlersInstalled) {
    return;
  }
  globalHandlersInstalled = true;

  process.on("uncaughtException", (err) => {
    logger.error(`[${role}] uncaughtException`, {
      error: sanitizeForLog(err?.stack || err?.message || String(err)),
    });
    void (async () => {
      await flushShutdown("uncaughtException");
      setTimeout(() => process.exit(HARD_EXIT_CODE), Math.max(250, EXIT_AFTER_MS)).unref?.();
    })();
  });

  process.on("unhandledRejection", (reason) => {
    logger.error(`[${role}] unhandledRejection`, {
      reason: sanitizeForLog(
        typeof reason === "object" &&
          reason !== null &&
          /** @type {{ stack?: unknown }} */ (reason).stack != null
          ? /** @type {Error} */ (reason).stack
          : typeof reason === "object" &&
              reason !== null &&
              /** @type {{ message?: unknown }} */ (reason).message != null
            ? /** @type {{ message?: string }} */ (reason).message
            : reason
      ),
    });
    if (IGNORE_UNHANDLED_REJECTION_EXIT === true) {
      return;
    }
    void (async () => {
      await flushShutdown("unhandledRejection");
      setTimeout(() => process.exit(HARD_EXIT_CODE), Math.max(250, EXIT_AFTER_MS)).unref?.();
    })();
  });

  ["SIGTERM", "SIGINT"].forEach((sig) => {
    process.on(sig, () => {
      logger.warn(`${sig} received — draining`, { role });
      void (async () => {
        await flushShutdown(sig);
        process.exit(0);
      })();
    });
  });
}

export function __testOnly_resetLifecycleState() {
  shuttingDown = false;
  shutdownHooks.length = 0;
  registeredDepositWorker = null;
  registeredPayoutWorker = null;
  globalHandlersInstalled = false;
}
