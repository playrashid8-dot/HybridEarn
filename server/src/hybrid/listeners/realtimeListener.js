import { id, Interface } from "ethers";
import {
  whenWsProviderReady,
  getWsProvider,
  verifyWsConnectivityAndLog,
  initializeHybridRpc,
  getProvider,
  destroyHybridWsProvider,
} from "../utils/provider.js";
import { BSC_USDT_ABI } from "../utils/constants.js";
import { CONFIRMATIONS, processDepositLog } from "../services/depositListener.js";
import {
  userMap,
  loadUsersIntoRealtimeMap,
  startUserMapPeriodicRefresh,
} from "../services/userMap.js";

import {
  describeHybridEarnDisabledReason,
  isHybridEarnEnabled,
  warnIfHybridEarnEnvInvalid,
} from "../utils/hybridEarnEnv.js";
import {
  normalizeEvmAddress,
  normalizeRecipientFromTransferTopic,
} from "../utils/normalizeWallet.js";
import depositPipelineConfig from "../../config/depositPipelineConfig.js";
import { startPollingDepositEngine } from "../services/pollingDepositEngine.js";
import logger from "../../utils/logger.js";

const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");
const transferIface = new Interface(BSC_USDT_ABI);

/** First WS instance is from initial connect; subsequent instances are reconnects. */
let wsProviderReadyCount = 0;
whenWsProviderReady(async () => {
  wsProviderReadyCount += 1;
  if (wsProviderReadyCount < 2) {
    return;
  }
  try {
    await loadUsersIntoRealtimeMap();
    realtimeHeadCache = { head: 0, atMs: 0 };
    logger.debug?.("Hybrid user map resynced post websocket churn", {});
  } catch (err) {
    logger.error("User map reload after websocket jitter failed", {
      error: err?.message || String(err),
    });
  }
});

/** Bounded RPC reuse for WS confirmation-depth checks (Transfers can arrive in bursts). */
let realtimeHeadCache = { head: 0, atMs: 0 };

async function getCachedRealtimeChainHead(provider) {
  const ttl = depositPipelineConfig.realtimeChainHeadCacheMs;
  const now = Date.now();
  if (now - realtimeHeadCache.atMs < ttl && realtimeHeadCache.head > 0) {
    return realtimeHeadCache.head;
  }
  const head = await provider.getBlockNumber();
  realtimeHeadCache = { head, atMs: now };
  return head;
}
const processedTx = new Set();
/** Suppress repeated “waiting confirmations” handling for the same tx (WS replay / head lag). */
const pendingTx = new Map();
const PENDING_TX_MAX = 5000;

let realtimeStarted = false;
let listenerHookRegistered = false;
let rpcListenerRegistered = false;
/** True when HYBRID_BSC_WS_URL (or BSC_WS_URL) was used for the realtime subscription. */
let hybridWebSocketRealtimeActive = false;

/** Per-provider guard: reconnect creates a new provider; each gets at most one Transfer listener. */
const wsProvidersWithTransferListener = new WeakSet();

/** For health / bootstrap logs (WebSocket path active). */
export const isHybridRealtimeListenerStarted = () => realtimeStarted;

/** True when realtime listener runs on WebSocket (not JSON-RPC polling subscription). */
export const isHybridWebSocketRealtimeActive = () =>
  hybridWebSocketRealtimeActive && realtimeStarted;

export const isHybridPollingRealtimeActive = () =>
  realtimeStarted && hybridWebSocketRealtimeActive === false;

/** Re-export for call sites that imported from this module. */
export { addUserToHybridDepositRealtimeMap } from "../services/userMap.js";

