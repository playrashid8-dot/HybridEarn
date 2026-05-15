import mongoose from "mongoose";
import { Contract, Interface, isAddress, getAddress, parseEther, parseUnits, Wallet } from "ethers";
import User from "../../models/User.js";
import HybridLedger from "../models/HybridLedger.js";
import HybridWithdrawal from "../models/HybridWithdrawal.js";
import {
  BSC_USDT_ABI,
  HYBRID_TOKEN,
  WITHDRAW_FEE_RATE,
  WITHDRAW_MIN_AMOUNT,
  WITHDRAW_MONTHLY_LIMITS,
} from "../utils/constants.js";
import hybridConfig from "../../config/hybridConfig.js";
import { getProvider, withProviderRetry } from "../utils/provider.js";
import logger from "../../utils/logger.js";
import { getReadyRedis } from "../../config/redis.js";
import payoutPipelineConfig from "../../config/payoutPipelineConfig.js";
import { withPayoutWalletExclusive } from "./payoutWalletMutex.js";
import {
  advanceNonceMirrorAfterBroadcast,
  reconcileNonceMirrorAfterFailure,
  reservePayoutNonce,
  syncNonceMirrorFromChain,
} from "./payoutNonceManager.js";
import { getCachedFeeData, getCachedBlockNumber } from "../utils/rpcFeeCache.js";
import { getReceiptDeduped } from "../utils/receiptThrottle.js";
import {
  bumpPayout,
  recordGasDiagnostics,
  recordNonceDiagnostics,
  payoutObservabilitySnapshot,
  withPayoutRpcTimeout,
} from "../utils/payoutObservability.js";
import { ensureMonthWindow, WITHDRAW_DELAY_MS } from "../utils/time.js";
import { addHybridLedgerEntries } from "./ledgerService.js";
import { getSpendableHybridBalance, splitHybridBalance } from "./balanceService.js";
import {
  completeIdempotency,
  failIdempotency,
  getCompletedIdempotency,
  getIdempotencyRecord,
  markIdempotencyProcessing,
  releaseIdempotentAction,
} from "./idempotencyService.js";

/** Min delay after `lastWithdrawRequest` before another Hybrid withdraw request (payout completion refreshes this). */
const WITHDRAW_REQUEST_COOLDOWN_MS = 60 * 1000;

const getMonthlyLimit = (level) => WITHDRAW_MONTHLY_LIMITS[Math.min(Number(level || 0), 3)] || 0;

export const allowedWithdrawTransitions = {
  pending: ["approved", "rejected"],
  review: ["approved", "rejected"],
  claimable: ["approved", "rejected"],
  approved: ["paid", "rejected"],
  rejected: [],
  paid: [],
  claimed: [],
};

const assertWithdrawTransition = (currentStatus, nextStatus) => {
  const current = String(currentStatus || "");
  const allowed = allowedWithdrawTransitions[current] || [];

  if (!allowed.includes(nextStatus)) {
    throw adminClientError(`Invalid withdrawal transition: ${current || "unknown"} → ${nextStatus}`);
  }
};

/** Queued pre-payout statuses (must match `/admin/withdrawals/pending` filter). */
const ADMIN_QUEUE_WITHDRAW_STATUSES = ["pending", "review", "claimable"];

const assertAdminQueuedHybridWithdrawal = (withdrawal) => {
  const st = String(withdrawal?.status || "");
  if (!ADMIN_QUEUE_WITHDRAW_STATUSES.includes(st) || withdrawal?.paidAt != null) {
    throw adminClientError("Invalid state transition");
  }
};

/** Reject refunds pending gross; unpaid `approved` is allowed unless a payout broadcast is active. */
const assertAdminRejectableHybridWithdrawal = (withdrawal) => {
  if (!withdrawal) {
    throw adminClientError("Withdrawal not found", 404);
  }
  const st = String(withdrawal.status || "");
  if (withdrawal.paidAt != null || st === "paid") {
    throw adminClientError("Cannot reject a paid withdrawal", 400);
  }
  if (st === "rejected") {
    throw adminClientError("Withdrawal already rejected", 400);
  }
  if (ADMIN_QUEUE_WITHDRAW_STATUSES.includes(st)) {
    return;
  }
  if (st === "approved") {
    const ps = String(withdrawal.payoutStatus || "idle");
    if (ps === "sending" || ps === "verifying") {
      throw adminClientError("Payout in progress; cannot reject", 409);
    }
    return;
  }
  throw adminClientError("Invalid state transition");
};

/**
 * Ledger-backed fallback when HybridWithdrawal has no stored source split (legacy rows).
 */
const resolveRejectSourceSplit = async (withdrawal, session) => {
  let rewardBack = Number(withdrawal.sourceRewardAmount || 0);
  let depositBack = Number(withdrawal.sourceDepositAmount || 0);

  if (rewardBack + depositBack > 1e-9) {
    return { rewardBack, depositBack };
  }

  const entries = await HybridLedger.find({
    referenceId: withdrawal._id,
    source: "withdraw_request",
    entryType: "debit",
    balanceType: { $in: ["rewardBalance", "depositBalance"] },
  })
    .session(session)
    .select("balanceType amount")
    .lean();

  rewardBack = 0;
  depositBack = 0;
  for (const e of entries) {
    if (e.balanceType === "rewardBalance") rewardBack += Number(e.amount || 0);
    if (e.balanceType === "depositBalance") depositBack += Number(e.amount || 0);
  }

  return {
    rewardBack: Number(rewardBack.toFixed(8)),
    depositBack: Number(depositBack.toFixed(8)),
  };
};

const getMonthKey = (value) => {
  const date = new Date(value);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};

const MS_HOUR = 60 * 60 * 1000;
/** Auto payout batch may send this many ms before full lock (availableAt). */
const AUTO_PAYOUT_BEFORE_MS = 10 * 60 * 60 * 1000;

