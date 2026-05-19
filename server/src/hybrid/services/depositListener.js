import { Interface, formatUnits, id } from "ethers";
import HybridSetting from "../models/HybridSetting.js";
import { creditHybridDeposit } from "./depositService.js";
import {
  enqueueDepositJob,
  toSerializableTransferLog,
} from "../../queues/depositQueue.js";
import { BSC_USDT_ABI, HYBRID_TOKEN, MIN_HYBRID_DEPOSIT } from "../utils/constants.js";
import { getProvider, getRpcUrls, withProviderRetry } from "../utils/provider.js";
import {
  markPendingDepositCredited,
  recordPendingDepositFailure,
} from "./pendingDepositService.js";
import {
  describeHybridEarnDisabledReason,
  isHybridEarnEnabled,
  warnIfHybridEarnEnvInvalid,
} from "../utils/hybridEarnEnv.js";
import { resolveRecipientsUsersByWalletMap } from "../utils/walletUserLookup.js";
import { shouldSkipDepositForDuplicateTx } from "../utils/hybridDepositTxDuplicate.js";
import depositPipelineConfig from "../../config/depositPipelineConfig.js";
import {
  normalizeEvmAddress,
  normalizeRecipientFromTransferTopic,
} from "../utils/normalizeWallet.js";
import logger, { sanitizeForLog } from "../../utils/logger.js";
import { recordUnknownDepositWallet } from "../utils/depositTelemetry.js";

/** Canonical Transfer event topic — avoids mismatched hard-coded hashes */
const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");
const transferIface = new Interface(BSC_USDT_ABI);
const MIN_DEPOSIT_AMOUNT = MIN_HYBRID_DEPOSIT;
/** Initial lookback capped to reduce pruned-RPC / oversized range failures */
const SAFE_LOOKBACK_BLOCKS = 3000;
/** BSC RPCs often reject eth_getLogs over large spans — tune via env when endpoints allow wider windows */
const getChunkSize = () => depositPipelineConfig.depositScanChunkBlocks;

const MAYBE_GC =
  typeof global.gc === "function" &&
  String(process.env.HYBRID_ENABLE_GC_HINTS || "").trim().toLowerCase() === "true";
/** Deduplicate scan-path enqueue across chunks / retries (in-memory only) */
const seenTx = new Set();
/** Reorg / fake-log safety: always ≥ 2 (see business rules) */
export const CONFIRMATIONS = depositPipelineConfig.depositConfirmations;

const devLog = (...args) => {
  if (process.env.NODE_ENV === "development") {
    logger.debug(depositDevLogLine(args));
  }
};

const maybeSampleLog = (...args) => {
  if (process.env.NODE_ENV !== "production") {
    logger.debug(depositDevLogLine(args));
  }
};

function depositDevLogLine(args) {
  try {
    return args.map((a) => sanitizeForLog(a)).join(" ");
  } catch {
    return String(args?.[0] ?? "");
  }
}

/** Canonical BSC mainnet USDT — mismatch suggests misconfigured HYBRID_USDT_CONTRACT */
const BSC_MAINNET_USDT = "0x55d398326f99059ff775485246999027b3197955";

let isScanning = false;

const decodeTopicAddress = (topic) => normalizeRecipientFromTransferTopic(topic) || "";

const shortAddr = (addr) => {
  const s = String(addr || "");
  if (s.length < 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
};

const shortTx = (hash) => {
  const s = String(hash || "");
  if (s.length < 14) return s;
  return `${s.slice(0, 10)}…`;
};

function decodeTransferAmountFromData(data) {
  const raw = String(data || "").trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(raw)) {
    return NaN;
  }
  try {
    return Number(formatUnits(BigInt(raw), HYBRID_TOKEN.decimals));
  } catch (_) {
    return NaN;
  }
}

