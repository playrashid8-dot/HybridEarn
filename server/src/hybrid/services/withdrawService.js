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
import {
  getActiveHybridWithdrawal,
  getHybridWithdrawalAvailability,
  getSpendableHybridBalance,
} from "./balanceService.js";
import {
  completeIdempotency,
  failIdempotency,
  getCompletedIdempotency,
  getIdempotencyRecord,
  markIdempotencyProcessing,
  releaseIdempotentAction,
} from "./idempotencyService.js";
import { runMongoTransaction } from "../../config/mongoTransactions.js";

/** Min delay after `lastWithdrawRequest` before another Hybrid withdraw request (payout completion refreshes this). */
const WITHDRAW_REQUEST_COOLDOWN_MS = 60 * 1000;

const getMonthlyLimit = (level) => WITHDRAW_MONTHLY_LIMITS[Math.min(Number(level || 0), 3)] || 0;
const WITHDRAW_BALANCE_EPSILON = 0.00000001;
const WITHDRAW_MONEY_DECIMALS = 8;
const WITHDRAW_MONEY_SCALE = 10 ** WITHDRAW_MONEY_DECIMALS;

const toMoneyNumber = (value) => {
  if (value == null) return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
};
const toMoneyUnits = (value) => Math.round(toMoneyNumber(value) * WITHDRAW_MONEY_SCALE);
const fromMoneyUnits = (units) => Number((Number(units || 0) / WITHDRAW_MONEY_SCALE).toFixed(WITHDRAW_MONEY_DECIMALS));
const toFixedMoney = (value) => fromMoneyUnits(toMoneyUnits(value));
const describeMoneyPrecision = (value) => {
  const numeric = toMoneyNumber(value);
  const finite = Number.isFinite(numeric);

  return {
    value,
    jsType: typeof value,
    bsonType: value?._bsontype || value?.constructor?.name || null,
    toStringValue: value?.toString?.() ?? String(value),
    numberValue: finite ? numeric : null,
    numberPrecision17: finite ? numeric.toPrecision(17) : null,
    normalizedValue: finite ? toFixedMoney(numeric) : null,
    normalizedUnits: finite ? toMoneyUnits(numeric) : null,
  };
};
const pendingWithdrawClearFilter = () => ({
  $or: [
    { pendingWithdraw: { $lte: WITHDRAW_BALANCE_EPSILON } },
    { pendingWithdraw: { $exists: false } },
    { pendingWithdraw: null },
  ],
});
const isPositiveMoney = (value) => Number(value || 0) > WITHDRAW_BALANCE_EPSILON;
const buildAtomicWithdrawalUserFilter = (userId, sourceBreakdown) => {
  const filter = {
    _id: userId,
    ...pendingWithdrawClearFilter(),
  };

  if (isPositiveMoney(sourceBreakdown.rewardBalance)) {
    filter.rewardBalance = { $gte: toFixedMoney(sourceBreakdown.rewardBalance) };
  }
  if (isPositiveMoney(sourceBreakdown.depositBalance)) {
    filter.depositBalance = { $gte: toFixedMoney(sourceBreakdown.depositBalance) };
  }

  return filter;
};
const describeAtomicFilterBucket = (filter, field) => {
  const condition = filter?.[field];
  if (!condition || !Object.prototype.hasOwnProperty.call(condition, "$gte")) {
    return { enabled: false };
  }

  return {
    enabled: true,
    operator: "$gte",
    required: describeMoneyPrecision(condition.$gte),
  };
};
const describeAtomicWithdrawalFilter = (filter) => ({
  _id: filter?._id?.toString?.() ?? String(filter?._id),
  pendingWithdraw: filter?.$or,
  rewardBalance: describeAtomicFilterBucket(filter, "rewardBalance"),
  depositBalance: describeAtomicFilterBucket(filter, "depositBalance"),
});
const describeRawMongoValue = (doc, field) => {
  const exists = Boolean(doc) && Object.prototype.hasOwnProperty.call(doc, field);
  const value = exists ? doc[field] : undefined;
  const numeric = exists && value != null ? toMoneyNumber(value) : null;

  return {
    exists,
    rawValue: exists ? value?.toString?.() ?? value : "__missing__",
    jsType: exists ? typeof value : "undefined",
    bsonType: value?._bsontype || value?.constructor?.name || null,
    toStringValue: exists ? value?.toString?.() ?? String(value) : "__missing__",
    numberValue: exists && value != null ? numeric : null,
    numberPrecision17:
      exists && value != null && Number.isFinite(numeric) ? numeric.toPrecision(17) : null,
    normalizedValue: exists && value != null ? toFixedMoney(value) : null,
    normalizedUnits: exists && value != null ? toMoneyUnits(value) : null,
  };
};
const compareAtomicBalanceBuckets = (documentValues, filter) => {
  const compareBucket = (field) => {
    const required = filter?.[field]?.$gte;
    const stored = documentValues?.[field];
    if (!stored?.exists || required == null) {
      return {
        enabled: required != null,
        storedExists: Boolean(stored?.exists),
      };
    }

    const storedNumber = Number(stored.numberValue);
    const requiredNumber = Number(required);
    const storedUnits = toMoneyUnits(storedNumber);
    const requiredUnits = toMoneyUnits(requiredNumber);

    return {
      enabled: true,
      stored,
      required: describeMoneyPrecision(required),
      rawMongoWouldMatch: Number.isFinite(storedNumber) && storedNumber >= requiredNumber,
      normalizedUnitsWouldMatch: storedUnits >= requiredUnits,
      unitDelta: storedUnits - requiredUnits,
      numericDeltaPrecision17: (storedNumber - requiredNumber).toPrecision(17),
    };
  };

  return {
    rewardBalance: compareBucket("rewardBalance"),
    depositBalance: compareBucket("depositBalance"),
  };
};
const getNormalizedWithdrawalSourceBreakdown = (user, requestedAmount) => {
  const requestedUnits = toMoneyUnits(requestedAmount);
  const rewardUnitsAvailable = Math.max(0, toMoneyUnits(user?.rewardBalance));
  const depositUnitsAvailable = Math.max(0, toMoneyUnits(user?.depositBalance));
  const rewardUnits = Math.min(rewardUnitsAvailable, requestedUnits);
  const depositUnits = requestedUnits - rewardUnits;

  if (requestedUnits <= 0) {
    return {
      rewardBalance: 0,
      depositBalance: 0,
    };
  }

  if (depositUnits > depositUnitsAvailable) {
    throw new Error("Insufficient Hybrid balance");
  }

  return {
    rewardBalance: fromMoneyUnits(rewardUnits),
    depositBalance: fromMoneyUnits(depositUnits),
  };
};
const normalizeWithdrawalBalanceBuckets = async (user, session = null) => {
  if (!user?._id) {
    return {
      updated: false,
      fields: {},
      before: {
        rewardBalance: describeMoneyPrecision(user?.rewardBalance),
        depositBalance: describeMoneyPrecision(user?.depositBalance),
      },
      after: {
        rewardBalance: describeMoneyPrecision(user?.rewardBalance),
        depositBalance: describeMoneyPrecision(user?.depositBalance),
      },
    };
  }

  const before = {
    rewardBalance: describeMoneyPrecision(user?.rewardBalance),
    depositBalance: describeMoneyPrecision(user?.depositBalance),
  };
  const normalized = {
    rewardBalance: toFixedMoney(user?.rewardBalance),
    depositBalance: toFixedMoney(user?.depositBalance),
  };
  const update = {};

  if (toMoneyNumber(user?.rewardBalance) !== normalized.rewardBalance) {
    update.rewardBalance = normalized.rewardBalance;
  }
  if (toMoneyNumber(user?.depositBalance) !== normalized.depositBalance) {
    update.depositBalance = normalized.depositBalance;
  }

  if (Object.keys(update).length > 0) {
    await User.updateOne({ _id: user._id }, { $set: update }, { session });
  }

  user.rewardBalance = normalized.rewardBalance;
  user.depositBalance = normalized.depositBalance;

  return {
    updated: Object.keys(update).length > 0,
    fields: update,
    before,
    after: {
      rewardBalance: describeMoneyPrecision(normalized.rewardBalance),
      depositBalance: describeMoneyPrecision(normalized.depositBalance),
    },
  };
};
const getAtomicUserDocumentValues = async (userId, session = null) => {
  const options = {
    projection: {
      depositBalance: 1,
      rewardBalance: 1,
      pendingWithdraw: 1,
      lastWithdrawRequest: 1,
      monthlyWithdrawn: 1,
      monthStart: 1,
      adminFraudFlag: 1,
    },
    ...(session ? { session } : {}),
  };
  const rawUser = await User.collection.findOne({ _id: userId }, options);

  return {
    _id: rawUser?._id?.toString?.() ?? String(userId),
    rewardBalance: describeRawMongoValue(rawUser, "rewardBalance"),
    depositBalance: describeRawMongoValue(rawUser, "depositBalance"),
    pendingWithdraw: describeRawMongoValue(rawUser, "pendingWithdraw"),
    lastWithdrawRequest: describeRawMongoValue(rawUser, "lastWithdrawRequest"),
    monthlyWithdrawn: describeRawMongoValue(rawUser, "monthlyWithdrawn"),
    monthStart: describeRawMongoValue(rawUser, "monthStart"),
    adminFraudFlag: describeRawMongoValue(rawUser, "adminFraudFlag"),
  };
};
const traceDeadline = (work, timeoutMs, label) =>
  Promise.race([
    work(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} trace timeout`)), timeoutMs),
    ),
  ]);

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

const getPayoutMutexSnapshot = async () => {
  const redis = getReadyRedis();
  if (!redis) {
    return { available: false, reason: "redis_unavailable" };
  }

  try {
    const payoutKey = getPayoutPrivateKey();
    if (!payoutKey) {
      return { available: true, lockActive: false, reason: "payout_wallet_unconfigured" };
    }
    const payoutWallet = new Wallet(payoutKey).address.toLowerCase();
    const ttlMs = await traceDeadline(
      () => redis.pttl(`hybrid:payout_wallet_lock:${payoutWallet}`),
      250,
      "payout mutex",
    );
    return {
      available: true,
      lockActive: ttlMs > 0,
      ttlMs: ttlMs > 0 ? ttlMs : 0,
      walletPreview: `${payoutWallet.slice(0, 10)}…`,
    };
  } catch (error) {
    return {
      available: false,
      reason: error?.message || "mutex_snapshot_failed",
    };
  }
};

const getActiveWithdrawalSnapshot = async (userId, session = null) => {
  const active = await getActiveHybridWithdrawal(userId, session);
  if (!active) {
    return { active: false };
  }

  return {
    active: true,
    status: active.status,
    payoutStatus: active.payoutStatus || "idle",
    payoutLockedUntil: active.payoutLockedUntil || null,
    grossAmount: Number(active.grossAmount || 0),
    createdAt: active.createdAt || null,
  };
};

const logWithdrawValidationSnapshot = async ({
  phase,
  userId,
  user,
  requestedAmount,
  feeAmount,
  session = null,
  activeWithdrawal = null,
}) => {
  try {
    const [resolvedActiveWithdrawal, payoutMutex] = await Promise.all([
      activeWithdrawal ? Promise.resolve(activeWithdrawal) : getActiveWithdrawalSnapshot(userId, session),
      getPayoutMutexSnapshot(),
    ]);

    logger.debug?.("Hybrid withdraw validation snapshot", {
      phase,
      userId: String(userId),
      spendableBalance: toFixedMoney(getSpendableHybridBalance(user)),
      depositBalance: toFixedMoney(user?.depositBalance),
      rewardBalance: toFixedMoney(user?.rewardBalance),
      requestedAmount: toFixedMoney(requestedAmount),
      feeAmount: toFixedMoney(feeAmount),
      pendingWithdraw: toFixedMoney(user?.pendingWithdraw),
      mutexState: payoutMutex,
      activePayoutState: resolvedActiveWithdrawal,
    });
  } catch (error) {
    logger.debug?.("Hybrid withdraw validation snapshot unavailable", {
      phase,
      userId: String(userId),
      error: error?.message || String(error),
    });
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
  const serviceStartedAt = Date.now();
  const serviceTrace = {};
  const rawAmount = Number(amount || 0);
  const numericAmount = toFixedMoney(rawAmount);
  const normalizedWallet = walletAddress?.trim();
  const rejectWithdrawRequest = (failureBranch, message, details = {}) => {
    serviceTrace.failureBranch = failureBranch;
    serviceTrace.rejectReason = message;
    logger.warn("Hybrid withdraw exact reject branch", {
      userId: String(userId),
      failureBranch,
      requestedAmount: toFixedMoney(numericAmount),
      ...details,
      timings: serviceTrace,
    });
    const error = new Error(message);
    error.failureBranch = failureBranch;
    throw error;
  };

  if (!Number.isFinite(rawAmount) || numericAmount < WITHDRAW_MIN_AMOUNT) {
    rejectWithdrawRequest("minimum_amount", `Minimum withdrawal is ${WITHDRAW_MIN_AMOUNT} USDT`);
  }

  if (!normalizedWallet) {
    rejectWithdrawRequest("missing_wallet", "Valid wallet address required");
  }

  let checksummed;
  try {
    checksummed = getAddress(normalizedWallet);
  } catch {
    rejectWithdrawRequest("invalid_wallet_checksum", "Invalid EVM wallet address");
  }

  if (!isAddress(checksummed)) {
    rejectWithdrawRequest("invalid_wallet_address", "Invalid EVM wallet address");
  }

  const walletLower = checksummed.toLowerCase();
  const withdrawIdempotencyKey = idempotencyKey
    ? `${String(userId)}:${String(idempotencyKey).trim().toLowerCase()}`
    : null;

  if (withdrawIdempotencyKey) {
    const idempotencyStartedAt = Date.now();
    const storedResponse = await getCompletedIdempotency("withdraw", withdrawIdempotencyKey);
    if (storedResponse?.withdrawalId) {
      const withdrawal = await HybridWithdrawal.findById(storedResponse.withdrawalId);
      if (withdrawal) {
        logger.info("Hybrid withdraw idempotency replay", {
          userId: String(userId),
          withdrawalId: String(withdrawal._id),
          totalMs: Date.now() - serviceStartedAt,
        });
        return { withdrawal };
      }
    }

    const previous = await HybridWithdrawal.findOne({ userId, idempotencyKey });
    serviceTrace.idempotencyLookupMs = Date.now() - idempotencyStartedAt;

    if (previous?.idempotencyResponse) {
      return previous.idempotencyResponse.data;
    }
  }

  try {
    return await runMongoTransaction("hybrid.withdraw.request", async (session) => {
      if (withdrawIdempotencyKey) {
        const markStartedAt = Date.now();
        await markIdempotencyProcessing("withdraw", withdrawIdempotencyKey, session);
        serviceTrace.idempotencyMarkMs = Date.now() - markStartedAt;
      }

      const userStartedAt = Date.now();
      const user = await User.findById(userId)
        .select(
          "depositBalance rewardBalance pendingWithdraw level monthlyWithdrawn monthStart lastWithdrawRequest adminFraudFlag createdAt totalInvested"
        )
        .session(session);
      serviceTrace.userQueryMs = Date.now() - userStartedAt;

      if (!user) {
        rejectWithdrawRequest("user_not_found", "User not found");
      }

      const monthlyLimit = getMonthlyLimit(user.level);

      if (monthlyLimit <= 0) {
        rejectWithdrawRequest("level_limit", "Upgrade to level 1 to withdraw");
      }

      const feeAmount = Number((numericAmount * WITHDRAW_FEE_RATE).toFixed(8));
      const netAmount = Number((numericAmount - feeAmount).toFixed(8));
      const availabilityStartedAt = Date.now();
      const availability = await getHybridWithdrawalAvailability({
        userId,
        user,
        session,
        trace: serviceTrace,
      });
      serviceTrace.withdrawalAvailabilityMs = Date.now() - availabilityStartedAt;
      const activeWithdrawal = availability.activeWithdrawal
        ? {
            active: true,
            status: availability.activeWithdrawal.status,
            payoutStatus: availability.activeWithdrawal.payoutStatus,
            payoutLockedUntil: availability.activeWithdrawal.payoutLockedUntil,
            grossAmount: availability.activeWithdrawal.grossAmount,
            createdAt: availability.activeWithdrawal.createdAt,
          }
        : { active: false };

      await logWithdrawValidationSnapshot({
        phase: "precheck",
        userId,
        user,
        requestedAmount: numericAmount,
        feeAmount,
        session,
        activeWithdrawal,
      });

      if (availability.withdrawReason === "pending_withdrawal") {
        rejectWithdrawRequest("pending_withdrawal", "Withdrawal already processing securely", {
          withdrawableUSDT: toFixedMoney(availability.withdrawableUSDT),
          pendingWithdraw: toFixedMoney(user.pendingWithdraw),
          activeWithdrawal,
        });
      }

      if (availability.withdrawReason === "payout_lock") {
        rejectWithdrawRequest("payout_lock", "Pending payout lock active", {
          withdrawableUSDT: toFixedMoney(availability.withdrawableUSDT),
          pendingWithdraw: toFixedMoney(user.pendingWithdraw),
          activeWithdrawal,
        });
      }

      if (user.lastWithdrawRequest) {
        const lastReq = new Date(user.lastWithdrawRequest).getTime();
        if (Number.isFinite(lastReq) && Date.now() - lastReq < WITHDRAW_REQUEST_COOLDOWN_MS) {
          rejectWithdrawRequest("withdraw_cooldown", "Please wait 1 minute before next withdrawal", {
            lastWithdrawRequest: user.lastWithdrawRequest,
          });
        }
      }

      if (availability.withdrawableUSDT + WITHDRAW_BALANCE_EPSILON < numericAmount) {
        rejectWithdrawRequest("insufficient_withdrawable", "Insufficient spendable balance", {
          withdrawableUSDT: toFixedMoney(availability.withdrawableUSDT),
          spendableUSDT: toFixedMoney(availability.spendableUSDT),
          pendingWithdraw: toFixedMoney(user.pendingWithdraw),
          activeWithdrawal,
        });
      }

      const monthWindow = ensureMonthWindow(user);
      const nextMonthlyWithdrawn = toFixedMoney(monthWindow.monthlyWithdrawn + numericAmount);

      if (nextMonthlyWithdrawn > monthlyLimit) {
        rejectWithdrawRequest("monthly_limit", "Monthly withdrawal limit reached", {
          nextMonthlyWithdrawn: toFixedMoney(nextMonthlyWithdrawn),
          monthlyLimit: toFixedMoney(monthlyLimit),
        });
      }

      const preNormalizationDocumentValues = await getAtomicUserDocumentValues(user._id, session);
      const balanceBucketNormalization = await normalizeWithdrawalBalanceBuckets(user, session);
      const postNormalizationDocumentValues = await getAtomicUserDocumentValues(user._id, session);
      serviceTrace.balanceBucketNormalizationApplied = balanceBucketNormalization.updated;
      logger.warn("Hybrid withdraw balance bucket normalization trace", {
        phase: "pre_atomic_bucket_normalization",
        userId: String(userId),
        requestedAmount: describeMoneyPrecision(numericAmount),
        rawMongoValuesBeforeNormalization: preNormalizationDocumentValues,
        normalization: balanceBucketNormalization,
        rawMongoValuesAfterNormalization: postNormalizationDocumentValues,
        sessionActive: Boolean(session?.inTransaction?.()),
      });

      let sourceBreakdown = getNormalizedWithdrawalSourceBreakdown(user, numericAmount);
      const now = new Date();
      const availableAt = new Date(now.getTime() + WITHDRAW_DELAY_MS);
      const autoEligibleAt = new Date(availableAt.getTime() - AUTO_PAYOUT_BEFORE_MS);

      const hourAgo = new Date(Date.now() - MS_HOUR);
      const priorCountStartedAt = Date.now();
      const priorHourCount = await HybridWithdrawal.countDocuments({
        userId,
        createdAt: { $gte: hourAgo },
        status: { $nin: ["rejected"] },
      }).session(session);
      serviceTrace.priorHourCountMs = Date.now() - priorCountStartedAt;
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

      const atomicUpdateStartedAt = Date.now();
      const atomicUserFilter = buildAtomicWithdrawalUserFilter(user._id, sourceBreakdown);
      const atomicUserDocumentValues = await getAtomicUserDocumentValues(user._id, session);
      logger.warn("Hybrid withdraw atomic user update exact filter trace", {
        phase: "initial_atomic_update",
        userId: String(userId),
        requestedAmount: describeMoneyPrecision(numericAmount),
        sourceBreakdown,
        filter: atomicUserFilter,
        filterTyped: describeAtomicWithdrawalFilter(atomicUserFilter),
        actualDocumentValues: atomicUserDocumentValues,
        bucketComparisons: compareAtomicBalanceBuckets(atomicUserDocumentValues, atomicUserFilter),
        sessionActive: Boolean(session?.inTransaction?.()),
        activeWithdrawal,
        idempotencyKeyPresent: Boolean(idempotencyKey),
      });
      let updatedUser = await User.findOneAndUpdate(
        atomicUserFilter,
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
          returnDocument: "after",
          session,
        }
      );
      serviceTrace.atomicUserUpdateMs = Date.now() - atomicUpdateStartedAt;
      serviceTrace.atomicUserUpdateMatched = Boolean(updatedUser);

      if (!updatedUser) {
        const freshUser = await User.findById(userId)
          .select("depositBalance rewardBalance pendingWithdraw")
          .session(session)
          .lean();

        await logWithdrawValidationSnapshot({
          phase: "atomic_update_miss",
          userId,
          user: freshUser || user,
          requestedAmount: numericAmount,
          feeAmount,
          session,
        });

        if (Number(freshUser?.pendingWithdraw || 0) > WITHDRAW_BALANCE_EPSILON) {
          rejectWithdrawRequest("atomic_update_miss_pending_withdraw", "Pending payout lock active", {
            pendingWithdraw: toFixedMoney(freshUser?.pendingWithdraw),
          });
        }
        if (getSpendableHybridBalance(freshUser) + WITHDRAW_BALANCE_EPSILON < numericAmount) {
          rejectWithdrawRequest("atomic_update_miss_insufficient_balance", "Insufficient spendable balance", {
            freshSpendableUSDT: toFixedMoney(getSpendableHybridBalance(freshUser)),
          });
        }

        const retryBalanceBucketNormalization = await normalizeWithdrawalBalanceBuckets(freshUser, session);
        const retrySourceBreakdown = getNormalizedWithdrawalSourceBreakdown(freshUser, numericAmount);
        const atomicRetryStartedAt = Date.now();
        const atomicRetryUserFilter = buildAtomicWithdrawalUserFilter(user._id, retrySourceBreakdown);
        const atomicRetryUserDocumentValues = await getAtomicUserDocumentValues(user._id, session);
        logger.warn("Hybrid withdraw atomic user update exact filter trace", {
          phase: "retry_atomic_update",
          userId: String(userId),
          requestedAmount: describeMoneyPrecision(numericAmount),
          retryBalanceBucketNormalization,
          sourceBreakdown: retrySourceBreakdown,
          filter: atomicRetryUserFilter,
          filterTyped: describeAtomicWithdrawalFilter(atomicRetryUserFilter),
          actualDocumentValues: atomicRetryUserDocumentValues,
          bucketComparisons: compareAtomicBalanceBuckets(atomicRetryUserDocumentValues, atomicRetryUserFilter),
          sessionActive: Boolean(session?.inTransaction?.()),
          activeWithdrawal,
          idempotencyKeyPresent: Boolean(idempotencyKey),
        });
        updatedUser = await User.findOneAndUpdate(
          atomicRetryUserFilter,
          {
            $inc: {
              rewardBalance: -retrySourceBreakdown.rewardBalance,
              depositBalance: -retrySourceBreakdown.depositBalance,
              pendingWithdraw: numericAmount,
            },
            $set: {
              monthStart: monthWindow.monthStart,
              monthlyWithdrawn: nextMonthlyWithdrawn,
              lastWithdrawRequest: now,
            },
          },
          {
            returnDocument: "after",
            session,
          }
        );
        serviceTrace.atomicUserUpdateRetryMs = Date.now() - atomicRetryStartedAt;
        serviceTrace.atomicUserUpdateRetryMatched = Boolean(updatedUser);

        if (!updatedUser) {
          rejectWithdrawRequest("atomic_update_miss_after_resync", "Balance refresh required", {
            freshSpendableUSDT: toFixedMoney(getSpendableHybridBalance(freshUser)),
            retrySourceBreakdown,
          });
        }

        logger.warn("Hybrid withdraw atomic update recovered after balance resync", {
          userId: String(userId),
          requestedAmount: toFixedMoney(numericAmount),
          originalSourceBreakdown: sourceBreakdown,
          retrySourceBreakdown,
          freshSpendableUSDT: toFixedMoney(getSpendableHybridBalance(freshUser)),
          pendingWithdraw: toFixedMoney(freshUser?.pendingWithdraw),
        });
        sourceBreakdown = retrySourceBreakdown;
      }

      const createStartedAt = Date.now();
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
      serviceTrace.withdrawalCreateMs = Date.now() - createStartedAt;

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

      const ledgerStartedAt = Date.now();
      await addHybridLedgerEntries(ledgerEntries, session);
      serviceTrace.ledgerWriteMs = Date.now() - ledgerStartedAt;

      const result = {
        withdrawal,
      };

      if (idempotencyKey) {
        const completeStartedAt = Date.now();
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
        serviceTrace.idempotencyCompleteMs = Date.now() - completeStartedAt;
      }

      logger.info("Hybrid withdraw validation runtime trace", {
        userId: String(userId),
        withdrawalId: String(withdrawal._id),
        totalMs: Date.now() - serviceStartedAt,
        timings: serviceTrace,
        requestedAmount: toFixedMoney(numericAmount),
        feeAmount: toFixedMoney(feeAmount),
        withdrawableUSDT: toFixedMoney(availability.withdrawableUSDT),
        pendingWithdrawBefore: toFixedMoney(user.pendingWithdraw),
        canWithdraw: availability.canWithdraw,
        withdrawReason: availability.withdrawReason,
        activeWithdrawal,
        redisPayoutMutex: "captured in validation snapshot",
        mongoAtomicUpdateMatched: Boolean(updatedUser),
        ledgerWriteSuccess: true,
        payoutQueueEnqueueSuccess: "not_applicable_request_route_no_bullmq_enqueue",
      });

      return result;
    });
  } catch (error) {
    if (withdrawIdempotencyKey) {
      await failIdempotency("withdraw", withdrawIdempotencyKey, error);
    }
    logger.warn("Hybrid withdraw validation failed runtime trace", {
      userId: String(userId),
      totalMs: Date.now() - serviceStartedAt,
      timings: serviceTrace,
      requestedAmount: toFixedMoney(numericAmount),
      failureBranch: error?.failureBranch || serviceTrace.failureBranch || "runtime_exception",
      reason: error?.message || String(error),
    });
    const wrapped = new Error(error.message || "Failed to request withdrawal");
    wrapped.failureBranch = error?.failureBranch || serviceTrace.failureBranch || "runtime_exception";
    throw wrapped;
  }
};

/**
 * User "claim" is now a lock-window readiness check only.
 * Strict financial states stay pending → approved → paid or pending → rejected.
 */
export const claimHybridWithdrawal = async (userId, withdrawalId) => {
  try {
    return await runMongoTransaction("hybrid.withdraw.claim", async (session) => {
      const withdrawal = await HybridWithdrawal.findOne({
        _id: withdrawalId,
        userId,
      }).session(session);

      if (!withdrawal) {
        throw new Error("Withdrawal not found");
      }

      if (withdrawal.status === "approved" || withdrawal.status === "paid") {
        return {
          withdrawalId: withdrawal._id,
          status: withdrawal.status,
          netAmount: Number(withdrawal.netAmount || 0),
          feeAmount: Number(withdrawal.feeAmount || 0),
        };
      }

      if (withdrawal.status !== "pending") {
        throw new Error("Withdrawal cannot be claimed in its current state");
      }

      if (new Date(withdrawal.availableAt).getTime() > Date.now()) {
        throw new Error("Withdrawal is still locked for 96 hours");
      }

      return {
        withdrawalId: withdrawal._id,
        status: withdrawal.status,
        netAmount: Number(withdrawal.netAmount || 0),
        feeAmount: Number(withdrawal.feeAmount || 0),
      };
    });
  } catch (error) {
    throw new Error(error.message || "Failed to claim withdrawal");
  }
};

export const getHybridWithdrawals = async (userId) =>
  HybridWithdrawal.find({ userId }).sort({ createdAt: -1 }).limit(50).lean();

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
        returnDocument: "after",
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
      { returnDocument: "after" }
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
      { returnDocument: "after" }
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
  logger.info("Hybrid payout execution started", {
    withdrawalId: withdrawalId ? String(withdrawalId) : null,
  });
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
      logger.debug?.("Hybrid payout execution found no eligible approved withdrawal", {
        withdrawalId: withdrawalId ? String(withdrawalId) : null,
      });
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
    logger.error("Hybrid auto payout executor disabled by missing runtime config", {
      hasPayoutPrivateKey: Boolean(getPayoutPrivateKey()),
      hasUsdtContract: Boolean(hybridConfig.usdtContract),
    });
    return { enabled: false, processed: 0, failed: 0, observability: payoutObservabilitySnapshot() };
  }

  logger.info("Hybrid auto payout executor batch started", {
    limit: Math.max(1, Number(limit) || 1),
  });

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

  const summary = {
    enabled: true,
    processed,
    failed,
    observability: payoutObservabilitySnapshot(),
  };
  logger.info("Hybrid auto payout executor batch finished", summary);
  return summary;
};

/** Legacy hook retained for engine scheduling; hybrid withdrawals auto-approve via executor batch. */
export const autoMarkClaimable = async () => {
  return { modifiedCount: 0 };
};

export const adminApproveHybridWithdrawal = async (withdrawalId, adminId = null) => {
  if (!withdrawalId) {
    throw adminClientError("Withdrawal ID required");
  }

  try {
    return await runMongoTransaction("hybrid.withdraw.adminApprove", async (session) => {
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
        { returnDocument: "after", session }
      );

      if (!updated) {
        throw adminClientError("Unable to approve withdrawal");
      }

      return updated;
    });
  } catch (error) {
    throw wrapAdminClientError(error, "Failed to approve withdrawal");
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

  let updated = null;

  try {
    updated = await runMongoTransaction("hybrid.withdraw.adminForcePayout", async (session) => {
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

        const approved = await HybridWithdrawal.findOneAndUpdate(
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
          { returnDocument: "after", session }
        );

        if (!approved) {
          throw adminClientError("Unable to force-approve withdrawal");
        }
        return approved;
      } else if (withdrawal.status === "approved") {
        const forced = await HybridWithdrawal.findOneAndUpdate(
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
          { returnDocument: "after", session }
        );

        if (!forced) {
          throw adminClientError("Unable to update withdrawal for force payout");
        }
        return forced;
      }

      throw adminClientError("Invalid state for force payout", 400);
    });
  } catch (error) {
    throw wrapAdminClientError(error, "Failed to force payout");
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

  try {
    return await runMongoTransaction("hybrid.withdraw.markPaid", async (session) => {
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
      { returnDocument: "after", session }
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
      { returnDocument: "after", session }
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

      return { withdrawal: paid, txHash: normalized };
    });
  } catch (error) {
    const code = error?.code ?? error?.cause?.code;
    const isDupTx =
      code === 11000 ||
      /E11000/i.test(String(error?.message || "")) ||
      /duplicate key/i.test(String(error?.message || ""));
    if (isDupTx) {
      throw adminClientError("Transaction hash already used");
    }
    throw wrapAdminClientError(error, "Failed to mark withdrawal paid");
  }
};

export const adminMarkHybridWithdrawalPaid = async () => {
  throw adminClientError("Manual mark-paid is disabled. Approved withdrawals are paid by the auto executor.", 410);
};

export const adminRejectHybridWithdrawal = async (withdrawalId) => {
  if (!withdrawalId) {
    throw adminClientError("Withdrawal ID required");
  }

  try {
    return await runMongoTransaction("hybrid.withdraw.adminReject", async (session) => {
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
      { returnDocument: "after", session }
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
      { returnDocument: "after", session }
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
      return updatedWithdrawal;
    });
  } catch (error) {
    logger.error("Hybrid withdraw reject failed", { error: error?.message || error });
    throw wrapAdminClientError(error, "Failed to reject withdrawal");
  }
};

/**
 * Reject every unpaid hybrid withdrawal in the admin queue (pending/review/claimable) plus
 * approved-but-unpaid rows, excluding payouts that are actively sending/verifying.
 * One MongoDB transaction — all-or-nothing; mirrors {@link adminRejectHybridWithdrawal} per row.
 */
export const adminRejectAllHybridWithdrawals = async (adminId) => {
  try {
    return await runMongoTransaction("hybrid.withdraw.adminRejectAll", async (session) => {
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
        { returnDocument: "after", session }
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
        { returnDocument: "after", session }
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

      logger.info("Hybrid withdraw bulk reject-all completed", {
        totalRejected,
        adminId: String(adminId || ""),
      });
      return { totalRejected };
    });
  } catch (error) {
    logger.error("Hybrid withdraw bulk reject-all failed", { error: error?.message || error });
    throw wrapAdminClientError(error, "Failed to reject all withdrawals");
  }
};