export const requestHybridWithdrawal = async (
  userId,
  amount,
  walletAddress,
  idempotencyKey = null
) => {
  const numericAmount = Number(amount || 0);
  const normalizedWallet = walletAddress?.trim();

  if (!Number.isFinite(numericAmount) || numericAmount < WITHDRAW_MIN_AMOUNT) {
    throw new Error(`Minimum withdrawal is ${WITHDRAW_MIN_AMOUNT} USDT`);
  }

  if (!normalizedWallet) {
    throw new Error("Valid wallet address required");
  }

  let checksummed;
  try {
    checksummed = getAddress(normalizedWallet);
  } catch {
    throw new Error("Invalid EVM wallet address");
  }

  if (!isAddress(checksummed)) {
    throw new Error("Invalid EVM wallet address");
  }

  const walletLower = checksummed.toLowerCase();
  const withdrawIdempotencyKey = idempotencyKey
    ? `${String(userId)}:${String(idempotencyKey).trim().toLowerCase()}`
    : null;

  if (withdrawIdempotencyKey) {
    const storedResponse = await getCompletedIdempotency("withdraw", withdrawIdempotencyKey);
    if (storedResponse?.withdrawalId) {
      const withdrawal = await HybridWithdrawal.findById(storedResponse.withdrawalId);
      if (withdrawal) {
        return { withdrawal };
      }
    }

    const previous = await HybridWithdrawal.findOne({ userId, idempotencyKey });

    if (previous?.idempotencyResponse) {
      return previous.idempotencyResponse.data;
    }
  }

  const session = await mongoose.startSession();

  try {
    let result = null;

    session.startTransaction();

      if (withdrawIdempotencyKey) {
        await markIdempotencyProcessing("withdraw", withdrawIdempotencyKey, session);
      }

      const user = await User.findById(userId)
        .select(
          "depositBalance rewardBalance pendingWithdraw level monthlyWithdrawn monthStart lastWithdrawRequest adminFraudFlag createdAt totalInvested"
        )
        .session(session);

      if (!user) {
        throw new Error("User not found");
      }

      const monthlyLimit = getMonthlyLimit(user.level);

      if (monthlyLimit <= 0) {
        throw new Error("Upgrade to level 1 to withdraw");
      }

      if (Number(user.pendingWithdraw || 0) > 0) {
        throw new Error("Pending withdrawal must be completed first");
      }

      if (user.lastWithdrawRequest) {
        const lastReq = new Date(user.lastWithdrawRequest).getTime();
        if (Number.isFinite(lastReq) && Date.now() - lastReq < WITHDRAW_REQUEST_COOLDOWN_MS) {
          throw new Error("Please wait 1 minute before next withdrawal");
        }
      }

      if (getSpendableHybridBalance(user) < numericAmount) {
        throw new Error("Insufficient Hybrid balance");
      }

      const monthWindow = ensureMonthWindow(user);
      const nextMonthlyWithdrawn = monthWindow.monthlyWithdrawn + numericAmount;

      if (nextMonthlyWithdrawn > monthlyLimit) {
        throw new Error("Monthly withdrawal limit reached");
      }

      const sourceBreakdown = splitHybridBalance(user, numericAmount);
      const feeAmount = Number((numericAmount * WITHDRAW_FEE_RATE).toFixed(8));
      const netAmount = Number((numericAmount - feeAmount).toFixed(8));
      const now = new Date();
      const availableAt = new Date(now.getTime() + WITHDRAW_DELAY_MS);
      const autoEligibleAt = new Date(availableAt.getTime() - AUTO_PAYOUT_BEFORE_MS);

      const hourAgo = new Date(Date.now() - MS_HOUR);
      const priorHourCount = await HybridWithdrawal.countDocuments({
        userId,
        createdAt: { $gte: hourAgo },
        status: { $nin: ["rejected"] },
      }).session(session);
      const rapidPattern = priorHourCount >= 3;
      const isSuspicious = Boolean(user.adminFraudFlag) || rapidPattern;
      const initialStatus = "pending";

      let riskScore = 0;
      if (priorHourCount > 3) riskScore += 2;
      const depositsBaseline = Math.max(
        Number(user.totalInvested || 0),
        Number(user.depositBalance || 0)
      );
      if (depositsBaseline > 0 && numericAmount > depositsBaseline * 2) {
        riskScore += 2;
      } else if (depositsBaseline <= 0 && numericAmount > 0) {
        riskScore += 2;
      }
      const createdAtUser = user.createdAt ? new Date(user.createdAt).getTime() : 0;
      const newUser =
        Number.isFinite(createdAtUser) && createdAtUser > 0
          ? Date.now() - createdAtUser < 7 * 24 * 60 * 60 * 1000
          : false;
      if (newUser) riskScore += 1;

      const priority = isSuspicious ? "high" : "normal";

      if (riskScore >= 4) {
        logger.warn("HIGH RISK hybrid withdrawal request flagged", {
          userId: String(userId),
          amount: numericAmount,
          riskScore,
        });
      }

      const [withdrawal] = await HybridWithdrawal.create(
        [
          {
            userId,
            grossAmount: numericAmount,
            feeAmount,
            netAmount,
            walletAddress: walletLower,
            sourceRewardAmount: Number(sourceBreakdown.rewardBalance || 0),
            sourceDepositAmount: Number(sourceBreakdown.depositBalance || 0),
            availableAt,
            autoEligibleAt,
            requestedAt: now,
            monthKey: getMonthKey(now),
            idempotencyKey,
            isSuspicious,
            status: initialStatus,
            priority,
            riskScore,
          },
        ],
        { session }
      );

      if (riskScore >= 4) {
        await User.updateOne(
          {
            _id: userId,
            adminFraudFlag: { $ne: true },
          },
          {
            $set: {
              adminFraudFlag: true,
              adminFraudReason: "Auto high-risk withdraw",
            },
          },
          { session }
        );
      }

      const updatedUser = await User.findOneAndUpdate(
        {
          _id: userId,
          pendingWithdraw: { $lte: 0 },
          rewardBalance: { $gte: sourceBreakdown.rewardBalance },
          depositBalance: { $gte: sourceBreakdown.depositBalance },
        },
        {
          $inc: {
            rewardBalance: -sourceBreakdown.rewardBalance,
            depositBalance: -sourceBreakdown.depositBalance,
            pendingWithdraw: numericAmount,
          },
          $set: {
            monthStart: monthWindow.monthStart,
            monthlyWithdrawn: nextMonthlyWithdrawn,
            lastWithdrawRequest: now,
          },
        },
        {
          new: true,
          session,
        }
      );

      if (!updatedUser) {
        throw new Error("Insufficient Hybrid balance or pending withdrawal exists");
      }

      const ledgerEntries = [
        {
          userId,
          entryType: "credit",
          balanceType: "pendingWithdraw",
          amount: numericAmount,
          source: "withdraw_request",
          referenceId: withdrawal._id,
          meta: {
            walletAddress: walletLower,
            netAmount,
            feeAmount,
          },
        },
      ];

      if (sourceBreakdown.rewardBalance > 0) {
        ledgerEntries.push({
          userId,
          entryType: "debit",
          balanceType: "rewardBalance",
          amount: sourceBreakdown.rewardBalance,
          source: "withdraw_request",
          referenceId: withdrawal._id,
          meta: {
            walletAddress: walletLower,
          },
        });
      }

      if (sourceBreakdown.depositBalance > 0) {
        ledgerEntries.push({
          userId,
          entryType: "debit",
          balanceType: "depositBalance",
          amount: sourceBreakdown.depositBalance,
          source: "withdraw_request",
          referenceId: withdrawal._id,
          meta: {
            walletAddress: walletLower,
          },
        });
      }

      await addHybridLedgerEntries(ledgerEntries, session);

      result = {
        withdrawal,
      };

      if (idempotencyKey) {
        await HybridWithdrawal.findByIdAndUpdate(
          withdrawal._id,
          {
            $set: {
              idempotencyResponse: {
                data: result,
              },
            },
          },
          {
            session,
          }
        );

        await completeIdempotency(
          "withdraw",
          withdrawIdempotencyKey,
          {
            withdrawalId: String(withdrawal._id),
            status: withdrawal.status,
            grossAmount: numericAmount,
          },
          session
        );
      }

    await session.commitTransaction();

    return result;
  } catch (error) {
    await session.abortTransaction();
    if (withdrawIdempotencyKey) {
      await failIdempotency("withdraw", withdrawIdempotencyKey, error);
    }
    throw new Error(error.message || "Failed to request withdrawal");
  } finally {
    session.endSession();
  }
};

/**
 * User "claim" is now a lock-window readiness check only.
 * Strict financial states stay pending → approved → paid or pending → rejected.
 */
export const claimHybridWithdrawal = async (userId, withdrawalId) => {
  const session = await mongoose.startSession();

  try {
    let result = null;

    session.startTransaction();

    const withdrawal = await HybridWithdrawal.findOne({
      _id: withdrawalId,
      userId,
    }).session(session);

    if (!withdrawal) {
      throw new Error("Withdrawal not found");
    }

    if (withdrawal.status === "approved" || withdrawal.status === "paid") {
      result = {
        withdrawalId: withdrawal._id,
        status: withdrawal.status,
        netAmount: Number(withdrawal.netAmount || 0),
        feeAmount: Number(withdrawal.feeAmount || 0),
      };
      await session.commitTransaction();
      return result;
    }

    if (withdrawal.status !== "pending") {
      throw new Error("Withdrawal cannot be claimed in its current state");
    }

    if (new Date(withdrawal.availableAt).getTime() > Date.now()) {
      throw new Error("Withdrawal is still locked for 96 hours");
    }

    result = {
      withdrawalId: withdrawal._id,
      status: withdrawal.status,
      netAmount: Number(withdrawal.netAmount || 0),
      feeAmount: Number(withdrawal.feeAmount || 0),
    };

    await session.commitTransaction();

    return result;
  } catch (error) {
    await session.abortTransaction();
    throw new Error(error.message || "Failed to claim withdrawal");
  } finally {
    session.endSession();
  }
};

export const getHybridWithdrawals = async (userId) =>
  HybridWithdrawal.find({ userId }).sort({ createdAt: -1 });

const normalizeTxHash = (txHash) => {
  const raw = String(txHash || "").trim().toLowerCase();
  if (!raw.startsWith("0x") || raw.length < 10) {
    return null;
  }
  return raw;
};

const adminClientError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const wrapAdminClientError = (error, fallback) => {
  const wrapped = new Error(error?.message || fallback);
  wrapped.statusCode = error?.statusCode;
  if (!wrapped.statusCode) {
    wrapped.statusCode = 500;
  }
  return wrapped;
};

const transferEventIface = new Interface(BSC_USDT_ABI);
const PAYOUT_LOCK_MS = Number(process.env.HYBRID_WITHDRAW_PAYOUT_LOCK_MS || 5 * 60 * 1000);
const STALE_PAYOUT_SENDING_MS = Number(
  process.env.HYBRID_STALE_PAYOUT_SENDING_MS ?? 5 * 60 * 1000,
);
const HYBRID_PAYOUT_RPC_TIMEOUT_MS = Number(process.env.HYBRID_PAYOUT_RPC_TIMEOUT_MS || 28000);
const HYBRID_PAYOUT_TX_WAIT_MS = Number(process.env.HYBRID_PAYOUT_TX_WAIT_MS || 360000);
const HYBRID_PAYOUT_MAX_ATTEMPTS = Math.max(1, Number(process.env.HYBRID_PAYOUT_MAX_ATTEMPTS || 24));
const TREASURY_SNAPSHOT_TTL_MS = Math.min(
  60_000,
  Math.max(0, Number(process.env.HYBRID_PAYOUT_BALANCE_SNAP_MS ?? 2800)),
);
const GAS_ESTIMATE_SNAPSHOT_TTL_MS = Math.min(
  60_000,
  Math.max(0, Number(process.env.HYBRID_PAYOUT_GAS_EST_CACHE_MS ?? 4500)),
);