export function selectDepositCandidateLogs(
  logs,
  { skipSeenTx = false, dedupeTx = false } = {},
) {
  const expectedContract = normalizeEvmAddress(process.env.HYBRID_USDT_CONTRACT || "");
  if (!expectedContract) {
    return [];
  }

  const inBatchTx = new Set();
  const candidates = [];

  for (const log of logs || []) {
    const txHash = String(log?.transactionHash || "").trim().toLowerCase();
    if (!txHash) {
      continue;
    }
    if (skipSeenTx && seenTx.has(txHash)) {
      continue;
    }
    if (dedupeTx && inBatchTx.has(txHash)) {
      continue;
    }

    if (normalizeEvmAddress(log?.address) !== expectedContract) {
      continue;
    }
    if (normalizeEvmAddress(log?.topics?.[0]) !== TRANSFER_TOPIC) {
      continue;
    }

    const toAddress = decodeTopicAddress(log?.topics?.[2]);
    if (!toAddress) {
      continue;
    }

    const amount = decodeTransferAmountFromData(log?.data);
    if (!Number.isFinite(amount) || amount <= 0 || amount < MIN_DEPOSIT_AMOUNT) {
      continue;
    }

    inBatchTx.add(txHash);
    candidates.push({ log, txHash, toAddress, amount });
  }

  return candidates;
}

export async function getLastProcessedBlock() {
  const setting = await HybridSetting.findOne({ key: "hybridLastProcessedBlock" });

  if (setting?.value !== undefined && setting?.value !== null && setting?.value !== "") {
    const storedBlock = Number(setting.value);

    if (Number.isFinite(storedBlock)) {
      return storedBlock;
    }
  }

  const currentBlock = await withProviderRetry((provider) => provider.getBlockNumber());
  const SAFE_START_BLOCK = Math.max(0, currentBlock - SAFE_LOOKBACK_BLOCKS);
  /** Last persisted block — one below first block we will scan */
  const startBlock = Math.max(SAFE_START_BLOCK - 1, 0);

  await HybridSetting.findOneAndUpdate(
    { key: "hybridLastProcessedBlock" },
    { $set: { value: startBlock } },
    { upsert: true, new: true }
  );

  return startBlock;
}

export async function saveLastProcessedBlock(blockNumber) {
  await HybridSetting.findOneAndUpdate(
    { key: "hybridLastProcessedBlock" },
    { $set: { value: Number(blockNumber) } },
    { upsert: true, new: true }
  );
}

/**
 * Single-log processing (sequential await per log — no in-memory batch accumulation).
 * Queue-first: only credits in-process when skipQueue or enqueue returns kind "direct".
 * @returns {{ creditFailure: boolean, processedDelta: number, holdCheckpoint?: boolean, queued?: boolean }}
 * @param {{ skipQueue?: boolean, fullRecovery?: boolean }} [options] — fullRecovery: enqueue without worker heartbeat gate (checkpoint scan only).
 */
