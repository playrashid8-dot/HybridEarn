/**
 * Private HYBRID2 worker runtime.
 * No HTTP server is exposed from this process.
 */
import "./config/loadEnv.js";
import "./infra/outboundDebug.js";

import connectDB, { pingMongoDeadline } from "./config/db.js";
import {
  connectRedisInBackground,
  getReadyRedis,
  isRedisReady,
} from "./config/redis.js";
import { resolveRedisUrlFromEnv } from "./config/envNormalize.js";
import { registerGlobalProcessHandlers } from "./infra/processLifecycle.js";
import logger from "./utils/logger.js";
import { WORKER_HEARTBEAT_KEY } from "./queues/workerSignals.js";
import { startDepositPipelineMonitor } from "./infra/runtimeDepositMonitor.js";
import { startHybridTreasuryEngine } from "./hybrid/engine/index.js";
import { checkRpcHealth, getRpcUrls } from "./hybrid/utils/provider.js";
import { startPayoutInfrastructureMonitor } from "./hybrid/utils/payoutInfraMonitor.js";

registerGlobalProcessHandlers("hybrid-service");

const REQUIRED_ENV_VARS = [
  "MONGO_URI",
  "HYBRID_ADMIN_WALLET",
  "HYBRID_MNEMONIC",
  "HYBRID_PRIVATE_KEY_ENCRYPTION_SECRET",
];

const missingRequiredEnv = REQUIRED_ENV_VARS.filter(
  (key) => !String(process.env[key] || "").trim()
);

if (!resolveRedisUrlFromEnv()) {
  missingRequiredEnv.push("REDIS_URL");
}

if (
  !String(
    process.env.HYBRID_GAS_FUNDER_PRIVATE_KEY ||
      process.env.HYBRID_FUNDER_PRIVATE_KEY ||
      process.env.HYBRID_GAS_PK ||
      "",
  ).trim()
) {
  missingRequiredEnv.push("HYBRID_GAS_FUNDER_PRIVATE_KEY");
}

if (missingRequiredEnv.length > 0) {
  logger.error("Hybrid service missing env — exiting", {
    keys: missingRequiredEnv.join(","),
  });
  process.exit(1);
}

await connectDB();

const mongoReady = await pingMongoDeadline(Number(process.env.MONGO_PING_DEADLINE_MS || 8000));
if (!mongoReady) {
  logger.error("Hybrid service cannot reach Mongo during boot — exiting", {});
  process.exit(1);
}

if (getRpcUrls().length === 0) {
  logger.error("BSC RPC URL missing during hybrid boot — exiting", {});
  process.exit(1);
}

if (!(await checkRpcHealth())) {
  logger.warn("BSC RPC unreachable during hybrid boot — continuing in degraded external network mode", {
    externalHost: "bsc_rpc_pool",
    timeoutMs: Number(process.env.HYBRID_RPC_CALL_TIMEOUT_MS || process.env.EXTERNAL_NETWORK_TIMEOUT_MS || 30_000),
    retryCount: 0,
    requestPurpose: "hybrid_boot_rpc_probe",
    degradedNetworkMode: true,
    skippedRetryReason: "transient_rpc_boot_probe_failed_runtime_continues",
  });
}

if (!String(process.env.HYBRID_PAYOUT_PRIVATE_KEY || "").trim()) {
  logger.error("HYBRID_PAYOUT_PRIVATE_KEY required for automated payouts — exiting", {});
  process.exit(1);
}

logger.info("Hybrid dedicated service cold start", {});

if (process.env.WITHDRAW_EXECUTOR_ENABLED !== "true") {
  logger.warn(
    "HYBRID2 forcing withdraw executor on — dedicated hybrid service owns payout runtime",
    { previous: String(process.env.WITHDRAW_EXECUTOR_ENABLED ?? "") },
  );
  process.env.WITHDRAW_EXECUTOR_ENABLED = "true";
}

if (String(process.env.HYBRID_PAYOUT_USE_QUEUE || "").toLowerCase() !== "true") {
  logger.warn(
    "HYBRID2 forcing payout scheduler through BullMQ — private worker runtime owns execution",
    { previous: String(process.env.HYBRID_PAYOUT_USE_QUEUE ?? "") },
  );
  process.env.HYBRID_PAYOUT_USE_QUEUE = "true";
}

await connectRedisInBackground();
if (!getReadyRedis()) {
  process.exit(1);
}

await startBullMqWorkerRuntime();

try {
  const r = getReadyRedis();
  if (r && isRedisReady(r)) {
    const heartbeat = await r.get(WORKER_HEARTBEAT_KEY);
    const hbNum = Number(heartbeat);
    const workerAliveWithin60s =
      Number.isFinite(hbNum) && hbNum > 0 && Date.now() - hbNum <= 60_000;

    if (!workerAliveWithin60s) {
      logger.warn("Hybrid service detected stale worker heartbeat — Bull queue may backlog", {});
      if (String(process.env.FAIL_API_ON_WORKER_DOWN || "").toLowerCase() === "true") {
        logger.error("FAIL_API_ON_WORKER_DOWN enforced — exiting hybrid replica", {});
        process.exit(1);
      }
    }
  }
} catch (err) {
  logger.warn("Worker heartbeat telemetry read failed on hybrid replica", {
    error: err?.message || String(err),
  });
}

startHybridTreasuryEngine();

if (String(process.env.DISABLE_PAYOUT_INFRA_MONITOR || "").toLowerCase() !== "true") {
  startPayoutInfrastructureMonitor();
}

if (String(process.env.DISABLE_HYBRID_PIPELINE_MONITOR || "").toLowerCase() !== "true") {
  startDepositPipelineMonitor({ role: "hybrid-engine" });
}

async function startBullMqWorkerRuntime() {
  const originalDisablePayoutInfraMonitor = process.env.DISABLE_PAYOUT_INFRA_MONITOR;
  const originalDisableWorkerPipelineMonitor = process.env.DISABLE_WORKER_PIPELINE_MONITOR;
  const originalHybridPayoutQueueWorker = process.env.HYBRID_PAYOUT_QUEUE_WORKER;

  process.env.DISABLE_PAYOUT_INFRA_MONITOR = "true";
  process.env.DISABLE_WORKER_PIPELINE_MONITOR = "true";
  if (String(process.env.HYBRID_PAYOUT_QUEUE_WORKER || "").toLowerCase() !== "true") {
    logger.warn(
      "HYBRID2 forcing payout queue worker registration — private worker runtime owns hybridPayout",
      { previous: String(process.env.HYBRID_PAYOUT_QUEUE_WORKER ?? "") },
    );
  }
  process.env.HYBRID_PAYOUT_QUEUE_WORKER = "true";

  try {
    await import("./worker.js");
  } finally {
    restoreEnvValue("DISABLE_PAYOUT_INFRA_MONITOR", originalDisablePayoutInfraMonitor);
    restoreEnvValue("DISABLE_WORKER_PIPELINE_MONITOR", originalDisableWorkerPipelineMonitor);
    restoreEnvValue("HYBRID_PAYOUT_QUEUE_WORKER", originalHybridPayoutQueueWorker);
  }
}

function restoreEnvValue(key, value) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}