/** In-process balance snapshot for payout wallet (short TTL, cleared on payout errors). */
let treasurySnapshotCache = {
  addr: "",
  atMs: 0,
  /** @type {bigint | null} */
  nativeWei: null,
  /** @type {bigint | null} */
  tokenWei: null,
};
/** Gas estimate TTL cache key: `"to"|amountWei` */
const gasEstimateCache = new Map();

function invalidateTreasuryBalanceSnapshot() {
  treasurySnapshotCache = {
    addr: "",
    atMs: 0,
    nativeWei: null,
    tokenWei: null,
  };
}

/** @returns {bigint} */
async function rpcMinGasLimitForTransfer(token, fromSigner, toAddress, amountWei) {
  const key = `${String(toAddress || "").toLowerCase()}:${amountWei?.toString?.() ?? String(amountWei)}`;
  const now = Date.now();
  const hit = gasEstimateCache.get(key);
  if (
    hit &&
    Number.isFinite(hit.atMs) &&
    now - hit.atMs < GAS_ESTIMATE_SNAPSHOT_TTL_MS &&
    hit.gasLimit
  ) {
    recordGasDiagnostics({
      cached: true,
      ttlMs: GAS_ESTIMATE_SNAPSHOT_TTL_MS,
      gasLimitSuggested: hit.gasLimit?.toString?.() ?? String(hit.gasLimit),
    });
    return BigInt(hit.gasLimit.toString?.() ?? hit.gasLimit);
  }

  const rawEst = await withProviderRetry(() =>
    withPayoutRpcTimeout(
      async () => token.transfer.estimateGas(toAddress, amountWei, { from: fromSigner.address }),
      HYBRID_PAYOUT_RPC_TIMEOUT_MS,
      "estimateGas(transfer)",
    ),
  );
  const est = BigInt(String(rawEst));

  const bufferedRaw = (est * 130n) / 100n + 25_000n;
  const cap = BigInt(Math.min(Number.MAX_SAFE_INTEGER, Number(process.env.HYBRID_PAYOUT_GAS_CAP || 680_000)));

  gasEstimateCache.set(key, {
    atMs: now,
    gasLimit: bufferedRaw > cap ? cap : bufferedRaw,
  });

  recordGasDiagnostics({
    cached: false,
    ttlMs: GAS_ESTIMATE_SNAPSHOT_TTL_MS,
    gasLimitSuggested: (bufferedRaw > cap ? cap : bufferedRaw).toString(),
  });

  return bufferedRaw > cap ? cap : bufferedRaw;
}

async function rpcReadTreasuryBalances(tokenContract, signerAddress) {
  const addr = String(signerAddress || "").trim().toLowerCase();
  const nowMs = Date.now();
  const fresh =
    !!addr &&
    treasurySnapshotCache.addr === addr &&
    treasurySnapshotCache.nativeWei != null &&
    treasurySnapshotCache.tokenWei != null &&
    nowMs - treasurySnapshotCache.atMs <= TREASURY_SNAPSHOT_TTL_MS;

  if (fresh) {
    return {
      nativeWei: /** @type {bigint} */ (treasurySnapshotCache.nativeWei),
      tokenWei: /** @type {bigint} */ (treasurySnapshotCache.tokenWei),
    };
  }

  const [nativeWei, tokenWei] = await Promise.all([
    withProviderRetry((p) =>
      withPayoutRpcTimeout(() => p.getBalance(signerAddress), HYBRID_PAYOUT_RPC_TIMEOUT_MS, "treasury_native"),
    ),
    withProviderRetry((p) =>
      withPayoutRpcTimeout(async () => {
        const erc =
          typeof tokenContract.connect === "function" ? tokenContract.connect(p) : tokenContract;
        return BigInt((await erc.balanceOf(signerAddress)).toString());
      }, HYBRID_PAYOUT_RPC_TIMEOUT_MS, "treasury_usdt"),
    ),
  ]);

  treasurySnapshotCache = {
    addr,
    atMs: nowMs,
    nativeWei,
    tokenWei,
  };

  return { nativeWei, tokenWei };
}

/**
 * Reads next nonce indexes for diagnostics + mempool-aware payout safety gates.
 */
async function readNonceSnapshot(addrChecksum, payoutNonceLocked) {
  const addr = String(addrChecksum || "");
  let pendingNext = NaN;
  let latestConfirmed = NaN;

  try {
    pendingNext = Number(
      await withProviderRetry((p) =>
        withPayoutRpcTimeout(
          () => p.getTransactionCount(addr, "pending"),
          HYBRID_PAYOUT_RPC_TIMEOUT_MS,
          "nonce_pending",
        ),
      ),
    );
  } catch {
    pendingNext = NaN;
  }

  try {
    latestConfirmed = Number(
      await withProviderRetry((p) =>
        withPayoutRpcTimeout(
          () => p.getTransactionCount(addr, "latest"),
          HYBRID_PAYOUT_RPC_TIMEOUT_MS,
          "nonce_latest",
        ),
      ),
    );
  } catch {
    latestConfirmed = NaN;
  }

  const locked = Number(payoutNonceLocked);
  recordNonceDiagnostics({
    locked,
    pendingNext: Number.isFinite(pendingNext) ? pendingNext : -1,
    latest: Number.isFinite(latestConfirmed) ? latestConfirmed : null,
    mismatchedRecovery: Number.isFinite(pendingNext) && Number.isFinite(locked)
      ? pendingNext > locked
      : false,
  });

  return { pendingNext, latestConfirmed };
}

/** Minimum treasury native balance (wei) before broadcasting ERC20 payout — avoids wasted txs when empty on gas. */
const getMinNativeWeiForPayout = () => {
  const raw = String(process.env.HYBRID_PAYOUT_MIN_NATIVE_WEI || "").trim();
  if (raw) {
    try {
      return BigInt(raw);
    } catch {
      return parseEther("0.0001");
    }
  }
  return parseEther("0.0001");
};

const getPayoutPrivateKey = () =>
  String(process.env.HYBRID_PAYOUT_PRIVATE_KEY || "").trim();

export const canAutoExecuteWithdrawals = () =>
  Boolean(getPayoutPrivateKey() && hybridConfig.usdtContract);

const getPayoutSigner = (provider = getProvider()) => {
  const payoutKey = getPayoutPrivateKey();
  if (!payoutKey) {
    throw new Error("HYBRID_PAYOUT_PRIVATE_KEY missing");
  }

  return new Wallet(payoutKey, provider);
};

const getPayoutContract = (signer = null) => {
  if (!hybridConfig.usdtContract) {
    throw new Error("USDT contract not configured");
  }

  return new Contract(hybridConfig.usdtContract, BSC_USDT_ABI, signer || getPayoutSigner());
};

const isReplaceableFeeError = (err) => {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("replacement transaction underpriced") ||
    msg.includes("fee too low") ||
    (msg.includes("underpriced") && msg.includes("transaction"))
  );
};

const buildFeeOverrides = (feeData, bumpBps = 10000n) => {
  /** basis points — 10000 = 100% */
  const mult = BigInt(bumpBps);
  const out = {};
  if (feeData?.gasPrice) {
    out.gasPrice = (feeData.gasPrice * mult) / 10000n;
  }
  if (feeData?.maxFeePerGas) {
    out.maxFeePerGas = (feeData.maxFeePerGas * mult) / 10000n;
  }
  if (feeData?.maxPriorityFeePerGas) {
    out.maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas * mult) / 10000n;
  } else if (feeData?.maxFeePerGas && out.maxFeePerGas) {
    out.maxPriorityFeePerGas = (feeData.maxFeePerGas * 75n) / 100n;
  }
  return out;
};

/**
 * @param {import('ethers').Contract} token
 * @param {import('ethers').Wallet} signer
 */
