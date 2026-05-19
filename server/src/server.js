import "./config/loadEnv.js";
import "./infra/outboundDebug.js";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import csrf from "csurf";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

// 🔥 DB + lifecycle
import connectDB, { pingMongoDeadline } from "./config/db.js";
import {
  connectRedisInBackground,
  ensureRedisReady,
  getRedis,
  isRedisReady,
} from "./config/redis.js";
import {
  registerGlobalProcessHandlers,
  registerShutdownHook,
} from "./infra/processLifecycle.js";
import logger from "./utils/logger.js";
import { WORKER_HEARTBEAT_KEY } from "./queues/workerSignals.js";
import { startDepositPipelineMonitor } from "./infra/runtimeDepositMonitor.js";

// 🔥 ROUTES
import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import depositRoutes from "./routes/depositRoutes.js";
import investmentRoutes from "./routes/investmentRoutes.js";
import withdrawalRoutes from "./routes/withdrawalRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import publicStatsRoutes from "./routes/publicStatsRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import historyRoutes from "./routes/historyRoutes.js";
import {
  roiRoutes,
  salaryRoutes,
  stakingRoutes,
  withdrawRoutes,
  hybridDepositRoutes,
  ledgerRoutes,
} from "./hybrid/routes/index.js";
import { startHybridEngine, runHybridStartupRecovery } from "./hybrid/engine/index.js";
import { startRealtimeListener } from "./hybrid/listeners/realtimeListener.js";
import { checkRpcHealth } from "./hybrid/utils/provider.js";
import { isHybridEarnEnabled } from "./hybrid/utils/hybridEarnEnv.js";
import { getSystemHealth, getSystemHealthHttpStatus } from "./hybrid/utils/systemHealth.js";
import { runDepositBackfillOnStartup } from "./hybrid/services/depositBackfill.js";

registerGlobalProcessHandlers("api-server");

const REQUIRED_ENV_VARS = [
  "MONGO_URI",
  "JWT_SECRET",
];

const missingRequiredEnv = REQUIRED_ENV_VARS.filter(
  (key) => !String(process.env[key] || "").trim()
);

const app = express();
const PORT = process.env.PORT || 5000;
let appReady = false;

const isProd =
  process.env.NODE_ENV === "production" ||
  process.env.RAILWAY_ENVIRONMENT === "production";

const crossSiteSameSite = isProd ? "none" : "lax";

