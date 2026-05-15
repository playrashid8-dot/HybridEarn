import { JsonRpcProvider } from "ethers";
import {
  getRPC,
  getRpcUrls as getRpcUrlsFromConfig,
  getRPCIndex,
  setRPCIndex,
  switchRPC as rotateRPC,
} from "../../config/rpc.js";
import logger, { sanitizeForLog } from "../../utils/logger.js";

function maskRpcHost(url) {
  const raw = String(url || "").trim();
  try {
    return new URL(raw).host;
  } catch {
    return raw.length <= 48 ? raw : `${raw.slice(0, 32)}…`;
  }
}

/** WebSocket — HYBRID_BSC_WS_URL or BSC_WS_URL — see hybrid/utils/wsProvider.js */
export {
  getWsProvider,
  whenWsProviderReady,
  verifyWsConnectivityAndLog,
  destroyHybridWsProvider,
  getWsRuntimeSnapshot,
} from "./wsProvider.js";

function computeUniqueRpcUrls() {
  return getRpcUrlsFromConfig();
}

/** Financial safety favors immediate failover over sticking to a degraded RPC. */
const SWITCH_AFTER_CONSECUTIVE_FAILURES = 1;

let consecutiveRpcFailures = 0;

/** True after startup probe if a non-primary URL was selected, or after runtime switch away from index 0 */
let rpcFallbackUsedSession = false;

let cachedJsonRpcProvider = null;
let cachedJsonRpcUrl = null;

export const getRpcUrls = () => [...computeUniqueRpcUrls()];

export const getCurrentRpcUrl = () => getRPC();

export const getRpcFallbackUsed = () => rpcFallbackUsedSession;

export const getProvider = () => {
  const urls = computeUniqueRpcUrls();
  if (urls.length === 0) {
    throw new Error("HYBRID_BSC_RPC_URL or BSC_RPC_URL is required for BSC provider access");
  }
  const url = getRPC();
  if (!cachedJsonRpcProvider || cachedJsonRpcUrl !== url) {
    try {
      cachedJsonRpcProvider?.destroy?.();
    } catch (_) {
      /* ignore */
    }
    cachedJsonRpcProvider = new JsonRpcProvider(url);
    cachedJsonRpcUrl = url;
  }
  return cachedJsonRpcProvider;
};

const switchRpc = () => {
  const urls = computeUniqueRpcUrls();
  if (urls.length === 0) {
    return;
  }
  const prev = getRPCIndex();
  if (process.env.NODE_ENV !== "production") {
    logger.debug?.("Hybrid RPC failover selection rotate", {});
  }
  rotateRPC();
  const next = getRPCIndex();
  if (process.env.NODE_ENV !== "production") {
    logger.debug?.("Hybrid RPC rotated", { index: next, rpcHost: maskRpcHost(urls[next]) });
  }
  if (prev !== next && next !== 0) {
    rpcFallbackUsedSession = true;
    if (process.env.NODE_ENV !== "production") {
      logger.warn("Hybrid RPC using non-primary failover endpoint", {});
    }
  }
  cachedJsonRpcUrl = null;
  try {
    cachedJsonRpcProvider?.destroy?.();
  } catch (_) {
    /* ignore */
  }
  cachedJsonRpcProvider = null;
};

/** Enough attempts to allow multiple strikes per RPC before rotation + failover chain */
const defaultRetries = () => {
  const n = computeUniqueRpcUrls().length;
  return Math.max(24, n * SWITCH_AFTER_CONSECUTIVE_FAILURES * 3);
};

export const withProviderRetry = async (fn, retries = null) => {
  if (computeUniqueRpcUrls().length === 0) {
    throw new Error("HYBRID_BSC_RPC_URL or BSC_RPC_URL is required for BSC provider access");
  }

  const maxAttempts = retries == null ? defaultRetries() : Math.max(1, Number(retries) || 1);
  let lastError;

  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      const provider = getProvider();
      const result = await fn(provider);
      consecutiveRpcFailures = 0;
      return result;
    } catch (err) {
      lastError = err;
      const msg = String(err?.message || err || "");
      const actionable =
        /[-]?32005|limit exceeded|query returned more than|range is too large|429|rate limit|401|403|unauthorized/i.test(
          msg,
        );

      if (actionable === true || i === 0) {
        logger.throttledWarn(
          "rpc_call_retry",
          "RPC call attempt failed — auto-rotating / retrying",
          {
            attempt: i + 1,
            snippet: sanitizeForLog(msg.length > 220 ? `${msg.slice(0, 220)}…` : msg, 380),
          },
          45_000,
        );
      } else {
        logger.debug?.("RPC retry backoff", {
          attempt: i + 1,
          snippet: msg.length > 180 ? `${msg.slice(0, 180)}…` : msg,
        });
      }

      if (/[-]?32005|limit exceeded|query returned more than|range is too large/i.test(msg)) {
        logger.throttledWarn(
          "rpc_range_rejected",
          "RPC rejected heavy eth_getLogs window — shorten HYBRID scan chunk or rotate endpoint",
          {},
          120_000,
        );
      }

      consecutiveRpcFailures += 1;
      if (consecutiveRpcFailures >= SWITCH_AFTER_CONSECUTIVE_FAILURES) {
        switchRpc();
        consecutiveRpcFailures = 0;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  throw lastError;
};

/**
 * Pick first working RPC via getBlockNumber + getNetwork; updates current index for scans.
 * @returns {Promise<boolean>}
 */
export async function initializeHybridRpc() {
  const urls = computeUniqueRpcUrls();
  if (urls.length === 0) {
    logger.error("RPC bootstrap aborted — HYBRID_BSC_RPC_URL / BSC_RPC_URL missing", {});
    return false;
  }

  rpcFallbackUsedSession = false;

  for (let i = 0; i < urls.length; i += 1) {
    setRPCIndex(i);
    cachedJsonRpcUrl = null;
    try {
      cachedJsonRpcProvider?.destroy?.();
    } catch (_) {
      /* ignore */
    }
    cachedJsonRpcProvider = null;

    try {
      const p = getProvider();
      const block = await p.getBlockNumber();
      const net = await p.getNetwork();
      logger.info("RPC connected", {
        chainId: Number(net.chainId),
        safeBlock: Number(block),
        rpcHost: maskRpcHost(urls[i]),
      });
      if (i > 0) {
        rpcFallbackUsedSession = true;
        logger.warn("RPC warmup selected non-primary endpoint", {
          rpcHost: maskRpcHost(urls[i]),
        });
      }
      return true;
    } catch (err) {
      logger.warn("RPC endpoint probe rejected handshake", {
        rpcHost: maskRpcHost(urls[i]),
        error: err?.message || String(err),
      });
    }
  }

  logger.error("All RPC handshake probes failed — check HYBRID_BSC_RPC_URL pool", {});
  setRPCIndex(0);
  cachedJsonRpcUrl = null;
  try {
    cachedJsonRpcProvider?.destroy?.();
  } catch (_) {
    /* ignore */
  }
  cachedJsonRpcProvider = null;
  return false;
};

export const checkRpcHealth = async () => {
  if (computeUniqueRpcUrls().length === 0) {
    return false;
  }
  try {
    await withProviderRetry((p) => p.getBlockNumber(), Math.max(6, computeUniqueRpcUrls().length * 3));
    return true;
  } catch (err) {
    logger.error("RPC health verification failed catastrophically", {
      error: err?.message || String(err),
    });
    return false;
  }
};

export default getProvider;