async function sendPayoutUsdtTransfer({
  token,
  signer,
  to,
  amountWei,
  gasLimit,
  nonce,
  feeBumpBps = 10000n,
}) {
  const populated = await token.transfer.populateTransaction(to, amountWei);
  populated.gasLimit = gasLimit;
  populated.nonce = nonce;
  const feeData = await getCachedFeeData(signer.provider);
  Object.assign(populated, buildFeeOverrides(feeData, feeBumpBps));
  return signer.sendTransaction(populated);
}

/**
 * Requires a successful receipt and a matching USDT Transfer to the user's wallet
 * with value >= expected net (no blind trust of txHash).
 */
const verifyPayoutTransferInReceipt = async (txHash, toWalletLower, minNetAmount) => {
  if (!hybridConfig.usdtContract) {
    throw new Error("USDT contract not configured");
  }

  const tokenExpected = hybridConfig.usdtContract.toLowerCase();
  const toExpected = String(toWalletLower || "").trim().toLowerCase();

  if (!toExpected.startsWith("0x")) {
    throw new Error("Invalid payout wallet on record");
  }

  const receipt = await getReceiptDeduped(String(txHash).toLowerCase(), () =>
    withProviderRetry((p) =>
      withPayoutRpcTimeout(
        () => p.getTransactionReceipt(txHash),
        HYBRID_PAYOUT_RPC_TIMEOUT_MS,
        "tx_receipt",
      ),
    ),
  );

  if (!receipt) {
    throw new Error("Transaction receipt not found");
  }

  if (receipt.status !== 1) {
    throw new Error("Transaction failed on-chain");
  }

  const minWei = parseUnits(String(minNetAmount), HYBRID_TOKEN.decimals);
  let total = 0n;

  for (const log of receipt.logs) {
    if (String(log.address).toLowerCase() !== tokenExpected) {
      continue;
    }
    try {
      const parsed = transferEventIface.parseLog(log);
      if (parsed.name !== "Transfer") {
        continue;
      }
      const to = String(parsed.args.to).toLowerCase();
      if (to !== toExpected) {
        continue;
      }
      total += BigInt(parsed.args.value.toString());
    } catch {
      // not a Transfer we can parse
    }
  }

  if (total < minWei) {
    throw new Error("On-chain USDT transfer to user is below expected net payout");
  }
};

/**
 * Boolean wrapper for on-chain payout verification (used by admin pay flow).
 * Uses the same rules as verifyPayoutTransferInReceipt: successful receipt + USDT Transfer to user ≥ net.
 */
export const verifyPayoutTx = async (txHash, expectedAmount, userAddress) => {
  try {
    const raw = String(txHash || "").trim().toLowerCase();
    if (!raw.startsWith("0x") || raw.length < 10) {
      return false;
    }
    await verifyPayoutTransferInReceipt(
      raw,
      String(userAddress || "").toLowerCase(),
      expectedAmount
    );
    return true;
  } catch (err) {
    logger.warn("Hybrid payout verification failed", { reason: err?.message || String(err) });
    return false;
  }
};

const getPayoutBackoffMs = (withdrawal) =>
  Math.min(5 * 60 * 1000, (Number(withdrawal?.payoutAttemptCount || 1)) * 30000);

const storePayoutFailure = async (withdrawalId, error, withdrawal = null) => {
  const backoffMs = getPayoutBackoffMs(withdrawal);
  /** @type {{ payoutAttemptCount?: number } | null} */
  let counts = null;

  try {
    counts = await HybridWithdrawal.findById(withdrawalId).select("payoutAttemptCount").lean();
  } catch (_) {
    counts = null;
  }

  const attempts = Number(counts?.payoutAttemptCount ?? 0);
  const blockDeadLetter = attempts >= HYBRID_PAYOUT_MAX_ATTEMPTS;
  const errMsgRaw = String(error?.message || error || "Payout failed").slice(0, 500);
  const errMsgStored = blockDeadLetter
    ? `[blocked max=${HYBRID_PAYOUT_MAX_ATTEMPTS}] ${errMsgRaw}`.slice(0, 500)
    : errMsgRaw;

  if (blockDeadLetter) {
    bumpPayout("payoutsDeadLetterBlocked");
    logger.error("Hybrid payout exhausted retries — blocked for manual intervention", {
      withdrawalId: String(withdrawalId || ""),
      attempts,
      maxAttempts: HYBRID_PAYOUT_MAX_ATTEMPTS,
    });
  }

  await HybridWithdrawal.findOneAndUpdate(
    {
      _id: withdrawalId,
      status: "approved",
    },
    {
      $set: {
        payoutLastError: errMsgStored,
        payoutLockedUntil: blockDeadLetter ? null : new Date(Date.now() + backoffMs),
        payoutStatus: blockDeadLetter ? "blocked" : "failed",
      },
    },
  );

  invalidateTreasuryBalanceSnapshot();
};

const findPayoutTxHashByNonce = async (withdrawal, provider, payoutWallet) => {
  const payoutNonce = Number(withdrawal?.payoutNonce);
  const fromExpected = String(payoutWallet || withdrawal?.payoutWallet || "").toLowerCase();
  const tokenExpected = String(hybridConfig.usdtContract || "").toLowerCase();
  const toExpected = String(withdrawal?.walletAddress || "").toLowerCase();

  if (
    !Number.isInteger(payoutNonce) ||
    !fromExpected ||
    !tokenExpected ||
    !toExpected ||
    !provider?.getBlockNumber
  ) {
    return null;
  }

  const latestBlock = await getCachedBlockNumber(provider);
  const scanDepth = Math.max(1, Number(process.env.HYBRID_PAYOUT_NONCE_SCAN_BLOCKS || 500));
  const minBlock = Math.max(0, latestBlock - scanDepth);
  const minWei = parseUnits(String(withdrawal.netAmount), HYBRID_TOKEN.decimals);

  for (let blockNumber = latestBlock; blockNumber >= minBlock; blockNumber -= 1) {
    const block = await withProviderRetry((prov) =>
      withPayoutRpcTimeout(() => prov.getBlock(blockNumber, true), HYBRID_PAYOUT_RPC_TIMEOUT_MS, "nonce_scan_block"),
    );
    const txs = block?.prefetchedTransactions || block?.transactions || [];

    for (const item of txs) {
      const tx =
        typeof item === "string" && provider.getTransaction
          ? await withProviderRetry((prov) =>
              withPayoutRpcTimeout(() => prov.getTransaction(item), HYBRID_PAYOUT_RPC_TIMEOUT_MS, "nonce_scan_tx"),
            )
          : item;

      if (!tx) {
        continue;
      }

      if (
        String(tx.from || "").toLowerCase() !== fromExpected ||
        Number(tx.nonce) !== payoutNonce ||
        String(tx.to || "").toLowerCase() !== tokenExpected
      ) {
        continue;
      }

      try {
        const parsed = transferEventIface.parseTransaction({
          data: tx.data,
          value: tx.value || 0,
        });

        if (
          parsed?.name === "transfer" &&
          String(parsed.args?.[0] || parsed.args?.to || "").toLowerCase() === toExpected &&
          BigInt(parsed.args?.[1]?.toString?.() || parsed.args?.value?.toString?.() || 0) >= minWei
        ) {
          return normalizeTxHash(tx.hash);
        }
      } catch {
        // Different contract method or malformed transaction data.
      }
    }
  }

  return null;
};

const verifyAndMarkPaid = async (withdrawal, knownTxHash = null, runtime = {}) => {
  const txHash = normalizeTxHash(knownTxHash || withdrawal?.txHash);
  if (txHash) {
    const result = await runtime.markPaid(withdrawal._id, txHash);
    bumpPayout("payoutsMarkedPaid");
    logger.info("Hybrid withdrawal marked paid after verification", {
      withdrawalId: String(withdrawal._id),
    });
    return { processed: true, ...result };
  }

  const provider = runtime.getProvider();
  const recoveredTxHash = await runtime.findPayoutTxHashByNonce(
    withdrawal,
    provider,
    withdrawal.payoutWallet
  );

  if (!recoveredTxHash) {
    return { processed: false, reason: "nonce_used_tx_not_found" };
  }

  bumpPayout("payoutsNonceRecovery");
  const result = await runtime.markPaid(withdrawal._id, recoveredTxHash);
  bumpPayout("payoutsMarkedPaid");
  logger.info("Hybrid withdrawal marked paid after nonce-hash recovery scan", {
    withdrawalId: String(withdrawal._id),
  });
  return { processed: true, ...result };
};

