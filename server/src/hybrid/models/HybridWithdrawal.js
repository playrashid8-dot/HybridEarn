import mongoose from "mongoose";

const hybridWithdrawalSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    grossAmount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    feeAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    netAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    walletAddress: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["review", "pending", "claimable", "claimed", "approved", "paid", "rejected"],
      default: "pending",
      index: true,
    },
    /** When true, status should be "review" — admin visibility / queue only; does not change amounts. */
    isSuspicious: {
      type: Boolean,
      default: false,
      index: true,
    },
    /** Fraud queue ordering: "high" when suspicious; otherwise "normal". */
    priority: {
      type: String,
      enum: ["high", "normal"],
      default: "normal",
      index: true,
    },
    /** Heuristic 0+; higher = more concerning. Set at request time only. */
    riskScore: {
      type: Number,
      default: 0,
      min: 0,
      index: true,
    },
    txHash: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
    },
    sourceRewardAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    sourceDepositAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    paidAt: {
      type: Date,
      default: null,
    },
    payoutNonce: {
      type: Number,
      index: true,
    },
    payoutWallet: {
      type: String,
      trim: true,
      lowercase: true,
      index: true,
    },
    payoutStartedAt: {
      type: Date,
      default: null,
    },
    payoutStatus: {
      type: String,
      /** `blocked`: dead-letter after max payout attempts — requires manual unblock/reject/retry. */
      enum: ["idle", "sending", "verifying", "failed", "blocked"],
      default: "idle",
      index: true,
    },
    payoutLockedUntil: {
      type: Date,
      default: null,
      index: true,
    },
    payoutAttemptCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    payoutLastError: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
    /** When true, payout executor may send before normal lock / auto window (admin force). */
    forcePayout: {
      type: Boolean,
      default: false,
      index: true,
    },
    /** Payout batch may process (with approval) from this time — typically 10h before availableAt. */
    autoEligibleAt: {
      type: Date,
      default: null,
      index: true,
    },
    availableAt: {
      type: Date,
      required: true,
      index: true,
    },
    requestedAt: {
      type: Date,
      required: true,
    },
    claimedAt: {
      type: Date,
      default: null,
    },
    monthKey: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    idempotencyKey: {
      type: String,
      default: null,
      trim: true,
    },
    idempotencyResponse: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const TXHASH_PARTIAL = { txHash: { $type: "string" } };

/** Uniqueness for documents that store a tx hash string (unset field = no index entry; fixes null collisions) */
hybridWithdrawalSchema.index(
  { txHash: 1 },
  {
    unique: true,
    partialFilterExpression: TXHASH_PARTIAL,
  }
);

hybridWithdrawalSchema.index({ userId: 1, createdAt: -1 });
hybridWithdrawalSchema.index({ status: 1, createdAt: -1 });
hybridWithdrawalSchema.index({ status: 1, payoutLockedUntil: 1, approvedAt: 1 });
hybridWithdrawalSchema.index({ status: 1, paidAt: 1, autoEligibleAt: 1, availableAt: 1 });
/** Admin queues: priority asc so "high" before "normal", then highest risk & newest first. */
hybridWithdrawalSchema.index({ priority: 1, riskScore: -1, createdAt: -1 });
hybridWithdrawalSchema.index(
  { userId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
  }
);

const HybridWithdrawal =
  mongoose.models.HybridWithdrawal ||
  mongoose.model("HybridWithdrawal", hybridWithdrawalSchema);

export default HybridWithdrawal;