const corsDefaultOrigins = [
  "https://hybridearn.com",
  "https://www.hybridearn.com",
  "https://novacentral.vercel.app",
  "http://localhost:3000",
];
const corsExtraOrigins = String(process.env.CLIENT_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const corsOrigins = [...corsDefaultOrigins, ...corsExtraOrigins];

const csrfProtection = csrf({
  cookie: {
    httpOnly: true,
    secure: isProd,
    sameSite: crossSiteSameSite,
  },
});

const corsConfig = {
  origin: corsOrigins,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  optionsSuccessStatus: 204,
  allowedHeaders: [
    "Content-Type",
    "CSRF-Token",
    "csrf-token",
    "X-CSRF-Token",
    "x-csrf-token",
    "X-XSRF-Token",
    "x-xsrf-token",
    "X-Requested-With",
    "Idempotency-Key",
  ],
};

/* ==============================
   🔥 TRUST PROXY (Railway fix)
============================== */
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

/* ==============================
   🧪 IMMEDIATE HEALTH CHECKS
============================== */
app.get("/", (req, res) => {
  res.json({
    success: true,
    msg: "API running",
    data: null,
  });
});

app.get("/api", (req, res) => {
  res.json({
    success: true,
    msg: "API working",
    data: null,
  });
});

app.get("/api/health", (req, res) => {
  if (!appReady) {
    return res.status(503).json({
      success: false,
      msg: "Application booting",
      data: {
        ready: false,
      },
    });
  }

  return res.status(200).json({
    success: true,
    msg: "API healthy",
    data: {
      ready: true,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
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

/**
 * infra: NOVA_SERVICE=api → HTTP API (+ realtime deposit listener when HYBRID_EARN_ENABLED=true).
 * NOVA_SERVICE=hybrid → run src/hybridService.js (not this file) for dedicated hybrid process.
 * default / all → full monolith: listener + engine/backfill/recovery (backward compatible).
 */
const novaService = (process.env.NOVA_SERVICE ?? "all").trim().toLowerCase();
/** Engine, startup backfill, recovery — avoid duplicate work on api-only replicas. Listener runs regardless (see startBackgroundServices). */
const hybridStackEnabled = novaService !== "api" && novaService !== "hybrid";

/* ==============================
   🔐 GLOBAL SECURITY
============================== */

// Express 5 / path-to-regexp v6: avoid `app.options('/*')` / `*` patterns that may throw at route registration.
app.use(cors(corsConfig));
app.options(/.*/, cors(corsConfig));

// ✅ COOKIES FIRST (needed before CSRF / body-dependent verification)
app.use(cookieParser());
// ✅ BODY PARSER (LIMITED SIZE)
app.use(express.json({ limit: "10kb" }));
// ✅ CSRF (after cookieParser + JSON — required for cookie-based secrets)
app.use(csrfProtection);

// ✅ HELMET (SECURITY HEADERS)
app.use(helmet());

app.use("/api/csrf-token", healthLimiter);
app.get("/api/csrf-token", (req, res) => {
  const token = req.csrfToken();

  /**
   * csurf stores the CSRF secret in `_csrf` (httpOnly); this handler only sets readable `XSRF-TOKEN`.
   * Does not touch the JWT `token` cookie.
   */
  res.cookie("XSRF-TOKEN", token, {
    httpOnly: false,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
    maxAge: 24 * 60 * 60 * 1000,
  });

  res.json({
    success: true,
    msg: "CSRF token generated",
    data: { csrfToken: token },
  });
});

// ✅ HTTP request logger (minimal in production)
app.use(morgan(isProd ? "tiny" : "dev"));

/* ==============================
   🚫 GLOBAL RATE LIMIT (ANTI DDOS)
============================== */
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
});

app.use(globalLimiter);

/* ==============================
   🔐 AUTH RATE LIMIT (STRICT)
============================== */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: {
    success: false,
    msg: "Too many requests, try again later ❌",
    data: null,
  },
});

/* ==============================
   🔥 ROUTE LOGGER (DEV)
============================== */
app.use((req, res, next) => {
  logger.debug?.("api request", { method: req.method, path: req.originalUrl });
  next();
});

/* ==============================
   🔥 API ROUTES
============================== */
app.use("/api/public", healthLimiter, publicStatsRoutes);
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/deposit", depositRoutes);
app.use("/api/investment", investmentRoutes);
app.use("/api/withdrawal", withdrawalRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/history", historyRoutes);
app.use("/api/roi", roiRoutes);
app.use("/api/salary", salaryRoutes);
app.use("/api/stake", stakingRoutes);
app.use("/api/withdraw", withdrawRoutes);
app.use("/api/hybrid/deposit", hybridDepositRoutes);
app.use("/api/hybrid/ledger", ledgerRoutes);

/* ==============================
   ❌ 404 HANDLER
============================== */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    msg: "Route not found ❌",
    data: null,
  });
});

/* ==============================
   🔥 GLOBAL ERROR HANDLER
============================== */
app.use((err, req, res, next) => {
  if (err?.code === "EBADCSRFTOKEN") {
    return res.status(403).json({
      success: false,
      msg: "Invalid or missing CSRF token",
      data: null,
    });
  }
  logger.error("Express error handler", {
    error: err?.message || String(err),
    path: req.originalUrl,
    method: req.method,
  });

  if (!err.statusCode) err.statusCode = 500;

  res.status(err.statusCode).json({
    success: false,
    msg: err.statusCode < 500 ? err.message : "Internal server error",
    data: null,
  });
});