const recoverNonceUsedPayout = async (withdrawal, runtime) => {
  if (!withdrawal) {
    return null;
  }
  const payoutNonce = Number(withdrawal?.payoutNonce);
  const payoutWallet = String(withdrawal?.payoutWallet || "").toLowerCase();

  if (!Number.isInteger(payoutNonce) || !payoutWallet.startsWith("0x")) {
    return null;
  }

  let checksumWallet;
  try {
    checksumWallet = getAddress(payoutWallet);
  } catch {
    return null;
  }

  const { pendingNext } = await readNonceSnapshot(checksumWallet, payoutNonce);
  if (!Number.isFinite(pendingNext) || pendingNext <= payoutNonce) {
    return null;
  }

  logger.warn("Hybrid payout nonce superseded mempool/chain hint — verifying existing transfer", {
    withdrawalId: String(withdrawal?._id || ""),
    payoutNonce,
    pendingNext,
  });
  return verifyAndMarkPaid(withdrawal, null, runtime);
};

const resetStaleSendingPayouts = async (withdrawalId = null, now = new Date()) => {
  const staleBefore = new Date(now.getTime() - STALE_PAYOUT_SENDING_MS);
  return HybridWithdrawal.updateMany(
    {
      ...(withdrawalId ? { _id: withdrawalId } : {}),
      status: "approved",
      paidAt: null,
      payoutStatus: "sending",
      payoutStartedAt: { $lte: staleBefore },
    },
    {
      $set: {
        payoutLastError: "Stale payout sender lock reset after crash recovery window",
        payoutLockedUntil: null,
        payoutStatus: "failed",
      },
    }
  );
};

const createPayoutRuntime = (overrides = {}) => ({
  findWithdrawalById: (id) => HybridWithdrawal.findById(id).lean(),
  findApprovedWithTxHash: () =>
    HybridWithdrawal.findOne({
      status: "approved",
      paidAt: null,
      txHash: { $type: "string", $ne: "" },
    })
      .sort({ approvedAt: 1, createdAt: 1 })
      .lean(),
  findNonceRecoveryWithdrawal: () =>
    HybridWithdrawal.findOne({
      status: "approved",
      paidAt: null,
      payoutStatus: { $nin: ["blocked"] },
      txHash: { $in: [null, ""] },
      payoutNonce: { $exists: true },
      payoutWallet: { $type: "string", $ne: "" },
    })
      .sort({ payoutStartedAt: 1, approvedAt: 1, createdAt: 1 })
      .lean(),
  claimWithdrawal: (withdrawalId, now, lockUntil) =>
    HybridWithdrawal.findOneAndUpdate(
      {
        ...(withdrawalId ? { _id: withdrawalId } : {}),
        status: "approved",
        paidAt: null,
        payoutStatus: { $nin: ["sending", "blocked"] },
        $and: [
          {
            $or: [
              { payoutLockedUntil: null },
              { payoutLockedUntil: { $exists: false } },
              { payoutLockedUntil: { $lte: now } },
            ],
          },
          {
            $or: [
              { forcePayout: true },
              {
                $and: [
                  { autoEligibleAt: { $exists: true } },
                  { autoEligibleAt: { $ne: null } },
                  { autoEligibleAt: { $lte: now } },
                ],
              },
              {
                $and: [
                  {
                    $or: [{ autoEligibleAt: { $exists: false } }, { autoEligibleAt: null }],
                  },
                  { availableAt: { $lte: now } },
                ],
              },
            ],
          },
        ],
      },
      {
        $set: {
          payoutLockedUntil: lockUntil,
          payoutStartedAt: now,
          payoutLastError: "",
          payoutStatus: "sending",
        },
        $inc: {
          payoutAttemptCount: 1,
        },
      },
      {
        new: true,
        sort: { forcePayout: -1, approvedAt: 1, createdAt: 1 },
      }
    ).lean(),
  lockPayoutNonce: (withdrawalId, nonce, payoutWallet) =>
    HybridWithdrawal.findOneAndUpdate(
      { _id: withdrawalId, payoutNonce: { $exists: false } },
      {
        $set: {
          payoutNonce: nonce,
          payoutWallet,
        },
      },
      { new: true }
    ).lean(),
  storePayoutTxHash: (withdrawalId, txHash) =>
    HybridWithdrawal.findOneAndUpdate(
      {
        _id: withdrawalId,
        status: "approved",
        paidAt: null,
        $or: [{ txHash: null }, { txHash: "" }, { txHash: { $exists: false } }],
      },
      {
        $set: {
          txHash,
          payoutStatus: "verifying",
        },
      },
      { new: true }
    ).lean(),
  getIdempotencyRecord,
  getCompletedIdempotency,
  markIdempotencyProcessing,
  completeIdempotency,
  releaseIdempotentAction,
  storePayoutFailure,
  resetStaleSendingPayouts,
  getProvider,
  getPayoutSigner,
  getPayoutContract,
  findPayoutTxHashByNonce,
  verifyReceipt: verifyPayoutTransferInReceipt,
  markPaid: markHybridWithdrawalPaidAfterAutoVerification,
  now: () => new Date(),
  ...overrides,
});

