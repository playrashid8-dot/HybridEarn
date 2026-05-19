/**
 * Dedicated WebSocket provider (ethers v6) for hybrid real-time USDT Transfer subscriptions.
 * Adds exponential backoff + heartbeat + stale-socket watchdog (complements ethers destroy/reconnect hooks).
 */

import { WebSocketProvider } from "ethers";
import depositPipelineConfig from "../../config/depositPipelineConfig.js";
import logger from "../../utils/logger.js";
import {
  getNetworkErrorHost,
  isTransientExternalNetworkError,
  logExternalNetworkFailure,
  withExternalNetworkDeadline,
} from "../../utils/safeNetwork.js";

let wsProvider = null;

const wsReadyCallbacks = [];

let reconnectBusy = false;
let wsHasEverConnected = false;
/**
 * Ignore socket churn until handshake completes — avoids spurious failover mid-handshake on some endpoints.
 */
let wsHandshakeComplete = false;
let reconnectAttempts = 0;
let heartbeatTimer = null;
let staleTimer = null;
let warmupUrlMask = "";

const WS_VERIFY_TIMEOUT_MS = Math.min(
  120_000,
  Math.max(2_000, Number(process.env.HYBRID_WS_VERIFY_TIMEOUT_MS || process.env.EXTERNAL_NETWORK_TIMEOUT_MS || 20_000)),
);

const touchHealthyCycle = () => {
  reconnectAttempts = Math.max(0, reconnectAttempts - 1);
};

export function getWsRuntimeSnapshot() {
  /** @type {Record<string, unknown>} */
  const snapshot = {
    disabled:
      String(process.env.DISABLE_WEBSOCKET || process.env.HYBRID_DISABLE_WEBSOCKET || "")
        .trim()
        .toLowerCase() === "true" ||
      String(process.env.FORCE_POLLING || process.env.HYBRID_FORCE_POLLING || "")
        .trim()
        .toLowerCase() === "true",
    handshakeComplete: wsHandshakeComplete,
    heartbeatActive: heartbeatTimer !== null,
    staleWatchActive: staleTimer !== null,
    reconnectAttempts,
    endpointTail: warmupUrlMask,
  };

  try {
    const sock = wsProvider?.websocket ?? wsProvider?._websocket;
    if (sock && typeof sock.readyState === "number") {
      snapshot.socketReadyState = sock.readyState;
    }
    if (
      wsProvider?.websocket &&
      typeof wsProvider.websocket.bufferedAmount === "number"
    ) {
      snapshot.bufferedAmount = wsProvider.websocket.bufferedAmount;
    }
  } catch {
    snapshot.socketProbe = "unavailable";
  }

  return snapshot;
}

export const whenWsProviderReady = (cb) => {
  wsReadyCallbacks.push(cb);
  /** Only emit after handshake — avoids subscribing on a half-open socket (see verifyWsConnectivityAndLog). */
  if (wsProvider && wsHandshakeComplete) {
    emitReady(cb);
  }
};

function emitReady(cb) {
  try {
    cb(wsProvider);
  } catch (err) {
    logger.error("Hybrid websocket readiness callback crashed", {
      error: err?.message || String(err),
    });
  }
}

function notifyWsCallbacksAfterHandshake(provider) {
  for (const cb of wsReadyCallbacks) {
    emitReady(cb);
  }
  attachProviderErrorChannel(provider);
}

function maskUrlTail(url) {
  const raw = String(url || "").trim();
  try {
    const u = new URL(raw);
    if (u.password) u.password = "****";
    if (u.username) u.username = "****";
    const path = `${u.pathname || "/"}`;
    return `${u.host}${path.length > 64 ? `${path.slice(0, 48)}…` : path}`;
  } catch {
    return raw.length <= 64 ? raw : `${raw.slice(0, 48)}…`;
  }
}

