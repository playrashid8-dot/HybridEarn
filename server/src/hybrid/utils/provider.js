import { JsonRpcProvider } from "ethers";
import {
  getRPC,
  getRpcUrls as getRpcUrlsFromConfig,
  getRPCIndex,
  setRPCIndex,
  switchRPC as rotateRPC,
} from "../../config/rpc.js";
import logger from "../../utils/logger.js";
import {
  getNetworkErrorHost,
  isTransientExternalNetworkError,
  logExternalNetworkFailure,
  withExternalNetworkDeadline,
} from "../../utils/safeNetwork.js";

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
const providerErrorHooks = new WeakSet();
const rpcHealth = new Map();
const RPC_CALL_TIMEOUT_MS = Math.min(
  120_000,
  Math.max(2_000, Number(process.env.HYBRID_RPC_CALL_TIMEOUT_MS || process.env.EXTERNAL_NETWORK_TIMEOUT_MS || 30_000)),
);

export const getRpcUrls = () => [...computeUniqueRpcUrls()];

export const getCurrentRpcUrl = () => getRPC();

export const getRpcFallbackUsed = () => rpcFallbackUsedSession;

export function destroyHybridRpcProvider() {
  try {
    cachedJsonRpcProvider?.destroy?.();
  } catch (_) {
    /* ignore */
  }
  cachedJsonRpcProvider = null;
  cachedJsonRpcUrl = null;
}

export const getRpcHealthSnapshot = () =>
  getRpcUrls().map((url, index) => {
    const state = rpcHealth.get(url) || {};
    return {
      index,
      active: index === getRPCIndex(),
      ok: state.ok === true,
      failures: Number(state.failures || 0),
      lastOkAt: state.lastOkAt || null,
      lastErrorAt: state.lastErrorAt || null,
      host: maskRpcHost(url),
    };
  });

function markRpcOk(url) {
  const prev = rpcHealth.get(url) || {};
  rpcHealth.set(url, {
    ...prev,
    ok: true,
    failures: 0,
    lastOkAt: Date.now(),
  });
}

function markRpcFailure(url) {
  const prev = rpcHealth.get(url) || {};
  rpcHealth.set(url, {
    ...prev,
    ok: false,
    failures: Number(prev.failures || 0) + 1,
    lastErrorAt: Date.now(),
  });
}

export const getProvider = () => {
  const urls = computeUniqueRpcUrls();
  if (urls.length === 0) {
    throw new Error("HYBRID_BSC_RPC_URL or BSC_RPC_URL is required for BSC provider access");
  }
  const url = getRPC();
  if (!cachedJsonRpcProvider || cachedJsonRpcUrl !== url) {
    destroyHybridRpcProvider();
    cachedJsonRpcProvider = new JsonRpcProvider(url);
    cachedJsonRpcUrl = url;
    attachJsonRpcProviderErrorChannel(cachedJsonRpcProvider, url);
  }
  return cachedJsonRpcProvider;
};

function attachJsonRpcProviderErrorChannel(provider, url) {
  try {
    if (!provider || providerErrorHooks.has(provider) || typeof provider.on !== "function") {
      return;
    }
    providerErrorHooks.add(provider);
    provider.on("error", (err) => {
      const transient = isTransientExternalNetworkError(err);
      logExternalNetworkFailure({
        level: transient ? "warn" : "error",
        message: transient
          ? "RPC provider emitted transient network error — runtime stays alive"
          : "RPC provider emitted non-transient error",
        error: err,
        host: url,
        timeoutMs: RPC_CALL_TIMEOUT_MS,
        retryCount: 0,
        purpose: "bsc_rpc_provider_event",
        degradedNetworkMode: transient,
        skippedRetryReason: "provider_event",
        throttleKey: `rpc_provider_event_${getNetworkErrorHost(err, url)}`,
      });
    });
  } catch (err) {
    logger.warn("Unable to subscribe to RPC provider error channel", {
      error: err?.message || String(err),
    });
  }
}

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
  destroyHybridRpcProvider();
};

/** Enough attempts to allow multiple strikes per RPC before rotation + failover chain */
const defaultRetries = () => {
  const n = computeUniqueRpcUrls().length;
  return Math.max(24, n * SWITCH_AFTER_CONSECUTIVE_FAILURES * 3);
};

