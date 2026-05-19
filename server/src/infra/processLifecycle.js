/**
 * Graceful shutdown + global error hooks for API, worker, and hybrid services.
 */
import mongoose from "mongoose";
import logger, { sanitizeForLog } from "../utils/logger.js";
import { disconnectRedisQuietly } from "../config/redis.js";
import { destroyHybridRpcProvider } from "../hybrid/utils/provider.js";
import { destroyHybridWsProvider } from "../hybrid/utils/wsProvider.js";

const shutdownHooks = [];

let shuttingDown = false;
let runtimeUnhealthy = false;
let fatalShutdownReason = null;
let fatalShutdownScheduled = false;
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

export function isRuntimeShuttingDown() {
  return shuttingDown || runtimeUnhealthy;
}

export function getProcessLifecycleStatus() {
  return {
    shuttingDown,
    runtimeUnhealthy,
    fatalShutdownReason,
  };
}

function markRuntimeUnhealthy(reason) {
  runtimeUnhealthy = true;
  fatalShutdownReason = sanitizeForLog(String(reason || "fatal"));
}

async function flushStdIo() {
  await Promise.allSettled(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise((resolve) => {
          try {
            stream.write("", () => resolve());
          } catch {
            resolve();
          }
        }),
    ),
  );
}

async function closeWorkerWithDeadline(worker, label) {
  if (!worker) {
    return;
  }

  const deadlineMs = Math.min(
    30_000,
    Math.max(1_000, Number(process.env.BULLMQ_WORKER_CLOSE_MS || 8_000)),
  );

  try {
    await Promise.race([
      worker.close(false),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("worker close deadline exceeded")), deadlineMs),
      ),
    ]);
    logger.info(`${label} closed`);
  } catch (err) {
    logger.warn(`${label} graceful close deadline exceeded — force closing`, {
      error: sanitizeForLog(err?.message || String(err)),
      deadlineMs,
    });
    try {
      await worker.close(true);
    } catch (forceErr) {
      logger.error(`${label} force close failed`, {
        error: sanitizeForLog(forceErr?.message || String(forceErr)),
      });
    }
  }
}

async function flushShutdown(reason) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  runtimeUnhealthy = true;
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
    await closeWorkerWithDeadline(registeredDepositWorker, "BullMQ deposit worker");
    registeredDepositWorker = null;
  }

  if (registeredPayoutWorker) {
    await closeWorkerWithDeadline(registeredPayoutWorker, "BullMQ hybrid payout worker");
    registeredPayoutWorker = null;
  }

  destroyHybridWsProvider();
  destroyHybridRpcProvider();

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

let globalHandlersInstalled = false;

function scheduleFatalShutdown(reason) {
  markRuntimeUnhealthy(reason);
  process.exitCode = HARD_EXIT_CODE;
  if (fatalShutdownScheduled) {
    return;
  }
  fatalShutdownScheduled = true;

  const hardExitTimer = setTimeout(() => {
    logger.error("Fatal shutdown drain deadline exceeded — forcing exit", {
      reason: sanitizeForLog(String(reason || "fatal")),
      exitCode: HARD_EXIT_CODE,
    });
    process.exit(HARD_EXIT_CODE);
  }, Math.max(250, EXIT_AFTER_MS));
  hardExitTimer.unref?.();

  void (async () => {
    try {
      await flushShutdown(reason);
      await flushStdIo();
    } catch (err) {
      logger.error("Fatal shutdown drain raised", {
        reason: sanitizeForLog(String(reason || "fatal")),
        error: sanitizeForLog(err?.message || String(err)),
      });
    } finally {
      clearTimeout(hardExitTimer);
      process.exit(HARD_EXIT_CODE);
    }
  })();
}

export function registerGlobalProcessHandlers(role = "process") {
  if (globalHandlersInstalled) {
    return;
  }
  globalHandlersInstalled = true;

  process.on("uncaughtException", (err) => {
    markRuntimeUnhealthy("uncaughtException");
    logger.error(`[${role}] FATAL uncaughtException — draining then exiting`, {
      error: sanitizeForLog(err?.stack || err?.message || String(err)),
      exitCode: HARD_EXIT_CODE,
    });
    scheduleFatalShutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason) => {
    markRuntimeUnhealthy("unhandledRejection");
    logger.error(`[${role}] FATAL unhandledRejection — draining then exiting`, {
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
      exitCode: HARD_EXIT_CODE,
    });
    scheduleFatalShutdown("unhandledRejection");
  });

  ["SIGTERM", "SIGINT"].forEach((sig) => {
    process.on(sig, () => {
      logger.warn(`${sig} received — draining`, { role });
      void (async () => {
        await flushShutdown(sig);
        await flushStdIo();
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
  runtimeUnhealthy = false;
  fatalShutdownReason = null;
  fatalShutdownScheduled = false;
}