export const executeApprovedWithdrawalPayout = async (withdrawalId = null, runtimeOverrides = {}) => {
  const runtime = createPayoutRuntime(runtimeOverrides);
  const now = new Date();
  const lockUntil = new Date(now.getTime() + PAYOUT_LOCK_MS);

  if (withdrawalId) {
    const existingWithdrawal = await runtime.findWithdrawalById(withdrawalId);
    if (existingWithdrawal?.status === "paid") {
      return { processed: false, reason: "already_paid" };
    }
    const existingTxHash = normalizeTxHash(existingWithdrawal?.txHash);
    if (existingTxHash) {
      logger.debug?.("Hybrid payout verifying stored tx hash", {
        withdrawalId: String(withdrawalId),
      });
      return verifyAndMarkPaid(existingWithdrawal, existingTxHash, runtime);
    }

    const nonceRecovery = await recoverNonceUsedPayout(existingWithdrawal, runtime);
    if (nonceRecovery) {
      logger.debug?.("Hybrid payout mempool nonce recovery verified", {
        withdrawalId: String(withdrawalId),
      });
      return nonceRecovery;
    }
    const staleOne = await runtime.resetStaleSendingPayouts(withdrawalId, now);
    if (Number(staleOne?.modifiedCount || 0) > 0) {
      bumpPayout("payoutsStaleRecoveries");
    }
  } else {
    const recoverable = await runtime.findApprovedWithTxHash();
    if (recoverable) {
      logger.debug?.("Hybrid payout verifying approved row with tx hash", {
        withdrawalId: String(recoverable._id),
      });
      return verifyAndMarkPaid(recoverable, recoverable.txHash, runtime);
    }

    const nonceRecoverable = await runtime.findNonceRecoveryWithdrawal();
    const nonceRecovery = await recoverNonceUsedPayout(nonceRecoverable, runtime);
    if (nonceRecovery) {
      logger.debug?.("Hybrid payout nonce recovery verified (batch picker)", {
        withdrawalId: String(nonceRecoverable?._id || ""),
      });
      return nonceRecovery;
    }

    const staleAll = await runtime.resetStaleSendingPayouts(null, now);
    if (Number(staleAll?.modifiedCount || 0) > 0) {
      bumpPayout("payoutsStaleRecoveries");
    }
  }

  let hotWalletAddr;
  try {
    const pk = getPayoutPrivateKey();
    if (!pk) {
      return { processed: false, reason: "payout_wallet_misconfigured" };
    }
    hotWalletAddr = new Wallet(pk).address;
  } catch {
    return { processed: false, reason: "payout_wallet_misconfigured" };
  }

  const redis = getReadyRedis();

  const runUnderPayoutWalletLock = async () => {
    let withdrawal = await runtime.claimWithdrawal(withdrawalId, now, lockUntil);

    if (!withdrawal) {
      return { processed: false, reason: "none_available" };
    }

    bumpPayout("payoutAttempts");
    logger.debug?.("Hybrid payout row locked for broadcast", {
      withdrawalId: String(withdrawal._id),
    });

    const payoutKey = `withdrawal:${String(withdrawal._id)}`;
    let txHash = normalizeTxHash(withdrawal.txHash);
    let signer = null;
    let provider = null;

    try {
      if (txHash) {
        return verifyAndMarkPaid(withdrawal, txHash, runtime);
      }

      const idempotencyRecord = await runtime.getIdempotencyRecord("payout", payoutKey);
      if (idempotencyRecord?.status === "completed" && idempotencyRecord?.response?.txHash) {
        return verifyAndMarkPaid(withdrawal, idempotencyRecord.response.txHash, runtime);
      }

      if (idempotencyRecord?.status === "processing") {
        bumpPayout("payoutsIdempotentSkip");
        logger.warn("Hybrid payout idempotency replay — reconciliation only", {
          withdrawalId: String(withdrawal._id),
        });
        return verifyAndMarkPaid(withdrawal, null, runtime);
      }

      provider = runtime.getProvider();
      signer = runtime.getPayoutSigner(provider);
      let payoutNonce = Number(withdrawal.payoutNonce);

      if (!Number.isInteger(payoutNonce)) {
        payoutNonce = await reservePayoutNonce({
          redis,
          provider,
          payoutWalletAddress: signer.address,
          persistedNonce: null,
        });

        const nonceLocked = await runtime.lockPayoutNonce(
          withdrawal._id,
          payoutNonce,
          String(signer.address || "").toLowerCase(),
        );

        withdrawal = nonceLocked || (await runtime.findWithdrawalById(withdrawal._id));
      } else {
        await syncNonceMirrorFromChain(redis, signer.address, provider);
        payoutNonce = Number(withdrawal.payoutNonce);
      }

      if (!Number.isInteger(Number(withdrawal?.payoutNonce))) {
        throw new Error("Unable to lock payout nonce before broadcast");
      }

      const payerChecksum = getAddress(String(signer.address));
      const { pendingNext } = await readNonceSnapshot(payerChecksum, Number(withdrawal.payoutNonce));
      if (Number.isFinite(pendingNext) && pendingNext > Number(withdrawal.payoutNonce)) {
        logger.warn("Hybrid payout payer nonce advanced before broadcast — reconciling chain state", {
          withdrawalId: String(withdrawal._id),
          lockedNonce: Number(withdrawal.payoutNonce),
          pendingNext,
        });
        return verifyAndMarkPaid(withdrawal, null, runtime);
      }

      const token = runtime.getPayoutContract(signer);
      const amountWei = parseUnits(String(withdrawal.netAmount), HYBRID_TOKEN.decimals);

      const { nativeWei, tokenWei } = await rpcReadTreasuryBalances(token, signer.address);
      if (tokenWei < amountWei) {
        const ins = new Error("Insufficient treasury balance");
        ins.statusCode = 400;
        throw ins;
      }

      const minGasWei = getMinNativeWeiForPayout();
      if (nativeWei < minGasWei) {
        const gasErr = new Error("Insufficient native balance for gas (BNB)");
        gasErr.statusCode = 400;
        throw gasErr;
      }

      await runtime.markIdempotencyProcessing("payout", payoutKey);

      const gasLimit = await rpcMinGasLimitForTransfer(
        token,
        signer,
        withdrawal.walletAddress,
        amountWei,
      );

      let tx;
      const sendOnce = (feeBps) =>
        sendPayoutUsdtTransfer({
          token,
          signer,
          to: withdrawal.walletAddress,
          amountWei,
          gasLimit,
          nonce: Number(withdrawal.payoutNonce),
          feeBumpBps: feeBps,
        });

      try {
        tx = await sendOnce(10000n);
      } catch (errSend) {
        if (isReplaceableFeeError(errSend)) {
          bumpPayout("payoutsGasBump");
          logger.warn("Hybrid payout retrying broadcast with higher fee", {
            withdrawalId: String(withdrawal._id),
            nonce: Number(withdrawal.payoutNonce),
          });
          tx = await sendOnce(12800n);
        } else {
          throw errSend;
        }
      }

      bumpPayout("payoutsBroadcast");
      txHash = normalizeTxHash(tx.hash);

      if (!txHash) {
        throw new Error("Payout transaction hash missing after broadcast");
      }

      logger.info("Hybrid payout broadcast submitted", {
        withdrawalId: String(withdrawal._id),
        txHash,
      });

      const stored = await runtime.storePayoutTxHash(withdrawal._id, txHash);

      if (!stored) {
        throw new Error("Unable to store payout transaction hash");
      }

      await advanceNonceMirrorAfterBroadcast(
        redis,
        signer.address,
        Number(withdrawal.payoutNonce),
        provider,
      );

      try {
        await tx.wait(1, HYBRID_PAYOUT_TX_WAIT_MS);
      } catch (waitErr) {
        logger.warn("Hybrid payout confirmation wait interrupted — probing receipt manually", {
          withdrawalId: String(withdrawal._id),
          txHash,
          error: waitErr?.message || String(waitErr),
        });
      }

      await runtime.verifyReceipt(txHash, withdrawal.walletAddress, withdrawal.netAmount);

      logger.info("Hybrid payout on-chain verification succeeded", {
        withdrawalId: String(withdrawal._id),
        txHash,
        walletAddress: String(withdrawal.walletAddress || "").toLowerCase(),
      });
      const result = await verifyAndMarkPaid(withdrawal, txHash, runtime);
      await runtime.completeIdempotency(
        "payout",
        payoutKey,
        {
          withdrawalId: String(withdrawal._id),
          txHash,
          status: "paid",
        },
      );
      return result;
    } catch (error) {
      logger.error("Hybrid payout execution failed", {
        withdrawalId: String(withdrawal?._id || ""),
        error: error?.message || String(error),
      });
      if (signer && provider) {
        await reconcileNonceMirrorAfterFailure(redis, provider, signer.address).catch(() => {});
      }
      if (!txHash && !Number.isInteger(Number(withdrawal?.payoutNonce))) {
        await runtime.releaseIdempotentAction("payout", payoutKey);
      }
      await runtime.storePayoutFailure(withdrawal._id, error, withdrawal);
      throw error;
    }
  };

  try {
    if (runtimeOverrides?.skipPayoutWalletMutex === true) {
      return await runUnderPayoutWalletLock();
    }
    return await withPayoutWalletExclusive(
      redis,
      hotWalletAddr,
      payoutPipelineConfig.payoutWalletLockMs,
      runUnderPayoutWalletLock,
    );
  } catch (error) {
    if (error?.code === "PAYOUT_WALLET_BUSY") {
      bumpPayout("payoutWalletMutexBusy");
      return { processed: false, reason: "wallet_busy" };
    }
    throw error;
  }
};

export const autoApproveHybridWithdrawalsForPayoutWindow = async (now = new Date()) => {
  const filter = {
    status: "pending",
    paidAt: null,
    approvedAt: null,
    $or: [
      {
        $and: [
          { autoEligibleAt: { $exists: true } },
          { autoEligibleAt: { $ne: null } },
          { autoEligibleAt: { $lte: now } },
        ],
      },
      {
        $and: [
          { $or: [{ autoEligibleAt: { $exists: false } }, { autoEligibleAt: null }] },
          { availableAt: { $lte: now } },
        ],
      },
    ],
  };

  const result = await HybridWithdrawal.updateMany(filter, {
    $set: { status: "approved", approvedAt: now },
  });

  if (result.modifiedCount > 0) {
    logger.info("Hybrid withdrawals auto-approved for payout window", {
      modifiedCount: result.modifiedCount,
    });
  }

  return result;
};

export const runAutoWithdrawExecutorBatch = async (limit = 1, runtimeOverrides = {}) => {
  if (!canAutoExecuteWithdrawals()) {
    return { enabled: false, processed: 0, failed: 0, observability: payoutObservabilitySnapshot() };
  }

  await autoApproveHybridWithdrawalsForPayoutWindow(new Date());

  let processed = 0;
  let failed = 0;
  const max = Math.max(1, Number(limit) || 1);

  for (let i = 0; i < max; i += 1) {
    try {
      const result = await executeApprovedWithdrawalPayout(null, runtimeOverrides);
      if (!result?.processed) {
        break;
      }
      processed += 1;
    } catch (err) {
      failed += 1;
      logger.warn("Hybrid auto payout batch item failed — continuing bounded loop", {
        error: err?.message || String(err),
        index: i,
      });
    }
  }

  return {
    enabled: true,
    processed,
    failed,
    observability: payoutObservabilitySnapshot(),
  };
};

/** Legacy hook retained for engine scheduling; hybrid withdrawals auto-approve via executor batch. */
export const autoMarkClaimable = async () => {
  return { modifiedCount: 0 };
};

export const adminApproveHybridWithdrawal = async (withdrawalId, adminId = null) => {
  if (!withdrawalId) {
    throw adminClientError("Withdrawal ID required");
  }

  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const withdrawal = await HybridWithdrawal.findById(withdrawalId).session(session);

    if (!withdrawal) {
      throw adminClientError("Withdrawal not found", 404);
    }

    assertAdminQueuedHybridWithdrawal(withdrawal);
    assertWithdrawTransition(withdrawal.status, "approved");

    /* Admin approval may precede on-chain payout; claim step still enforces availableAt unless forcePayout. */
    const updated = await HybridWithdrawal.findOneAndUpdate(
      {
        _id: withdrawalId,
        status: { $in: ADMIN_QUEUE_WITHDRAW_STATUSES },
        approvedAt: null,
        paidAt: null,
      },
      {
        $set: {
          status: "approved",
          forcePayout: false,
          approvedAt: new Date(),
          ...(adminId ? { approvedBy: adminId } : {}),
        },
      },
      { new: true, session }
    );

    if (!updated) {
      throw adminClientError("Unable to approve withdrawal");
    }

    await session.commitTransaction();
    return updated;
  } catch (error) {
    await session.abortTransaction();
    throw wrapAdminClientError(error, "Failed to approve withdrawal");
  } finally {
    session.endSession();
  }
};

