import logger from "../../utils/logger.js";
import { normalizeEvmAddress } from "./normalizeWallet.js";

/** HybridSetting keys written when a hybrid deposit credit commits successfully */
export const HYBRID_SETTING_LAST_PROCESSED_DEPOSIT_AT = "hybridLastProcessedDepositAt";
export const HYBRID_SETTING_LAST_PROCESSED_DEPOSIT_TX = "hybridLastProcessedDepositTxHash";

const UNKNOWN_WALLET_AGGREGATE_MS = Math.min(
  300_000,
  Math.max(30_000, Number(process.env.HYBRID_UNKNOWN_WALLET_LOG_WINDOW_MS || 180_000)),
);
const UNKNOWN_WALLET_SAMPLE_EVERY = Math.min(
  10_000,
  Math.max(10, Number(process.env.HYBRID_UNKNOWN_WALLET_SAMPLE_EVERY || 250)),
);

const unknownWalletStats = {
  startedAt: Date.now(),
  total: 0,
  bySource: new Map(),
  samples: [],
};

let unknownWalletFlushTimer = null;

function startUnknownWalletFlushTimer() {
  if (unknownWalletFlushTimer != null) {
    return;
  }

  unknownWalletFlushTimer = setInterval(() => {
    flushUnknownDepositWalletTelemetry();
  }, UNKNOWN_WALLET_AGGREGATE_MS);
  unknownWalletFlushTimer?.unref?.();
}

function resetUnknownWalletStats(now = Date.now()) {
  unknownWalletStats.startedAt = now;
  unknownWalletStats.total = 0;
  unknownWalletStats.bySource.clear();
  unknownWalletStats.samples = [];
}

export function flushUnknownDepositWalletTelemetry() {
  if (unknownWalletStats.total <= 0) {
    resetUnknownWalletStats();
    return;
  }

  const now = Date.now();
  const windowMs = Math.max(1, now - unknownWalletStats.startedAt);
  logger.throttledInfo(
    "unknown_deposit_wallets_skipped",
    "Deposit scanner skipped unmatched recipient wallets",
    {
      count: unknownWalletStats.total,
      windowSeconds: Math.round(windowMs / 1000),
      bySource: Object.fromEntries(unknownWalletStats.bySource),
      samples: unknownWalletStats.samples,
    },
    UNKNOWN_WALLET_AGGREGATE_MS,
  );
  resetUnknownWalletStats(now);
}

export function recordUnknownDepositWallet({
  source = "deposit_scan",
  address,
  txHash,
  blockNumber,
  reason = "wallet_not_found",
} = {}) {
  startUnknownWalletFlushTimer();

  const normalized = normalizeEvmAddress(address);
  const sourceKey = String(source || "deposit_scan");
  unknownWalletStats.total += 1;
  unknownWalletStats.bySource.set(
    sourceKey,
    (unknownWalletStats.bySource.get(sourceKey) || 0) + 1,
  );

  if (
    unknownWalletStats.samples.length < 8 &&
    (unknownWalletStats.total === 1 ||
      unknownWalletStats.total % UNKNOWN_WALLET_SAMPLE_EVERY === 0)
  ) {
    unknownWalletStats.samples.push({
      source: sourceKey,
      reason,
      walletTail: normalized ? `${normalized.slice(-8)}` : undefined,
      txHashPartial: txHash ? `${String(txHash).slice(0, 12)}...` : undefined,
      blockNumber: blockNumber ?? undefined,
    });
  }

  logger.debug?.("DEPOSIT_WALLET_NOT_FOUND suppressed", {
    source: sourceKey,
    reason,
    walletTail: normalized ? `${normalized.slice(-8)}` : undefined,
  });
}
