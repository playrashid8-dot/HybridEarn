import { Interface, formatUnits } from "ethers";

import User from "../../models/User.js";
import { processDepositLog } from "./depositListener.js";
import { shouldSkipDepositForDuplicateTx } from "../utils/hybridDepositTxDuplicate.js";
import { BSC_USDT_ABI, HYBRID_TOKEN } from "../utils/constants.js";
import { findUserByWalletLowercase } from "../utils/walletUserLookup.js";
import { userMap } from "./userMap.js";
import {
  normalizeEvmAddress,
  normalizeRecipientFromTransferTopic,
} from "../utils/normalizeWallet.js";
import logger from "../../utils/logger.js";
import {
  releaseHybridDepositTxLock,
  tryAcquireHybridDepositTxLock,
} from "./depositTxLock.js";

const iface = new Interface(BSC_USDT_ABI);

async function processSerializedDepositLog(serializedLog) {
  const normalized = String(serializedLog?.transactionHash || "").trim().toLowerCase();

  if (!normalized) {
    logger.error("deposit worker aborted — serialized log missing tx hash", {
      phase: "enqueue_guard",
      tracePlaceholder: `missing_${Date.now()}`,
    });

    return {
      outcome: "skip",
      reason: "missing_tx",
      processedDelta: 0,
      traceId: `missing_${Date.now()}`,
      txHash: "",
    };
  }

  const traceId = `${normalized}_${Date.now()}`;

  let lockHeldForTx = false;

  try {
    const dup = await shouldSkipDepositForDuplicateTx(normalized);
    if (dup.skip) {
      logger.debug?.("deposit job dedupe short-circuit", {
        traceId,
        txHashPartial: `${normalized.slice(0, 14)}…`,
        reason: dup.reason,
      });
      return {
        outcome: "duplicate",
        txHash: normalized,
        processedDelta: 0,
        traceId,
      };
    }

    const log = {
      transactionHash: serializedLog.transactionHash,
      address:
        serializedLog.address != null ? String(serializedLog.address).trim() : undefined,
      blockNumber:
        serializedLog.blockNumber != null && Number.isFinite(Number(serializedLog.blockNumber))
          ? Number(serializedLog.blockNumber)
          : undefined,
      topics: [...(serializedLog.topics || [])],
      data: serializedLog.data,
    };

    const expectedContract = normalizeEvmAddress(process.env.HYBRID_USDT_CONTRACT || "");
    const logAddr = normalizeEvmAddress(log.address || "");

    if (expectedContract && logAddr && logAddr !== expectedContract) {
      logger.warn("deposit worker ignored non-USDT Transfer log slice", {
        traceId,
        txHashPartial: `${normalized.slice(0, 12)}…`,
        expectedTail: `${expectedContract.slice(0, 8)}`,
        observedTail: `${logAddr.slice(0, 8)}`,
      });
      return {
        outcome: "skip",
        reason: "contract",
        txHash: normalized,
        processedDelta: 0,
        traceId,
      };
    }

    const toAddrRaw = normalizeRecipientFromTransferTopic(log.topics?.[2]);
    const toAddr = normalizeEvmAddress(toAddrRaw);

    if (!toAddr || toAddr === "0x") {
      logger.error("deposit worker cannot decode Transfer recipient topics", {
        traceId,
        txHashPartial: `${normalized.slice(0, 12)}…`,
        phase: "topic_decode",
      });
      return {
        outcome: "skip",
        reason: "wallet",
        txHash: normalized,
        processedDelta: 0,
        traceId,
      };
    }

    let parsedAmount;
    try {
      const parsed = iface.parseLog({
        address: logAddr || expectedContract,
        topics: log.topics,
        data: log.data,
      });
      parsedAmount = Number(formatUnits(parsed.args.value, HYBRID_TOKEN.decimals));
    } catch (err) {
      logger.error("deposit worker rejected malformed Transfer log blob", {
        traceId,
        txHashPartial: `${normalized.slice(0, 12)}…`,
        error: err?.message || String(err),
        phase: "parse",
      });
      throw err;
    }

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      logger.error("deposit worker detected non-positive payout amount — abort credit", {
        traceId,
        txHashPartial: `${normalized.slice(0, 12)}…`,
        parsedAmountPreview: `${parsedAmount}`,
        phase: "amount_guard",
      });
      return {
        outcome: "skip",
        reason: "amount",
        txHash: normalized,
        processedDelta: 0,
        traceId,
      };
    }

    logger.debug?.("deposit worker parsed payload", {
      traceId,
      amountPreview: `${parsedAmount}`,
      walletTail: `${toAddr.slice(-6)}`,
    });

    /** Prefer hot in-memory wallet registry (hydrated by hybrid listener); fall back for races / misses. */
    let user = userMap.get(toAddr);
    if (!user || !user._id) {
      user = await findUserByWalletLowercase(toAddr);
    }

    if (!user) {
      logger.warn("deposit realtime job wallet mismatch vs User collection snapshot", {
        traceId,
        walletTail: `${toAddr.slice(-8)}`,
        guidance: process.env.NODE_ENV !== "production" ? "inspect HYBRID_WALLET_MISMATCH tooling" : undefined,
      });
      if (process.env.HYBRID_DEPOSIT_DEBUG === "1") {
        const sampleLimitRaw = Number(process.env.HYBRID_WALLET_MISMATCH_LOG_MAX || 40);
        const cap = Number.isFinite(sampleLimitRaw)
          ? Math.min(240, Math.max(8, sampleLimitRaw))
          : 40;
        const sampleDocs = await User.find({
          walletAddress: { $exists: true, $nin: ["", null] },
        })
          .select("walletAddress")
          .limit(cap)
          .lean();
        logger.debug?.(
          `wallet mismatch sample (${sampleDocs.length} rows) suppressed in production dashboards`,
          {
            previews: sampleDocs
              .map((doc) => normalizeEvmAddress(doc.walletAddress))
              .filter(Boolean),
          },
        );
      }
      return {
        outcome: "skip",
        reason: "no_user",
        txHash: normalized,
        processedDelta: 0,
        traceId,
      };
    }

    const lockAcquisition = await tryAcquireHybridDepositTxLock(normalized);
    if (!lockAcquisition.acquired) {
      logger.warn("deposit mongo lease busy — benign race when parallel replicas boot", {
        traceId,
        txHashPartial: `${normalized.slice(0, 12)}…`,
        reason: lockAcquisition.reason ?? "busy",
      });
      return {
        outcome: "skip",
        reason: "mongo_lock_busy",
        txHash: normalized,
        processedDelta: 0,
        traceId,
      };
    }

    lockHeldForTx = true;

    const usersByWallet = new Map([[normalizeEvmAddress(user.walletAddress), user]]);

    const depositProcessing = await processDepositLog(log, iface, usersByWallet, {
      skipQueue: true,
      traceId,
      suppressProcessingLog: true,
      suppressDetectionLog: true,
    });

    if (depositProcessing.creditFailure) {
      logger.error("Hybrid deposit transactional credit failed despite queue lease", {
        traceId,
        txHashPartial: `${normalized.slice(0, 12)}…`,
        phase: "mongo_transaction",
      });
      throw new Error("Hybrid deposit credit failed");
    }

    const processedDelta = Number(depositProcessing.processedDelta) || 0;
    if (processedDelta > 0) {
      return {
        outcome: "credited",
        txHash: normalized,
        processedDelta,
        userId: String(user._id),
        amount: parsedAmount,
        traceId,
      };
    }

    return {
      outcome: "skip",
      reason: "no_credit",
      txHash: normalized,
      processedDelta: 0,
      traceId,
    };
  } finally {
    if (lockHeldForTx === true && normalized.length > 0) {
      await releaseHybridDepositTxLock(normalized);
    }
  }
}

/**
 * BullMQ job handler: `job.data` is `{ log, blockNumber? }` from enqueueDepositJob.
 */
export async function processDepositJob(jobData) {
  const serializedLog = jobData?.log != null ? jobData.log : jobData;
  return processSerializedDepositLog(serializedLog);
}
