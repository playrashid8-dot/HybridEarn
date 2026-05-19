/**
 * HYBRID-DEPOSIT runtime.
 * Read-only blockchain scanner: no HTTP API, no treasury keys, no withdrawals.
 */
import "./config/loadEnv.js";
import "./infra/outboundDebug.js";

import connectDB, { pingMongoDeadline } from "./config/db.js";
import { connectRedisInBackground, getReadyRedis } from "./config/redis.js";
import { resolveRedisUrlFromEnv } from "./config/envNormalize.js";
import { registerGlobalProcessHandlers } from "./infra/processLifecycle.js";
import { startDepositPipelineMonitor } from "./infra/runtimeDepositMonitor.js";
import { startRealtimeListener } from "./hybrid/listeners/realtimeListener.js";
import {
  runDepositBackfillOnStartup,
  startDepositRecoveryIntervals,
  startDepositSafetyRescanInterval,
} from "./hybrid/services/depositBackfill.js";
import { checkRpcHealth, getRpcUrls } from "./hybrid/utils/provider.js";
import logger from "./utils/logger.js";

registerGlobalProcessHandlers("hybrid-deposit");

process.env.DISABLE_WEBSOCKET = String(process.env.DISABLE_WEBSOCKET || "true");
process.env.FORCE_POLLING = String(process.env.FORCE_POLLING || "true");
process.env.WITHDRAW_EXECUTOR_ENABLED = "false";

const forbiddenTreasuryKeys = [
  "HYBRID_PAYOUT_PRIVATE_KEY",
  "HYBRID_GAS_FUNDER_PRIVATE_KEY",
  "HYBRID_GAS_PK",
].filter((key) => String(process.env[key] || "").trim());

if (forbiddenTreasuryKeys.length > 0) {
  logger.warn("HYBRID-DEPOSIT treasury key env present — remove from scanner service", {
    keys: forbiddenTreasuryKeys.join(","),
  });
}

const required = ["MONGO_URI", "HYBRID_USDT_CONTRACT"].filter(
  (key) => !String(process.env[key] || "").trim(),
);

if (!resolveRedisUrlFromEnv()) {
  required.push("REDIS_URL");
}

if (required.length > 0) {
  logger.error("HYBRID-DEPOSIT missing env — exiting", {
    keys: required.join(","),
  });
  process.exit(1);
}

await connectDB();

const mongoReady = await pingMongoDeadline(Number(process.env.MONGO_PING_DEADLINE_MS || 8000));
if (!mongoReady) {
  logger.error("HYBRID-DEPOSIT cannot reach Mongo during boot — exiting", {});
  process.exit(1);
}

if (getRpcUrls().length === 0) {
  logger.error("HYBRID-DEPOSIT RPC URL missing — exiting", {});
  process.exit(1);
}

await connectRedisInBackground().catch((err) => {
  logger.error("HYBRID-DEPOSIT Redis warmup failed", {
    error: err?.message || String(err),
  });
});

if (!getReadyRedis()) {
  logger.error("HYBRID-DEPOSIT Redis unavailable after warmup — exiting to avoid direct-credit scanner mode", {});
  process.exit(1);
}

if (!(await checkRpcHealth())) {
  logger.warn("HYBRID-DEPOSIT RPC health degraded at boot — failover/retry loop remains active", {});
}

try {
  await startRealtimeListener();
} catch (err) {
  logger.error("HYBRID-DEPOSIT polling listener bootstrap fault", {
    error: err?.message || String(err),
  });
}

try {
  await runDepositBackfillOnStartup();
} catch (err) {
  logger.warn("HYBRID-DEPOSIT startup deep recovery failed — periodic recovery will retry", {
    error: err?.message || String(err),
  });
}

startDepositSafetyRescanInterval();
startDepositRecoveryIntervals();

if (String(process.env.DISABLE_DEPOSIT_PIPELINE_MONITOR || "").toLowerCase() !== "true") {
  startDepositPipelineMonitor({ role: "hybrid-deposit" });
}

logger.info("HYBRID-DEPOSIT runtime ready", {
  polling: true,
  websocketDisabled: true,
  treasuryKeysLoaded: false,
});