export async function processDepositLog(log, iface, usersByWallet, options = {}) {
  const verboseTransferDecode =
    options.suppressDetectionLog !== true &&
    options.fullRecovery !== true &&
    process.env.HYBRID_DEPOSIT_DEBUG === "1";

  if (verboseTransferDecode) {
    logger.debug?.("Deposit listener verbose decode enabled", {
      txHashPreview: log?.transactionHash
        ? `${String(log.transactionHash).slice(0, 12)}…`
        : undefined,
      blockNumber: log?.blockNumber,
    });
  }

  const txHash = String(log.transactionHash || "").trim().toLowerCase();

  if (!txHash) {
    devLog("Deposit skipped: missing tx hash", { blockNumber: log.blockNumber });
    return { creditFailure: false, processedDelta: 0 };
  }

  const traceId =
    typeof options.traceId === "string" && options.traceId.length > 0
      ? options.traceId
      : `${txHash}_${Date.now()}`;

  const USDT_CONTRACT = String(process.env.HYBRID_USDT_CONTRACT || "").trim();
  if (!USDT_CONTRACT) {
    return { creditFailure: false, processedDelta: 0, traceId };
  }
  if (normalizeEvmAddress(log.address) !== normalizeEvmAddress(USDT_CONTRACT)) {
    logger.debug?.("Ignored Transfer for non-configured token contract", {
      traceId,
      observed: log.address,
    });
    return { creditFailure: false, processedDelta: 0, traceId };
  }

  let parsed;
  try {
    parsed = iface.parseLog(log);
  } catch (parseErr) {
    logger.error("deposit listener rejected malformed event log", {
      traceId,
      txHashPartial: `${txHash.slice(0, 12)}…`,
      error: parseErr?.message || String(parseErr),
    });
    return { creditFailure: false, processedDelta: 0, traceId };
  }

  if (parsed.name !== "Transfer") {
    return { creditFailure: false, processedDelta: 0, traceId };
  }

  const toAddr = String(parsed.args.to).toLowerCase().trim();
  const fromAddr = String(parsed.args.from).toLowerCase().trim();

  if (!toAddr || !fromAddr) {
    devLog("Deposit skipped: invalid transfer addresses", { blockNumber: log.blockNumber });
    return { creditFailure: false, processedDelta: 0, traceId };
  }

  const amount = Number(formatUnits(parsed.args.value, HYBRID_TOKEN.decimals));

  if (verboseTransferDecode) {
    logger.debug?.("Decoded Transfer meta", {
      traceId,
      to: toAddr,
      from: fromAddr,
      amount,
      txHash,
    });
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    devLog("Deposit skipped: invalid amount", { wallet: shortAddr(toAddr) });
    return { creditFailure: false, processedDelta: 0, traceId };
  }

  if (amount < MIN_DEPOSIT_AMOUNT) {
    devLog("Deposit skipped: below minimum", {
      wallet: shortAddr(toAddr),
      minimum: MIN_DEPOSIT_AMOUNT,
    });
    return { creditFailure: false, processedDelta: 0, traceId };
  }

  const matchedUser = usersByWallet.get(toAddr);

  if (!matchedUser) {
    recordUnknownDepositWallet({
      source: options.fullRecovery === true ? "deposit_recovery" : "deposit_scan",
      address: toAddr,
      txHash,
      blockNumber: log.blockNumber,
    });
    return { creditFailure: false, processedDelta: 0, traceId };
  }

  const userWalletLower = normalizeEvmAddress(matchedUser.walletAddress);
  logger.debug?.("DEPOSIT_WALLET_MATCHED", {
    traceId,
    walletTail: `${toAddr.slice(-8)}`,
    userTail: `${String(matchedUser._id).slice(-8)}`,
    walletVersion: matchedUser.walletVersion ?? null,
    normalizedLookupUsed: true,
  });
  if (toAddr === userWalletLower) {
    devLog("🎯 Target wallet matched");
  }

  const dup = await shouldSkipDepositForDuplicateTx(txHash);
  if (dup.skip) {
    logger.debug?.("Duplicate deposit short-circuit — prior ledger state", {
      traceId,
      txHashPartial: `${txHash.slice(0, 12)}…`,
      reason: dup.reason,
      status: dup.status ?? null,
    });
    return { creditFailure: false, processedDelta: 0, traceId };
  }

  const emitDepositDetectedTelemetry =
    options.suppressDetectionLog !== true && options.fullRecovery !== true;

  if (emitDepositDetectedTelemetry) {
    try {
      await HybridSetting.findOneAndUpdate(
        { key: "hybridLastDetectedTxAt" },
        { $set: { value: Date.now() } },
        { upsert: true, new: true }
      );
    } catch (_) {
      /* non-fatal */
    }

    logger.info("DEPOSIT_DETECTED", {
      traceId,
      txHashPartial: `${txHash.slice(0, 12)}…`,
      blockNumber: log.blockNumber,
      amount,
    });
  }
  devLog("📥 Checking deposits for:", userWalletLower);
  devLog("📥 Deposit detail:", {
    txHash: shortTx(txHash),
    amount,
    to: shortAddr(toAddr),
    block: log.blockNumber,
  });

  const serializedLog = toSerializableTransferLog(log);
  const creditDirectly = async () => {
    if (!options.suppressProcessingLog) {
      logger.debug?.("Processing deposit credit pathway", {
        traceId,
        txHashPartial: `${txHash.slice(0, 12)}…`,
      });
    }
    try {
      await creditHybridDeposit({
        userId: matchedUser._id,
        walletAddress: toAddr,
        txHash,
        amount,
        blockNumber: log.blockNumber,
        fromAddress: fromAddr,
        tokenAddress: String(process.env.HYBRID_USDT_CONTRACT || "").trim(),
        traceId,
      });
      await markPendingDepositCredited(txHash);
    } catch (err) {
      logger.error("deposit creditDirectly failed fatally — pending retry hook will capture", {
        traceId,
        txHashPartial: `${txHash.slice(0, 12)}…`,
        error: err?.message || String(err),
      });
      throw err;
    }
  };

  const pendingFailurePayload = {
    txHash,
    userId: matchedUser._id,
    walletAddress: toAddr,
    amount,
    blockNumber: log.blockNumber,
    fromAddress: fromAddr,
    tokenAddress: String(process.env.HYBRID_USDT_CONTRACT || "").trim(),
    serializedLog,
  };

  if (options?.skipQueue !== true) {
    /** @type {{ kind: string; job?: unknown } | null} */
    let enqueueOutcome = null;
    try {
      enqueueOutcome = serializedLog
        ? await enqueueDepositJob({
            log: serializedLog,
            blockNumber: serializedLog.blockNumber,
            skipWorkerHeartbeatCheck: options.fullRecovery === true,
            traceId,
          })
        : null;
    } catch (err) {
      logger.error("enqueueDepositJob transactional failure captured", {
        traceId,
        txHashPartial: `${txHash.slice(0, 12)}…`,
        error: err?.message || String(err),
        phase: "enqueue",
      });
      await recordPendingDepositFailure({
        ...pendingFailurePayload,
        error: err,
      });
      return { creditFailure: true, holdCheckpoint: true, processedDelta: 0, traceId };
    }

    if (!serializedLog || !enqueueOutcome) {
      logger.error("enqueueDepositJob returned empty payload unexpectedly", {
        traceId,
        txHashPartial: `${txHash.slice(0, 12)}…`,
        phase: "enqueue",
      });
      await recordPendingDepositFailure({
        ...pendingFailurePayload,
        error: new Error("enqueueDepositJob: missing serialized transfer log"),
      });
      return { creditFailure: true, holdCheckpoint: true, processedDelta: 0, traceId };
    }

    if (enqueueOutcome.kind === "queued") {
      return {
        creditFailure: false,
        holdCheckpoint: true,
        processedDelta: 0,
        queued: true,
        traceId,
      };
    }

    if (enqueueOutcome.kind === "defer") {
      logger.warn("deposit pipeline deferred heartbeat warm-up — realtime tail will retry safely", {
        traceId,
        txHashPartial: `${txHash.slice(0, 12)}…`,
        userTail: `${String(matchedUser._id).slice(-6)}`,
      });
      return { creditFailure: false, holdCheckpoint: true, processedDelta: 0, traceId };
    }

    if (enqueueOutcome.kind === "direct") {
      logger.warn(
        "HYBRID deposit forced direct credit pathway — queues offline; confirm Redis worker topology",
        {
          traceId,
          txHashPartial: `${txHash.slice(0, 12)}…`,
          amount,
          blockNumber: log.blockNumber,
          userTail: `${String(matchedUser._id).slice(-8)}`,
        },
      );
      try {
        await creditDirectly();
        logger.debug?.("Direct credit finalized without queues", {
          traceId,
          txHashPartial: `${txHash.slice(0, 12)}…`,
        });
        return { creditFailure: false, holdCheckpoint: true, processedDelta: 1, traceId };
      } catch (err) {
        await recordPendingDepositFailure({
          ...pendingFailurePayload,
          error: err,
        });
        return { creditFailure: true, processedDelta: 0, traceId };
      }
    }

    logger.error("Unknown enqueueDepositJob outcome emitted — reconcile pipeline wiring", {
      traceId,
      txHashPartial: `${txHash.slice(0, 12)}…`,
      outcomePreview: enqueueOutcome?.kind ?? "unset",
      phase: "enqueue",
    });
    await recordPendingDepositFailure({
      ...pendingFailurePayload,
      error: new Error("Unknown enqueue outcome"),
    });
    return { creditFailure: true, holdCheckpoint: true, processedDelta: 0, traceId };
  }

  try {
    await creditDirectly();
    logger.debug?.("deposit skipQueue finalized credit safely", {
      traceId,
      txHashPartial: `${txHash.slice(0, 12)}…`,
      userTail: `${String(matchedUser._id).slice(-8)}`,
    });
  } catch (err) {
    await recordPendingDepositFailure({
      txHash,
      userId: matchedUser._id,
      walletAddress: toAddr,
      amount,
      blockNumber: log.blockNumber,
      fromAddress: fromAddr,
      tokenAddress: String(process.env.HYBRID_USDT_CONTRACT || "").trim(),
      serializedLog,
      error: err,
    });
    return { creditFailure: true, processedDelta: 0, traceId };
  }

  return { creditFailure: false, processedDelta: 1, traceId };
}