export const adminForcePayoutHybridWithdrawal = async (withdrawalId, adminId = null) => {
  if (!withdrawalId) {
    throw adminClientError("Withdrawal ID required");
  }

  if (!canAutoExecuteWithdrawals()) {
    throw adminClientError(
      "Hybrid payout wallet not configured; cannot execute force payout.",
      503
    );
  }

  const session = await mongoose.startSession();
  let updated = null;

  try {
    session.startTransaction();

    const withdrawal = await HybridWithdrawal.findById(withdrawalId).session(session);

    if (!withdrawal) {
      throw adminClientError("Withdrawal not found", 404);
    }

    if (withdrawal.paidAt != null || withdrawal.status === "paid") {
      throw adminClientError("Withdrawal already paid", 400);
    }

    if (withdrawal.status === "rejected") {
      throw adminClientError("Cannot force payout a rejected withdrawal", 400);
    }

    const now = new Date();

    if (ADMIN_QUEUE_WITHDRAW_STATUSES.includes(withdrawal.status)) {
      assertAdminQueuedHybridWithdrawal(withdrawal);
      assertWithdrawTransition(withdrawal.status, "approved");

      updated = await HybridWithdrawal.findOneAndUpdate(
        {
          _id: withdrawalId,
          status: { $in: ADMIN_QUEUE_WITHDRAW_STATUSES },
          approvedAt: null,
          paidAt: null,
        },
        {
          $set: {
            status: "approved",
            forcePayout: true,
            approvedAt: now,
            ...(adminId ? { approvedBy: adminId } : {}),
          },
        },
        { new: true, session }
      );

      if (!updated) {
        throw adminClientError("Unable to force-approve withdrawal");
      }
    } else if (withdrawal.status === "approved") {
      updated = await HybridWithdrawal.findOneAndUpdate(
        {
          _id: withdrawalId,
          status: "approved",
          paidAt: null,
        },
        {
          $set: {
            forcePayout: true,
            ...(!withdrawal.approvedAt ? { approvedAt: now } : {}),
            ...(adminId ? { approvedBy: adminId } : {}),
          },
        },
        { new: true, session }
      );

      if (!updated) {
        throw adminClientError("Unable to update withdrawal for force payout");
      }
    } else {
      throw adminClientError("Invalid state for force payout", 400);
    }

    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw wrapAdminClientError(error, "Failed to force payout");
  } finally {
    session.endSession();
  }

  logger.info("Admin force payout requested", {
    withdrawalId: String(withdrawalId),
    adminId: adminId ? String(adminId) : null,
  });

  let payoutResult;
  try {
    payoutResult = await executeApprovedWithdrawalPayout(withdrawalId);
  } catch (error) {
    throw wrapAdminClientError(error, "Force payout execution failed");
  }

  if (!payoutResult?.processed) {
    if (payoutResult?.reason === "already_paid") {
      const w = await HybridWithdrawal.findById(withdrawalId).lean();
      const txHashPaid = normalizeTxHash(w?.txHash);
      return {
        withdrawal: w || updated?.toObject?.() || updated,
        payout: payoutResult,
        txHash: txHashPaid || null,
      };
    }

    throw adminClientError(
      payoutResult?.reason === "none_available" || payoutResult?.reason === "wallet_busy"
        ? "Payout lock busy or withdrawal not eligible yet; retry shortly."
        : `Force payout incomplete: ${payoutResult?.reason || "unknown"}`,
      409
    );
  }

  const refreshed = await HybridWithdrawal.findById(withdrawalId).lean();
  const txHash =
    normalizeTxHash(payoutResult?.txHash) || normalizeTxHash(refreshed?.txHash);

  return {
    withdrawal: refreshed || updated?.toObject?.() || updated,
    payout: payoutResult,
    txHash: txHash || null,
  };
};

const markHybridWithdrawalPaidAfterAutoVerification = async (withdrawalId, txHash) => {
  const normalized = normalizeTxHash(txHash);
  if (!normalized) {
    throw adminClientError("Valid transaction hash required");
  }

  const head = await HybridWithdrawal.findById(withdrawalId).select("status").lean();
  if (!head) {
    throw adminClientError("Withdrawal not found", 404);
  }
  if (head.status === "paid") {
    throw adminClientError("Withdrawal already paid");
  }
  assertWithdrawTransition(head.status, "paid");

  const preCheck = await HybridWithdrawal.findOne({
    _id: withdrawalId,
    status: "approved",
  })
    .select("walletAddress netAmount")
    .lean();

  if (!preCheck) {
    throw adminClientError("Withdrawal not found or not approved");
  }

  const isValid = await verifyPayoutTx(normalized, preCheck.netAmount, preCheck.walletAddress);
  if (!isValid) {
    throw adminClientError("Invalid payout transaction");
  }

  const session = await mongoose.startSession();

  try {
    let result = null;
    session.startTransaction();

    const withdrawal = await HybridWithdrawal.findOne({
      _id: withdrawalId,
      status: "approved",
      paidAt: null,
    }).session(session);

    if (!withdrawal) {
      throw adminClientError("Withdrawal not found or not approved");
    }

    const userBeforePay = await User.findById(withdrawal.userId)
      .select("pendingWithdraw")
      .session(session)
      .lean();

    if (
      !userBeforePay ||
      Number(userBeforePay.pendingWithdraw || 0) < Number(withdrawal.grossAmount || 0)
    ) {
      logger.warn("Hybrid withdraw mark-paid aborted — pendingWithdraw mismatch versus gross", {
        withdrawalId: String(withdrawalId),
      });
      throw adminClientError("Pending balance mismatch");
    }

    const duplicateTx = await HybridWithdrawal.findOne({
      txHash: normalized,
      _id: { $ne: withdrawalId },
    })
      .select("_id")
      .lean()
      .session(session);

    if (duplicateTx) {
      throw adminClientError("Transaction hash already used");
    }

    const nowPaid = new Date();
    const paid = await HybridWithdrawal.findOneAndUpdate(
      {
        _id: withdrawalId,
        status: "approved",
        paidAt: null,
      },
      {
        $set: {
          status: "paid",
          txHash: normalized,
          paidAt: nowPaid,
          payoutStatus: "idle",
          payoutLockedUntil: null,
          payoutLastError: "",
        },
      },
      { new: true, session }
    );

    if (!paid) {
      throw adminClientError("Unable to mark withdrawal paid");
    }

    const updatedUser = await User.findOneAndUpdate(
      {
        _id: paid.userId,
        pendingWithdraw: { $gte: Number(paid.grossAmount || 0) },
      },
      {
        $inc: {
          pendingWithdraw: -Number(paid.grossAmount || 0),
        },
        $set: {
          lastWithdrawRequest: nowPaid,
        },
      },
      { new: true, session }
    );

    if (!updatedUser) {
      throw adminClientError("Pending withdrawal balance mismatch");
    }

    await addHybridLedgerEntries(
      [
        {
          userId: paid.userId,
          entryType: "debit",
          balanceType: "pendingWithdraw",
          amount: Number(paid.grossAmount || 0),
          source: "withdraw_payout",
          referenceId: paid._id,
          meta: {
            netAmount: Number(paid.netAmount || 0),
            feeAmount: Number(paid.feeAmount || 0),
            walletAddress: paid.walletAddress,
            txHash: normalized,
          },
        },
      ],
      session
    );

    logger.info("Hybrid withdrawal paid ledger recorded", {
      withdrawalId: String(paid._id),
      userId: String(paid.userId),
      txHash: normalized,
      walletAddress: String(paid.walletAddress || "").toLowerCase(),
      netAmount: Number(paid.netAmount || 0),
    });

    result = { withdrawal: paid, txHash: normalized };
    await session.commitTransaction();
    return result;
  } catch (error) {
    await session.abortTransaction();
    const code = error?.code ?? error?.cause?.code;
    const isDupTx =
      code === 11000 ||
      /E11000/i.test(String(error?.message || "")) ||
      /duplicate key/i.test(String(error?.message || ""));
    if (isDupTx) {
      throw adminClientError("Transaction hash already used");
    }
    throw wrapAdminClientError(error, "Failed to mark withdrawal paid");
  } finally {
    session.endSession();
  }
};