async function dispatchRealtimeDeposit(log, provider) {
  if (!userMap || userMap.size === 0) {
    logger.debug?.("Hybrid user map empty snapshot — reloading from Mongo aggregate", {});
    await loadUsersIntoRealtimeMap();
    if (userMap.size === 0) {
      return;
    }
  }

  if (!log?.transactionHash) {
    return;
  }

  const txHash = log.transactionHash;
  const txKey = String(txHash).trim().toLowerCase();

  const head = await getCachedRealtimeChainHead(provider);
  const bn = log.blockNumber != null ? Number(log.blockNumber) : NaN;
  /** Must run before processedTx so WS replays while unconfirmed collapse on pendingTx */
  if (Number.isFinite(bn) && bn > head - CONFIRMATIONS) {
    if (pendingTx.has(txKey)) {
      return;
    }
    pendingTx.set(txKey, true);
    if (pendingTx.size > PENDING_TX_MAX) {
      pendingTx.clear();
    }
    logger.debug?.("Realtime deposit awaiting confirmations — scheduled retry", {
      txHashPartial: `${txKey.slice(0, 12)}…`,
    });
    setTimeout(() => {
      pendingTx.delete(txKey);
      void dispatchRealtimeDeposit(log, provider).catch((err) => {
        logger.warn("Realtime confirmation retry contained local fault", {
          txHashPartial: `${txKey.slice(0, 12)}…`,
          error: err?.message || String(err),
        });
      });
    }, 12000);
    return;
  }

  pendingTx.delete(txKey);

  const expectedUsdt = normalizeEvmAddress(process.env.HYBRID_USDT_CONTRACT || "");
  if (!expectedUsdt) {
    return;
  }
  const logContract = normalizeEvmAddress(log.address || "");
  if (logContract !== expectedUsdt) {
    return;
  }

  if (processedTx.has(txKey)) {
    return;
  }
  if (processedTx.size > 10000) {
    processedTx.clear();
  }
  processedTx.add(txKey);

  const normalizedTo = normalizeRecipientFromTransferTopic(log.topics?.[2]);
  const to = normalizedTo || "";
  const hybridDepositVerbose = process.env.HYBRID_DEPOSIT_DEBUG === "1";
  const user = normalizedTo ? userMap.get(normalizedTo) : undefined;
  if (hybridDepositVerbose) {
    logger.debug?.("Realtime transfer candidate", {
      walletTail: to ? `${to.slice(-8)}` : "(unparsed)",
      matched: Boolean(user),
    });
  }
  if (!user) {
    processedTx.delete(txKey);
    if (hybridDepositVerbose) {
      logger.warn("Realtime wallet mismatch — transfer ignored for credit path", {
        txHashPartial: `${txKey.slice(0, 12)}…`,
        recipientTail: normalizedTo ? `${normalizedTo.slice(-8)}` : "(topic decode failed)",
        userMapSize: userMap.size,
      });
    }
    return;
  }

  /** Same key as chain recipient — avoids casing/trim mismatch vs parsed.args.to */
  const usersByWallet = new Map([[normalizedTo, user]]);

  let result;
  try {
    result = await processDepositLog(log, transferIface, usersByWallet, {
      skipQueue: false,
    });
  } catch (err) {
    logger.error("Realtime deposit pipeline faulted before queue handoff", {
      error: err?.message || String(err),
      txHashPartial: txKey ? `${txKey.slice(0, 12)}…` : undefined,
    });
    processedTx.delete(txKey);
    throw err;
  }

  if (result.creditFailure) {
    processedTx.delete(txKey);
    return;
  }

  /** Defer = queue/worker not ready — allow WS replay / tail rescan to retry. */
  if (
    result.holdCheckpoint &&
    result.processedDelta === 0 &&
    result.queued !== true
  ) {
    processedTx.delete(txKey);
    return;
  }

  setTimeout(() => processedTx.delete(txKey), 300000);
}

async function onTransferLog(log, provider) {
  try {
    await dispatchRealtimeDeposit(log, provider);
  } catch (err) {
    logger.error("Realtime transfer handler fault", { error: err?.message || String(err) });
    try {
      await new Promise((r) => setTimeout(r, 2000));
      await dispatchRealtimeDeposit(log, provider);
    } catch (err2) {
      logger.error("Realtime transfer handler retry still failing", {
        error: err2?.message || String(err2),
      });
    }
  }
}

