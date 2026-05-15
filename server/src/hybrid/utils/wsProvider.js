/**
 * Dedicated WebSocket provider (ethers v6) for hybrid real-time USDT Transfer subscriptions.
 * Adds exponential backoff + heartbeat + stale-socket watchdog (complements ethers destroy/reconnect hooks).
 */

import { WebSocketProvider } from "ethers";
import depositPipelineConfig from "../../config/depositPipelineConfig.js";
import logger from "../../utils/logger.js";

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

const touchHealthyCycle = () => {
  reconnectAttempts = Math.max(0, reconnectAttempts - 1);
};

export function getWsRuntimeSnapshot() {
  /** @type {Record<string, unknown>} */
  const snapshot = {
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
      logger.error("Hybrid websocket provider emitted error event", {
        error: err?.message || String(err),
        endpointTail: warmupUrlMask,
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
      await Promise.race([
        provider.getBlockNumber(),
        new Promise((_, rej) =>
          setTimeout(
            () => rej(new Error("websocket heartbeat exceeded budget")),
            Math.min(interval * 4, interval + 7500),
          ),
        ),
      ]);
      touchHealthyCycle();
      lastHealthy = Date.now();
    } catch (err) {
      logger.warn("Hybrid websocket heartbeat failed", {
        error: err?.message || String(err),
        endpointTail: warmupUrlMask,
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
  const budget = Number(process.env.HYBRID_WS_VERIFY_TIMEOUT_MS || 20000);

  wsHandshakeComplete = false;

  try {
    await Promise.race([
      provider.ready,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("websocket ready timeout")), budget),
      ),
    ]);
    await provider.getBlockNumber();
    wsHandshakeComplete = true;
    touchHealthyCycle();
    bumpHandshakeSuccess();

    attachSocketReconnectHandlers(provider);
    startInstrumentation(provider);
    notifyWsCallbacksAfterHandshake(provider);
    return provider;
  } catch (err) {
    wsHandshakeComplete = false;
    logger.error("Hybrid websocket handshake failed", {
      error: err?.message || String(err),
      endpointTail: warmupUrlMask,
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

    const scheduleReconnect = () => {
      if (!wsHandshakeComplete) return;
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