function clearInstrumentation() {
  if (heartbeatTimer) {
    global.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (staleTimer) {
    global.clearInterval(staleTimer);
    staleTimer = null;
  }
}

function computeBackoffDelayMs(reason) {
  const baseMs = depositPipelineConfig.wsReconnectBackoffBaseMs;
  const capMs = depositPipelineConfig.wsReconnectBackoffMaxMs;

  reconnectAttempts += 1;
  const exp = Math.min(capMs, baseMs * Math.pow(2, Math.min(reconnectAttempts - 1, 13)));
  const jitter = Math.floor(Math.random() * Math.min(800, Math.max(baseMs, 350)));
  const delay = Math.min(capMs, exp + jitter);
  logger.throttledWarn(
    "hybrid_ws_backoff",
    "Hybrid websocket backing off before reconnect",
    {
      reason,
      delayMs: delay,
      reconnectAttempts,
      endpointTail: warmupUrlMask,
    },
    Math.min(120_000, capMs + 2000),
  );
  return delay;
}

const providerHooks = new WeakSet();

function scheduleReconnectSweep(reason = "lifecycle") {
  if (reconnectBusy) {
    return;
  }
  reconnectBusy = true;
  wsHandshakeComplete = false;
  clearInstrumentation();

  const outgoing = wsProvider;

  wsProvider = null;
  safeDestroy(outgoing);

  const pause = computeBackoffDelayMs(reason);
  global.setTimeout(() => {
    reconnectBusy = false;
    try {
      const p = getWsProvider();
      void verifyWsConnectivityAndLog(p).catch((err) => {
        logger.error("Hybrid websocket verify failed after reschedule", {
          error: err?.message || String(err),
          endpointTail: warmupUrlMask,
        });
        scheduleReconnectSweep("verify_fail_chain");
      });
    } catch (err) {
      logger.error("Hybrid websocket recreation failed", {
        error: err?.message || String(err),
        endpointTail: warmupUrlMask,
      });
      scheduleReconnectSweep("recreate_throw");
    }
  }, pause);
}

function attachProviderErrorChannel(provider) {
  try {
    if (!provider || providerHooks.has(provider)) {
      return;
    }

    providerHooks.add(provider);

    if (!provider?.on || typeof provider.on !== "function") return;
    provider.on("error", (err) => {
      const transient = isTransientExternalNetworkError(err);
      logExternalNetworkFailure({
        level: transient ? "warn" : "error",
        message: transient
          ? "Hybrid websocket provider emitted transient network error — reconnect scheduled"
          : "Hybrid websocket provider emitted error event",
        error: err,
        host: warmupUrlMask,
        timeoutMs: WS_VERIFY_TIMEOUT_MS,
        retryCount: reconnectAttempts,
        purpose: "hybrid_websocket_provider_event",
        degradedNetworkMode: true,
        skippedRetryReason: "provider_event_reconnect_scheduled",
        throttleKey: `hybrid_ws_provider_${getNetworkErrorHost(err, warmupUrlMask)}`,
      });
      scheduleReconnectSweep("provider_error_emit");
    });
  } catch (err) {
    logger.warn("Unable to subscribe to hybrid websocket provider errors", {
      error: err?.message || String(err),
    });
  }
}

export function destroyHybridWsProvider() {
  clearInstrumentation();
  const prev = wsProvider;
  wsProvider = null;
  wsHandshakeComplete = false;
  reconnectBusy = false;
  safeDestroy(prev);
}

function safeDestroy(provider) {
  try {
    provider?.destroy?.();
  } catch (_) {
    /* ignore */
  }
}

function bumpHandshakeSuccess() {
  wsHandshakeComplete = true;
  const wasEstablished = wsHasEverConnected === true;
  wsHasEverConnected = true;

  logger.info(wasEstablished ? "Hybrid websocket reconnected" : "Hybrid websocket connected", {
    endpointTail: warmupUrlMask,
  });
}

/**
 * Lightweight heartbeat keeps RPC channel warm and surfaces silent half-open sockets faster.
 */
function startInstrumentation(provider) {
  clearInstrumentation();

  const interval = depositPipelineConfig.wsHeartbeatIntervalMs;
  const staleLimit = depositPipelineConfig.wsStaleMs;

  let lastHealthy = Date.now();

  heartbeatTimer = global.setInterval(async () => {
    if (!wsHandshakeComplete || !provider) return;
    try {
      await withExternalNetworkDeadline(() => provider.getBlockNumber(), {
        purpose: "hybrid_websocket_heartbeat",
        host: warmupUrlMask,
        timeoutMs: Math.min(interval * 4, interval + 7500),
      });
      touchHealthyCycle();
      lastHealthy = Date.now();
    } catch (err) {
      logExternalNetworkFailure({
        message: "Hybrid websocket heartbeat failed — reconnect scheduled",
        error: err,
        host: warmupUrlMask,
        timeoutMs: Math.min(interval * 4, interval + 7500),
        retryCount: reconnectAttempts,
        purpose: "hybrid_websocket_heartbeat",
        degradedNetworkMode: true,
        skippedRetryReason: "heartbeat_uses_reconnect_not_inline_retry",
        throttleKey: `hybrid_ws_heartbeat_${getNetworkErrorHost(err, warmupUrlMask)}`,
      });
      scheduleReconnectSweep("heartbeat_fail");
    }
  }, interval);

  staleTimer = global.setInterval(() => {
    if (!wsHandshakeComplete || !provider) return;
    if (Date.now() - lastHealthy > staleLimit + interval) {
      logger.warn("Stale hybrid websocket suspected", {
        idleMs: Date.now() - lastHealthy,
        staleLimitMs: staleLimit + interval,
        endpointTail: warmupUrlMask,
      });
      scheduleReconnectSweep("stale_socket_watchdog");
    }
  }, Math.min(15_000, Math.max(interval / 2, 5000)));

  heartbeatTimer?.unref?.();
  staleTimer?.unref?.();
}

export async function verifyWsConnectivityAndLog(provider) {
  const budget = WS_VERIFY_TIMEOUT_MS;

  wsHandshakeComplete = false;

  try {
    await withExternalNetworkDeadline(() => provider.ready, {
      purpose: "hybrid_websocket_ready",
      host: warmupUrlMask,
      timeoutMs: budget,
    });
    await withExternalNetworkDeadline(() => provider.getBlockNumber(), {
      purpose: "hybrid_websocket_get_block_number",
      host: warmupUrlMask,
      timeoutMs: budget,
    });
    wsHandshakeComplete = true;
    touchHealthyCycle();
    bumpHandshakeSuccess();

    attachSocketReconnectHandlers(provider);
    startInstrumentation(provider);
    notifyWsCallbacksAfterHandshake(provider);
    return provider;
  } catch (err) {
    wsHandshakeComplete = false;
    logExternalNetworkFailure({
      level: isTransientExternalNetworkError(err) ? "warn" : "error",
      message: "Hybrid websocket handshake failed",
      error: err,
      host: warmupUrlMask,
      timeoutMs: budget,
      retryCount: reconnectAttempts,
      purpose: "hybrid_websocket_handshake",
      degradedNetworkMode: true,
      skippedRetryReason: "caller_falls_back_or_reconnects",
    });
    throw err;
  }
}

/**
 * Subscribe to underlying socket lifecycle; ethers v6 uses `websocket` accessor.
 */
function attachSocketReconnectHandlers(provider) {
  try {
    const sock = provider?.websocket ?? provider?._websocket;
    if (!sock) {
      return;
    }

    const scheduleReconnect = (err) => {
      if (!wsHandshakeComplete) return;
      if (err) {
        logExternalNetworkFailure({
          message: "Hybrid websocket socket error — reconnect scheduled",
          error: err,
          host: warmupUrlMask,
          timeoutMs: WS_VERIFY_TIMEOUT_MS,
          retryCount: reconnectAttempts,
          purpose: "hybrid_websocket_socket_event",
          degradedNetworkMode: true,
          skippedRetryReason: "socket_event_reconnect_scheduled",
          throttleKey: `hybrid_ws_socket_${getNetworkErrorHost(err, warmupUrlMask)}`,
        });
      }
      scheduleReconnectSweep("socket_close_or_error");
    };

    if (typeof sock.once === "function") {
      sock.once("close", scheduleReconnect);
      sock.once("error", scheduleReconnect);
    } else if (typeof sock.on === "function") {
      sock.on("close", scheduleReconnect);
      sock.on("error", scheduleReconnect);
    } else {
      sock.onclose = scheduleReconnect;
      sock.onerror = scheduleReconnect;
    }
  } catch (err) {
    logger.error("Hybrid websocket socket hookups failed", {
      error: err?.message || String(err),
      endpointTail: warmupUrlMask,
    });
  }
}

export function getWsProvider() {
  const disabled =
    String(process.env.DISABLE_WEBSOCKET || process.env.HYBRID_DISABLE_WEBSOCKET || "")
      .trim()
      .toLowerCase() === "true" ||
    String(process.env.FORCE_POLLING || process.env.HYBRID_FORCE_POLLING || "")
      .trim()
      .toLowerCase() === "true";
  if (disabled) {
    throw new Error("WebSocket provider disabled by DISABLE_WEBSOCKET/FORCE_POLLING");
  }
  const urlRaw = String(
    process.env.HYBRID_BSC_WS_URL || process.env.BSC_WS_URL || ""
  ).trim();
  if (!urlRaw) {
    throw new Error(
      "HYBRID_BSC_WS_URL or BSC_WS_URL is required for WebSocket provider access"
    );
  }
  warmupUrlMask = maskUrlTail(urlRaw);
  if (!wsProvider) {
    wsHandshakeComplete = false;
    wsProvider = new WebSocketProvider(urlRaw);
    /** Handshake + instrumentation run in verifyWsConnectivityAndLog; readiness callbacks emit there only. */
  }

  return wsProvider;
}