async function initRealtimeSubscription() {
  const filter = {
    address: String(process.env.HYBRID_USDT_CONTRACT || "").trim(),
    topics: [TRANSFER_TOPIC],
  };

  if (!listenerHookRegistered) {
    listenerHookRegistered = true;
    whenWsProviderReady((provider) => {
      if (wsProvidersWithTransferListener.has(provider)) {
        return;
      }
      wsProvidersWithTransferListener.add(provider);
      provider.on(filter, (incomingLog) => {
        setImmediate(() =>
          void onTransferLog(incomingLog, provider).catch((err) => {
            logger.error("Realtime transfer callback escaped local guard", {
              error: err?.message || String(err),
            });
          }),
        );
      });
    });
  }

  let ws;
  try {
    ws = getWsProvider();
  } catch (err) {
    logger.error("Realtime websocket provider constructor failed", {
      error: err?.message || String(err),
    });
    destroyHybridWsProvider();
    throw err;
  }

  /** Completes websocket handshake, starts heartbeat/stale watchers, then runs whenWsProviderReady subscribers. */
  await verifyWsConnectivityAndLog(ws);

  hybridWebSocketRealtimeActive = true;
  realtimeStarted = true;
  logger.info("Realtime listener active (websocket path)", {});
}

function initRpcRealtimeSubscription() {
  const filter = {
    address: String(process.env.HYBRID_USDT_CONTRACT || "").trim(),
    topics: [TRANSFER_TOPIC],
  };

  if (rpcListenerRegistered) {
    return;
  }
  rpcListenerRegistered = true;
  hybridWebSocketRealtimeActive = false;

  const provider = getProvider();
  provider.on(filter, (incomingLog) => {
    setImmediate(() =>
      void onTransferLog(incomingLog, provider).catch((err) => {
        logger.error("Polling transfer callback escaped local guard", {
          error: err?.message || String(err),
        });
      }),
    );
  });

  realtimeStarted = true;
  logger.info("Realtime listener active (HTTP JSON-RPC subscription fallback)", {});
}

export async function startRealtimeListener() {
  logger.debug?.("startRealtimeListener invoked", {
    hybridEarnFlag: String(process.env.HYBRID_EARN_ENABLED ?? ""),
  });

  if (realtimeStarted) {
    return;
  }

  warnIfHybridEarnEnvInvalid();

  if (!isHybridEarnEnabled()) {
    logger.warn("Realtime listener offline — hybrid earn disabled", {
      reason: describeHybridEarnDisabledReason(),
    });
    return;
  }

  const contract = String(process.env.HYBRID_USDT_CONTRACT || "").trim();

  if (!contract) {
    logger.error("Realtime listener blocked — HYBRID_USDT_CONTRACT unset", {});
    return;
  }

  if (contract !== contract.toLowerCase()) {
    logger.error("Realtime listener blocked — HYBRID_USDT_CONTRACT must be lowercase", {});
    return;
  }

  await initializeHybridRpc();
  await loadUsersIntoRealtimeMap();

  if (depositPipelineConfig.websocketDisabled || depositPipelineConfig.forcePolling) {
    hybridWebSocketRealtimeActive = false;
    realtimeStarted = true;
    startPollingDepositEngine();
    startUserMapPeriodicRefresh();
    logger.info("Realtime deposit detection active (pure HTTP block polling)", {
      websocketDisabled: depositPipelineConfig.websocketDisabled,
      forcePolling: depositPipelineConfig.forcePolling,
      intervalMs: depositPipelineConfig.pollingIntervalMs,
    });
    return;
  }

  const wsUrl = String(process.env.HYBRID_BSC_WS_URL || process.env.BSC_WS_URL || "").trim();

  try {
    if (wsUrl) {
      try {
        await initRealtimeSubscription();
      } catch (wsErr) {
        logger.warn("Websocket subscription failed — falling back to HTTP block polling", {
          error: wsErr?.message || String(wsErr),
        });
        hybridWebSocketRealtimeActive = false;
        realtimeStarted = true;
        startPollingDepositEngine();
      }
    } else {
      logger.warn("No websocket URL configured — HTTP block polling mode only", {});
      hybridWebSocketRealtimeActive = false;
      realtimeStarted = true;
      startPollingDepositEngine();
    }
  } catch (err) {
    logger.error("Realtime listener bootstrap fault — tail recovery scans remain active", {
      error: err?.message || String(err),
    });
  }

  startUserMapPeriodicRefresh();
}