async function executeDepositScan(
  fromBlockOverride,
  toBlockOverride,
  scanOptions = {}
) {
  const quiet = scanOptions.quiet === true;
  const skipProbe = scanOptions.skipProbe === true;
  const isManualRescan = scanOptions.isManualRescan === true;
  const logEmptyOnZero = scanOptions.logEmptyOnZero === true;
  if (scanOptions.backupScanTriggered === true) {
    devLog("🛟 Backup scan running...");
  }
  getProvider();
  const usdtContractNorm = String(process.env.HYBRID_USDT_CONTRACT || "")
    .trim()
    .toLowerCase();
  if (!usdtContractNorm || usdtContractNorm !== BSC_MAINNET_USDT) {
    logger.throttledWarn(
      "hybrid_usdt_contract_noncanonical",
      "HYBRID_USDT_CONTRACT deviates from canonical BSC mainnet USDT — verify configuration",
      {
        canonicalTail: `${BSC_MAINNET_USDT.slice(0, 10)}…`,
        observedTail: `${(usdtContractNorm || "").slice(0, 12)}`,
      },
    );
  }
  let chainTip;
  let latestBlock;
  if (toBlockOverride !== null) {
    chainTip = Number(toBlockOverride);
    latestBlock = chainTip;
  } else {
    chainTip = await withProviderRetry((p) => p.getBlockNumber());
    latestBlock = Math.max(0, chainTip - CONFIRMATIONS);
  }

  if (!skipProbe && !quiet) {
    try {
      const USDT_CONTRACT = String(process.env.HYBRID_USDT_CONTRACT || "").trim();
      if (USDT_CONTRACT) {
        const diagFrom = Math.max(0, chainTip - 30);
        const probeLogs = await withProviderRetry((provider) =>
          provider.getLogs({
            address: USDT_CONTRACT,
            fromBlock: diagFrom,
            toBlock: chainTip,
            topics: [TRANSFER_TOPIC],
          })
        );
        devLog("scan probe transfers", probeLogs.length);
      }
    } catch (probeErr) {
      logger.throttledWarn(
        "deposit_scan_probe",
        "Deposit scan probe suppressed — continuing chunked fetch",
        { error: probeErr?.message || String(probeErr) },
      );
    }
  }

  const SAFE_START_BLOCK = Math.max(0, chainTip - SAFE_LOOKBACK_BLOCKS);
  const storedBlock =
    fromBlockOverride !== null ? Number(fromBlockOverride) - 1 : await getLastProcessedBlock();

  if (!Number.isFinite(latestBlock) || !Number.isFinite(storedBlock)) {
    throw new Error("Invalid block range for deposit scan");
  }

  /** Admin/manual rescans must honor explicit [from,to]; SAFE_START clamp would skip older blocks inside range */
  const manualExplicitRange =
    isManualRescan &&
    fromBlockOverride !== null &&
    toBlockOverride !== null &&
    Number.isFinite(Number(fromBlockOverride)) &&
    Number.isFinite(Number(toBlockOverride));

  let fromBlock = manualExplicitRange
    ? Math.max(Number(fromBlockOverride), 0)
    : Math.max(storedBlock + 1, SAFE_START_BLOCK);

  const REORG_BUFFER = 5;
  if (fromBlock !== null) {
    fromBlock = Math.max(0, fromBlock - REORG_BUFFER);
  }

  if (fromBlock > latestBlock) {
    if (!quiet) {
      devLog("Deposit listener up to date");
    }
    return { skipped: false, processed: 0 };
  }

  if (!quiet && latestBlock - fromBlock > 5000) {
    maybeSampleLog("⚠️ Large block range, splitting...");
  }

  let processed = 0;

  for (; fromBlock <= latestBlock; ) {
    const toBlock = Math.min(latestBlock, fromBlock + getChunkSize() - 1);
    let chunkHadCreditFailure = false;

    if (!quiet) {
      devLog("Hybrid deposit scan");
    }

    let logs = [];

    const fetchChunkLogs = () =>
      withProviderRetry((provider) =>
        provider.getLogs({
          address: String(process.env.HYBRID_USDT_CONTRACT || "").trim(),
          fromBlock,
          toBlock,
          topics: [TRANSFER_TOPIC],
        })
      );

    const processedBeforeChunk = processed;

    try {
      logs = await fetchChunkLogs();
    } catch (err) {
      maybeSampleLog("❌ RPC failed — retrying...");
      await new Promise((r) => setTimeout(r, 2000));
      try {
        logs = await fetchChunkLogs();
      } catch (err2) {
        logger.error("Chunked deposit scan RPC degraded — waiting before continuing", {
          error: err2?.message || String(err2),
        });
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
    }

    if (logs.length === 0 && !quiet) {
      maybeSampleLog("empty scan chunk — single refetch before advancing");
      try {
        await new Promise((r) => setTimeout(r, 900));
        logs = await fetchChunkLogs();
      } catch (retryErr) {
        logger.throttledWarn(
          "deposit_scan_refetch_empty",
          "deposit scan refetch empty — backoff before checkpoint advance",
          { error: retryErr?.message || String(retryErr) },
        );
      }
    }

    if (!quiet) {
      devLog("📊 Logs count:", logs.length);
    }
    if (!quiet && logs.length === 0) {
      devLog(
        "Deposit listener: no Transfer logs in this chunk (may still advance checkpoint)"
      );
    }

    const candidateLogs = selectDepositCandidateLogs(logs, {
      skipSeenTx: true,
      dedupeTx: false,
    });
    const toAddresses = [
      ...new Set(candidateLogs.map((candidate) => candidate.toAddress)),
    ];

    let usersByWallet = new Map();
    if (toAddresses.length > 0) {
      usersByWallet = await resolveRecipientsUsersByWalletMap(toAddresses);

      if (!quiet) {
        devLog("wallet resolution", {
          recipients: toAddresses.length,
          hits: usersByWallet.size,
        });
      }
    } else if (logs.length > 0 && !quiet) {
      devLog("Deposit listener found no recipient addresses");
    }

    for (const candidate of candidateLogs) {
      const { log, txHash } = candidate;
      if (seenTx.has(txHash)) {
        continue;
      }
      seenTx.add(txHash);
      if (seenTx.size > 20000) {
        seenTx.clear();
      }

      const result = await processDepositLog(log, transferIface, usersByWallet);
      processed += Number(result.processedDelta) || 0;
      const deferOrFail =
        result.creditFailure ||
        (result.holdCheckpoint &&
          result.processedDelta === 0 &&
          result.queued !== true);
      if (deferOrFail) {
        seenTx.delete(txHash);
        chunkHadCreditFailure = true;
        break;
      }
    }

    if (logs.length > 0 && processed === processedBeforeChunk) {
      maybeSampleLog("🚨 Logs found but no deposits processed");
    }

    logs = null;
    if (MAYBE_GC) {
      global.gc();
    }
    if (!quiet) {
      devLog("🧠 Memory:", process.memoryUsage().heapUsed / 1024 / 1024, "MB");
    }
    await new Promise((r) =>
      setTimeout(r, quiet ? Math.min(800, Number(process.env.HYBRID_QUIET_CHUNK_DELAY_MS || 380) || 380) : 150),
    );

    if (chunkHadCreditFailure) {
      logger.warn("deposit listener checkpoint withheld — transactional credit stalled mid-chunk", {
        fromBlock,
        toBlock,
      });
      break;
    }

    if (!isManualRescan) {
      const checkpointHasConfirmationDepth = chainTip >= toBlock + CONFIRMATIONS;
      if (toBlock > latestBlock || !checkpointHasConfirmationDepth) {
        if (!quiet) {
          devLog("Skipping invalid block range (checkpoint)");
        }
        break;
      }
      try {
        await saveLastProcessedBlock(toBlock);
        if (!quiet) {
          devLog("Checkpoint saved:", toBlock);
        }
      } catch (err) {
        logger.warn("deposit listener checkpoint persistence failed transiently — will retry sweep", {
          error: err?.message || String(err),
        });
      }
    }

    fromBlock = toBlock + 1;
  }

  if (processed === 0 && (!quiet || logEmptyOnZero)) {
    maybeSampleLog("🚨 No deposits found — possible miss or already processed");
  }

  return { skipped: false, processed };
}

export const scanHybridDeposits = async (
  fromBlockOverride = null,
  toBlockOverride = null,
  options = null
) => {
  let from = fromBlockOverride;
  let to = toBlockOverride;
  let optIn = options;
  /** Reject accidental scanHybridDeposits({ blocks: N }) — normalize to (null, null, opts). */
  if (
    from != null &&
    typeof from === "object" &&
    !Array.isArray(from) &&
    toBlockOverride == null &&
    (options === null || options === undefined)
  ) {
    optIn = /** @type {Record<string, unknown>} */ (from);
    from = null;
    to = null;
  }

  warnIfHybridEarnEnvInvalid();

  if (!isHybridEarnEnabled()) {
    logger.warn("deposit listener halted — HYBRID_EARN flagged off", {
      reason: describeHybridEarnDisabledReason(),
    });
    return { skipped: true };
  }

  const rpcUrls = getRpcUrls();
  if (rpcUrls.length === 0) {
    logger.error("deposit scan aborted — HYBRID_BSC_RPC_URL family missing entirely", {});
    return { skipped: true };
  }

  const contractTrimmed = String(process.env.HYBRID_USDT_CONTRACT ?? "").trim();
  if (!contractTrimmed) {
    logger.error("deposit scan halted — HYBRID_USDT_CONTRACT unset", {});
    return { skipped: true };
  }

  const opts = optIn && typeof optIn === "object" ? optIn : {};
  const backupSpanRaw = opts.backupBlocks ?? opts.blocks;
  let resolvedFrom = from;
  let resolvedTo = to;
  const { backupBlocks: _bb, blocks: _b, ...restScanOpts } = opts;
  let scanOpts = { ...restScanOpts };

  if (
    resolvedFrom == null &&
    resolvedTo == null &&
    backupSpanRaw != null &&
    Number.isFinite(Number(backupSpanRaw))
  ) {
    const chainTip = await withProviderRetry((p) => p.getBlockNumber());
    const latestBlock = Math.max(0, chainTip - CONFIRMATIONS);
    const span = Math.max(1, Number(backupSpanRaw) || 50);
    resolvedFrom = Math.max(0, latestBlock - (span - 1));
    resolvedTo = latestBlock;
    scanOpts = {
      ...scanOpts,
      quiet: true,
      skipProbe: true,
      backupScanTriggered: true,
    };
  }

  if (isScanning) {
    devLog("⏳ Skipping — scan already running");
    return { skipped: true };
  }

  isScanning = true;

  try {
    return await executeDepositScan(resolvedFrom, resolvedTo, scanOpts);
  } catch (err) {
    logger.error("deposit scan executor threw unexpectedly", {
      error: err?.message || String(err),
    });
    await new Promise((r) => setTimeout(r, 3000));
    throw err;
  } finally {
    isScanning = false;
  }
};

export const rescanDeposits = async (fromBlock, toBlock) => {
  logger.debug?.("manual admin rescan dispatched", {});
  return await scanHybridDeposits(fromBlock, toBlock, { isManualRescan: true });
};