/* ==============================
   🚀 START SERVER
============================== */
let server;

registerShutdownHook("http_listener", async () => {
  if (!server) return;
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
  logger.info("HTTP listener closed gracefully", {});
});

async function validateBootRequirements() {
  if (missingRequiredEnv.length > 0) {
    throw new Error(`Missing required env var(s): ${missingRequiredEnv.join(",")}`);
  }

  const mongoPingOk = await pingMongoDeadline(
    Number(process.env.MONGO_PING_DEADLINE_MS || 8000),
  );
  if (!mongoPingOk) {
    throw new Error("Mongo readiness ping failed — check replica set connectivity");
  }

  const requireRedis = String(process.env.REQUIRE_REDIS || "").toLowerCase() === "true";
  const requireDepositWorker =
    String(process.env.REQUIRE_DEPOSIT_WORKER || "").toLowerCase() === "true";

  const redisDeadlineMs = Number(process.env.REDIS_BOOT_READY_MS || 12_000);
  /** Lazy client + connect kickoff (handshake completes in ensureRedisReady when strict gates apply). */
  const redisClient = getRedis();
  await connectRedisInBackground();

  const strictRedisForBoot =
    requireRedis ||
    requireDepositWorker ||
    hybridStackEnabled ||
    isHybridEarnEnabled();

  let redisReady = false;
  if (!redisClient) {
    redisReady = false;
  } else if (strictRedisForBoot) {
    const r = await ensureRedisReady(Number.isFinite(redisDeadlineMs) ? redisDeadlineMs : 12_000);
    redisReady = Boolean(r && isRedisReady(r));
  } else {
    redisReady = isRedisReady(redisClient);
  }

  if (!redisReady) {
    if (requireRedis || requireDepositWorker) {
      throw new Error("Redis is required but not connected");
    }
    logger.warn("Redis unreachable — HYBRID may fall back to direct credit path temporarily", {});
  }

  if (redisReady) {
    if (hybridStackEnabled || requireDepositWorker || isHybridEarnEnabled()) {
      const heartbeat = await redisClient.get(WORKER_HEARTBEAT_KEY);
      const hbNum = Number(heartbeat);
      const workerAliveWithin60s =
        Number.isFinite(hbNum) &&
        hbNum > 0 &&
        Date.now() - hbNum <= 60_000;

      if (requireDepositWorker && !workerAliveWithin60s) {
        throw new Error("Deposit worker heartbeat missing or older than 60s");
      }

      if (!requireDepositWorker && !workerAliveWithin60s) {
        logger.warn("Deposit worker heartbeat stale — queue credit path may lag", {});
        if (String(process.env.FAIL_API_ON_WORKER_DOWN || "").toLowerCase() === "true") {
          throw new Error("FAIL_API_ON_WORKER_DOWN: worker heartbeat missing or stale (>60s)");
        }
      }
    }
  }

  const rpcAttempts = Math.max(
    1,
    Math.min(12, Number(process.env.RPC_BOOT_PROBE_ATTEMPTS || 3)),
  );
  let rpcReady = false;
  for (let attempt = 0; attempt < rpcAttempts; attempt++) {
    rpcReady = await checkRpcHealth();
    if (rpcReady) break;
    const backoffMs = Math.min(12_000, 600 * (attempt + 1) ** 1.35);
    logger.warn("RPC boot probe failed — retrying", {
      attempt: attempt + 1,
      max: rpcAttempts,
      backoffMs: Math.round(backoffMs),
    });
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  if (!rpcReady) {
    logger.warn("BSC RPC boot probe unavailable — continuing in degraded external network mode", {
      externalHost: "bsc_rpc_pool",
      timeoutMs: Number(process.env.HYBRID_RPC_CALL_TIMEOUT_MS || process.env.EXTERNAL_NETWORK_TIMEOUT_MS || 30_000),
      retryCount: rpcAttempts,
      requestPurpose: "api_boot_rpc_probe",
      degradedNetworkMode: true,
      skippedRetryReason: "startup_probe_exhausted_runtime_continues",
    });
  }

  if (isHybridEarnEnabled()) {
    const contract = String(process.env.HYBRID_USDT_CONTRACT || "").trim();
    if (!contract) {
      throw new Error(
        'HYBRID_USDT_CONTRACT is required when HYBRID_EARN_ENABLED=true (use lowercase 0x address)'
      );
    }
    if (contract !== contract.toLowerCase()) {
      throw new Error("HYBRID_USDT_CONTRACT must be lowercase (e.g. 0x55d398326f99059ff775485246999027b3197955)");
    }
  }

  if (novaService !== "api" && !String(process.env.HYBRID_PAYOUT_PRIVATE_KEY || "").trim()) {
    throw new Error("HYBRID_PAYOUT_PRIVATE_KEY is required for automated withdrawals");
  }
}

async function startServer() {
  server = app.listen(PORT, () => {
    logger.info(`HTTP API listening on ${PORT}`, {
      NOVA_SERVICE: novaService,
      hybridStackEnabled,
    });
    if (!hybridStackEnabled) {
      logger.warn(
        "Hybrid ledger engine skipped on this replica — ensure dedicated worker + hybrid service are running",
        { NOVA_SERVICE: novaService },
      );
    }
  });

  server.on("error", (err) => {
    logger.error("HTTP listener error", { error: err?.message || String(err) });
  });

  bootstrapRuntime().catch((err) => {
    logger.error("Fatal bootstrap failure", {
      error: err?.stack || err?.message || String(err),
    });

    process.exit(1);
  });
}

await startServer();

async function bootstrapRuntime() {
  try {
    await connectDB();
    await validateBootRequirements();

    await startBackgroundServices();
    appReady = true;

    logger.info("Application ready");
  } catch (err) {
    logger.error("Boot error", {
      error: err?.stack || err?.message || String(err),
    });

    throw err;
  }
}

async function startBackgroundServices() {
  try {
    await connectRedisInBackground();
  } catch (err) {
    logger.error("Redis connect (API warm path)", { error: err?.message || String(err) });
  }

  if (novaService === "api") {
    logger.warn(
      "Realtime listener skipped on API-only replica — dedicated hybrid service owns websocket subscriptions",
      { NOVA_SERVICE: novaService },
    );
  } else {
    try {
      await startRealtimeListener();
    } catch (err) {
      logger.error("Realtime listener bootstrap failed", {
        error: err?.message || String(err),
      });
    }
  }

  if (hybridStackEnabled) {
    try {
      await runDepositBackfillOnStartup();
    } catch (err) {
      logger.error("Deposit checkpoint backfill failed during API boot", {
        error: err?.message || String(err),
      });
    }

    try {
      await runHybridStartupRecovery({ blocks: 1000 });
    } catch (err) {
      logger.error("Hybrid pending-deposit recovery pass failed", {
        error: err?.message || String(err),
      });
    }
  }

  if (isHybridEarnEnabled() && hybridStackEnabled) {
    try {
      startHybridEngine();
    } catch (err) {
      logger.error("Hybrid engine supervisor failed to start", {
        error: err?.message || String(err),
      });
    }
  } else if (isHybridEarnEnabled() && novaService === "api") {
    logger.warn(
      "Hybrid engine schedules skipped on API-only replica — dedicated hybrid service owns background jobs",
      { NOVA_SERVICE: novaService },
    );
  }

  if (
    String(process.env.DISABLE_API_PIPELINE_MONITOR || "").toLowerCase() !== "true" &&
    hybridStackEnabled &&
    isHybridEarnEnabled()
  ) {
    startDepositPipelineMonitor({ role: `api-monolith#${novaService}` });
  }
}