export const adminMarkHybridWithdrawalPaid = async () => {
  throw adminClientError("Manual mark-paid is disabled. Approved withdrawals are paid by the auto executor.", 410);
};

export const adminRejectHybridWithdrawal = async (withdrawalId) => {
  if (!withdrawalId) {
    throw adminClientError("Withdrawal ID required");
  }

  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const withdrawal = await HybridWithdrawal.findById(withdrawalId).session(session);

    if (!withdrawal) {
      throw adminClientError("Withdrawal not found", 404);
    }

    assertAdminRejectableHybridWithdrawal(withdrawal);
    assertWithdrawTransition(withdrawal.status, "rejected");

    logger.warn("Hybrid withdraw admin reject started", {
      withdrawalId: String(withdrawalId),
      status: withdrawal.status,
      gross: withdrawal.grossAmount,
    });

    const gross = Number(withdrawal.grossAmount || 0);
    const { rewardBack, depositBack } = await resolveRejectSourceSplit(withdrawal, session);

    if (!Number.isFinite(gross) || gross <= 0) {
      throw adminClientError("Invalid withdrawal gross amount");
    }

    if (rewardBack + depositBack <= 0) {
      throw adminClientError("Cannot reject this withdrawal: missing source breakdown (legacy record)");
    }

    const splitSum = Number((rewardBack + depositBack).toFixed(8));
    const grossR = Number(gross.toFixed(8));
    if (Math.abs(splitSum - grossR) > 0.0001) {
      throw adminClientError("Source breakdown does not match gross amount; reject aborted");
    }

    const updatedWithdrawal = await HybridWithdrawal.findOneAndUpdate(
      {
        _id: withdrawalId,
        paidAt: null,
        $or: [
          {
            status: { $in: ADMIN_QUEUE_WITHDRAW_STATUSES },
            approvedAt: null,
          },
          {
            status: "approved",
            payoutStatus: { $nin: ["sending", "verifying"] },
          },
        ],
      },
      { $set: { status: "rejected" } },
      { new: true, session }
    );

    if (!updatedWithdrawal) {
      throw adminClientError("Unable to reject withdrawal");
    }

    const updatedUser = await User.findOneAndUpdate(
      {
        _id: withdrawal.userId,
        pendingWithdraw: { $gte: gross },
      },
      {
        $inc: {
          pendingWithdraw: -gross,
          rewardBalance: rewardBack,
          depositBalance: depositBack,
        },
        $set: { lastWithdrawRequest: null },
      },
      { new: true, session }
    );

    if (!updatedUser) {
      throw adminClientError("User balance state mismatch; reject aborted");
    }

    const ledger = [
      {
        userId: withdrawal.userId,
        entryType: "debit",
        balanceType: "pendingWithdraw",
        amount: gross,
        source: "withdraw_reject",
        referenceId: withdrawal._id,
        meta: { walletAddress: withdrawal.walletAddress },
      },
    ];

    if (rewardBack > 0) {
      ledger.push({
        userId: withdrawal.userId,
        entryType: "credit",
        balanceType: "rewardBalance",
        amount: rewardBack,
        source: "withdraw_reject",
        referenceId: withdrawal._id,
        meta: { walletAddress: withdrawal.walletAddress },
      });
    }

    if (depositBack > 0) {
      ledger.push({
        userId: withdrawal.userId,
        entryType: "credit",
        balanceType: "depositBalance",
        amount: depositBack,
        source: "withdraw_reject",
        referenceId: withdrawal._id,
        meta: { walletAddress: withdrawal.walletAddress },
      });
    }

    await addHybridLedgerEntries(ledger, session);
    await session.commitTransaction();
    return updatedWithdrawal;
  } catch (error) {
    await session.abortTransaction();
    logger.error("Hybrid withdraw reject failed", { error: error?.message || error });
    throw wrapAdminClientError(error, "Failed to reject withdrawal");
  } finally {
    session.endSession();
  }
};

/**
 * Reject every unpaid hybrid withdrawal in the admin queue (pending/review/claimable) plus
 * approved-but-unpaid rows, excluding payouts that are actively sending/verifying.
 * One MongoDB transaction — all-or-nothing; mirrors {@link adminRejectHybridWithdrawal} per row.
 */
export const adminRejectAllHybridWithdrawals = async (adminId) => {
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const candidates = await HybridWithdrawal.find({
      paidAt: null,
      $or: [
        { status: { $in: ADMIN_QUEUE_WITHDRAW_STATUSES }, approvedAt: null },
        { status: "approved", payoutStatus: { $nin: ["sending", "verifying"] } },
      ],
    })
      .session(session)
      .sort({ _id: 1 });

    let totalRejected = 0;

    logger.warn("Hybrid withdraw bulk reject-all started", {
      adminId: String(adminId || ""),
      candidateCount: candidates.length,
    });

    for (const withdrawal of candidates) {
      assertAdminRejectableHybridWithdrawal(withdrawal);
      assertWithdrawTransition(withdrawal.status, "rejected");

      const withdrawalId = withdrawal._id;
      const gross = Number(withdrawal.grossAmount || 0);
      const { rewardBack, depositBack } = await resolveRejectSourceSplit(withdrawal, session);

      if (!Number.isFinite(gross) || gross <= 0) {
        throw adminClientError(
          `Invalid withdrawal gross amount (withdrawal ${String(withdrawalId)})`
        );
      }

      if (rewardBack + depositBack <= 0) {
        throw adminClientError(
          `Cannot reject withdrawal ${String(withdrawalId)}: missing source breakdown (legacy record)`
        );
      }

      const splitSum = Number((rewardBack + depositBack).toFixed(8));
      const grossR = Number(gross.toFixed(8));
      if (Math.abs(splitSum - grossR) > 0.0001) {
        throw adminClientError(
          `Source breakdown does not match gross for withdrawal ${String(withdrawalId)}; reject-all aborted`
        );
      }

      const updatedWithdrawal = await HybridWithdrawal.findOneAndUpdate(
        {
          _id: withdrawalId,
          paidAt: null,
          $or: [
            {
              status: { $in: ADMIN_QUEUE_WITHDRAW_STATUSES },
              approvedAt: null,
            },
            {
              status: "approved",
              payoutStatus: { $nin: ["sending", "verifying"] },
            },
          ],
        },
        { $set: { status: "rejected" } },
        { new: true, session }
      );

      if (!updatedWithdrawal) {
        throw adminClientError(`Unable to reject withdrawal ${String(withdrawalId)}`);
      }

      const updatedUser = await User.findOneAndUpdate(
        {
          _id: withdrawal.userId,
          pendingWithdraw: { $gte: gross },
        },
        {
          $inc: {
            pendingWithdraw: -gross,
            rewardBalance: rewardBack,
            depositBalance: depositBack,
          },
          $set: { lastWithdrawRequest: null },
        },
        { new: true, session }
      );

      if (!updatedUser) {
        throw adminClientError(
          `User balance state mismatch for withdrawal ${String(withdrawalId)}; reject-all aborted`
        );
      }

      const ledger = [
        {
          userId: withdrawal.userId,
          entryType: "debit",
          balanceType: "pendingWithdraw",
          amount: gross,
          source: "withdraw_reject",
          referenceId: withdrawal._id,
          meta: { walletAddress: withdrawal.walletAddress },
        },
      ];

      if (rewardBack > 0) {
        ledger.push({
          userId: withdrawal.userId,
          entryType: "credit",
          balanceType: "rewardBalance",
          amount: rewardBack,
          source: "withdraw_reject",
          referenceId: withdrawal._id,
          meta: { walletAddress: withdrawal.walletAddress },
        });
      }

      if (depositBack > 0) {
        ledger.push({
          userId: withdrawal.userId,
          entryType: "credit",
          balanceType: "depositBalance",
          amount: depositBack,
          source: "withdraw_reject",
          referenceId: withdrawal._id,
          meta: { walletAddress: withdrawal.walletAddress },
        });
      }

      await addHybridLedgerEntries(ledger, session);
      totalRejected += 1;
    }

    await session.commitTransaction();
    logger.info("Hybrid withdraw bulk reject-all completed", {
      totalRejected,
      adminId: String(adminId || ""),
    });
    return { totalRejected };
  } catch (error) {
    await session.abortTransaction();
    logger.error("Hybrid withdraw bulk reject-all failed", { error: error?.message || error });
    throw wrapAdminClientError(error, "Failed to reject all withdrawals");
  } finally {
    session.endSession();
  }
};
