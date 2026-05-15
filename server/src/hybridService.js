/**
 * Dedicated process for WebSocket + hybrid engine (polling/sweep/recovery).
 * Run a single replica in production. API traffic should use NOVA_SERVICE=api replicas.
 */
import "./config/loadEnv.js";

import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import connectDB, { pingMongoDeadline } from "./config/db.js";
import {
  connectRedisInBackground,
  getReadyRedis,
  isRedisReady,
} from "./config/redis.js";
import {
  registerGlobalProcessHandlers,
  registerShutdownHook,
} from "./infra/processLifecycle.js";
import logger from "./utils/logger.js";
import { WORKER_HEARTBEAT_KEY } from "./queues/workerSignals.js";
import { startDepositPipelineMonitor } from "./infra/runtimeDepositMonitor.js";
import { runHybridStartupRecovery, startHybridEngine } from "./hybrid/engine/index.js";
import { startRealtimeListener } from "./hybrid/listeners/realtimeListener.js";
import { checkRpcHealth } from "./hybrid/utils/provider.js";
import { getSystemHealth, getSystemHealthHttpStatus } from "./hybrid/utils/systemHealth.js";
import { runDepositBackfillOnStartup } from "./hybrid/services/depositBackfill.js";
import { startPayoutInfrastructureMonitor } from "./hybrid/utils/payoutInfraMonitor.js";

registerGlobalProcessHandlers("hybrid-service");

const REQUIRED_ENV_VARS = [
  "MONGO_URI",
  "JWT_SECRET",
  "HYBRID_ADMIN_WALLET",
  "HYBRID_PRIVATE_KEY_ENCRYPTION_SECRET",
];

const missingRequiredEnv = REQUIRED_ENV_VARS.filter(
  (key) => !String(process.env[key] || "").trim()
);

if (missingRequiredEnv.length > 0) {
  logger.error("Hybrid service missing env — exiting", {
    keys: missingRequiredEnv.join(","),
  });
  process.exit(1);
}

const hybridWs = String(process.env.HYBRID_BSC_WS_URL || process.env.BSC_WS_URL || "").trim();

if (!hybridWs) {
  logger.warn(
    "HYBRID_BSC_WS_URL missing — realtime listener will subscribe via JSON-RPC polling only",
    {},
  );
} else {
  logger.debug?.("Hybrid websocket bootstrap URL configured", {
    hostPreview: hybridWs.split("@").pop()?.slice(0, 58),
  });
}

await connectDB();

const mongoReady = await pingMongoDeadline(Number(process.env.MONGO_PING_DEADLINE_MS || 8000));
if (!mongoReady) {
  logger.error("Hybrid service cannot reach Mongo during boot — exiting", {});
  process.exit(1);
}

if (!(await checkRpcHealth())) {
  logger.error("BSC RPC unreachable during hybrid boot — exiting", {});
  process.exit(1);
}

if (!String(process.env.HYBRID_PAYOUT_PRIVATE_KEY || "").trim()) {
  logger.error("HYBRID_PAYOUT_PRIVATE_KEY required for automated payouts — exiting", {});
  process.exit(1);
}

logger.info("Hybrid dedicated service cold start", {});

try {
  await startRealtimeListener();
} catch (err) {
  logger.error("Hybrid realtime listener bootstrap fault", {
    error: err?.message || String(err),
  });
}

try {
  await connectRedisInBackground();
} catch (err) {
  logger.error("Hybrid Redis warm handshake failed", {
    error: err?.message || String(err),
  });
}

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

try {
  await runDepositBackfillOnStartup();
} catch (err) {
  logger.error("Hybrid startup recovery scan fault", {
    error: err?.message || String(err),
  });
}

try {
  await runHybridStartupRecovery({ blocks: 1000 });
} catch (err) {
  logger.warn("Hybrid pending ledger retry pass fault — non-fatal", {
    error: err?.message || String(err),
  });
}

startHybridEngine();

if (String(process.env.DISABLE_PAYOUT_INFRA_MONITOR || "").toLowerCase() !== "true") {
  startPayoutInfrastructureMonitor();
}

const app = express();
const PORT = Number(process.env.PORT) || 5050;

let httpServer;

registerShutdownHook("hybrid_http_listener", async () => {
  if (!httpServer) return;
  await new Promise((resolve) => {
    httpServer.close(() => resolve());
  });
  logger.info("Hybrid health server drained", {});
});

app.set("trust proxy", 1);

const healthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: {
    success: false,
    msg: "Too many requests, try again later ❌",
    data: null,
  },
});

app.use("/api/health", healthLimiter);
app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    msg: "Health check ok",
    data: { status: "ok" },
  });
});

app.use("/system/health", healthLimiter);
app.get("/system/health", async (_req, res) => {
  const health = await getSystemHealth();
  const httpStatus = getSystemHealthHttpStatus(health);
  res.status(httpStatus).json({
    success: health.status === "ok",
    msg: health.status === "ok" ? "System healthy" : "System degraded",
    data: health,
  });
});

httpServer = app.listen(PORT, () => {
  logger.info(`Hybrid health + engine supervisor listening ${PORT}`, {
    pid: process.pid,
  });
});

if (String(process.env.DISABLE_HYBRID_PIPELINE_MONITOR || "").toLowerCase() !== "true") {
  startDepositPipelineMonitor({ role: "hybrid-engine" });
}