export const withProviderRetry = async (fn, retries = null, options = {}) => {
  if (computeUniqueRpcUrls().length === 0) {
    throw new Error("HYBRID_BSC_RPC_URL or BSC_RPC_URL is required for BSC provider access");
  }

  const maxAttempts = retries == null ? defaultRetries() : Math.max(1, Number(retries) || 1);
  const purpose = String(options?.purpose || "bsc_rpc_call");
  const timeoutMs = Math.min(
    120_000,
    Math.max(2_000, Number(options?.timeoutMs || RPC_CALL_TIMEOUT_MS)),
  );
  let lastError;

  for (let i = 0; i < maxAttempts; i += 1) {
    const rpcUrl = getRPC();
    try {
      const provider = getProvider();
      const result = await withExternalNetworkDeadline(() => fn(provider), {
        purpose,
        host: rpcUrl,
        timeoutMs,
      });
      consecutiveRpcFailures = 0;
      markRpcOk(rpcUrl);
      return result;
    } catch (err) {
      lastError = err;
      markRpcFailure(rpcUrl);
      const msg = String(err?.message || err || "");
      const actionable =
        /[-]?32005|limit exceeded|query returned more than|range is too large|429|rate limit|401|403|unauthorized/i.test(
          msg,
        );

      const transientNetwork = isTransientExternalNetworkError(err);
      if (transientNetwork === true || actionable === true || i === 0) {
        logExternalNetworkFailure({
          message: "RPC call attempt failed — auto-rotating / retrying",
          error: err,
          host: rpcUrl,
          timeoutMs,
          retryCount: i,
          purpose,
          degradedNetworkMode: true,
          skippedRetryReason: i + 1 < maxAttempts ? "" : "retry_budget_exhausted",
          throttleKey: "rpc_call_retry",
        });
      } else {
        logger.debug?.("RPC retry backoff", {
          attempt: i + 1,
          snippet: msg.length > 180 ? `${msg.slice(0, 180)}…` : msg,
          externalHost: getNetworkErrorHost(err, rpcUrl),
          timeoutMs,
          retryCount: i,
          requestPurpose: purpose,
          degradedNetworkMode: true,
          skippedRetryReason: "",
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
      const backoffMs = Math.min(10_000, 500 * Math.pow(2, Math.min(i, 5)));
      const jitterMs = Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, backoffMs + jitterMs));
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
    destroyHybridRpcProvider();

    try {
      const p = getProvider();
      const block = await withExternalNetworkDeadline(() => p.getBlockNumber(), {
        purpose: "bsc_rpc_boot_get_block_number",
        host: urls[i],
        timeoutMs: RPC_CALL_TIMEOUT_MS,
      });
      const net = await withExternalNetworkDeadline(() => p.getNetwork(), {
        purpose: "bsc_rpc_boot_get_network",
        host: urls[i],
        timeoutMs: RPC_CALL_TIMEOUT_MS,
      });
      logger.info("RPC connected", {
        chainId: Number(net.chainId),
        safeBlock: Number(block),
        rpcHost: maskRpcHost(urls[i]),
      });
      markRpcOk(urls[i]);
      if (i > 0) {
        rpcFallbackUsedSession = true;
        logger.warn("RPC warmup selected non-primary endpoint", {
          rpcHost: maskRpcHost(urls[i]),
        });
      }
      return true;
    } catch (err) {
      markRpcFailure(urls[i]);
      logExternalNetworkFailure({
        message: "RPC endpoint probe rejected handshake",
        error: err,
        host: urls[i],
        timeoutMs: RPC_CALL_TIMEOUT_MS,
        retryCount: i,
        purpose: "bsc_rpc_bootstrap_probe",
        degradedNetworkMode: true,
        skippedRetryReason: i + 1 < urls.length ? "" : "all_rpc_bootstrap_candidates_failed",
      });
    }
  }

  logger.error("All RPC handshake probes failed — check HYBRID_BSC_RPC_URL pool", {});
  setRPCIndex(0);
  destroyHybridRpcProvider();
  return false;
};

export const checkRpcHealth = async () => {
  if (computeUniqueRpcUrls().length === 0) {
    return false;
  }
  try {
    await withProviderRetry(
      (p) => p.getBlockNumber(),
      Math.max(6, computeUniqueRpcUrls().length * 3),
      { purpose: "bsc_rpc_health_check", timeoutMs: RPC_CALL_TIMEOUT_MS },
    );
    return true;
  } catch (err) {
    logger.error("RPC health verification failed catastrophically", {
      error: err?.message || String(err),
    });
    return false;
  }
};

export default getProvider;
