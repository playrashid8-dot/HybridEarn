import mongoose from "mongoose";

const hybridLedgerSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    entryType: {
      type: String,
      enum: ["credit", "debit"],
      required: true,
    },
    balanceType: {
      type: String,
      enum: ["balance", "depositBalance", "rewardBalance", "pendingWithdraw"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.000001,
    },
    source: {
      type: String,
      required: true,
      trim: true,
    },
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

function rejectHybridLedgerMutation(next) {
  next(new Error("HybridLedger entries are immutable"));
}

[
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "findByIdAndUpdate",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
  "findByIdAndDelete",
].forEach((hook) => {
  hybridLedgerSchema.pre(hook, rejectHybridLedgerMutation);
});

hybridLedgerSchema.index({ userId: 1, createdAt: -1 });
hybridLedgerSchema.index(
  { source: 1, "meta.depositTxHash": 1 },
  { sparse: true }
);
hybridLedgerSchema.index(
  { source: 1, "meta.roiClaimLedgerId": 1 },
  { sparse: true }
);

hybridLedgerSchema.index(
  { source: 1, "meta.fromUserId": 1 },
  { sparse: true }
);

hybridLedgerSchema.index(
  { "meta.txHash": 1 },
  { sparse: true }
);

hybridLedgerSchema.index(
  { source: 1, entryType: 1, "meta.txHash": 1 },
  {
    name: "hybrid_dep_credit_txhash_lookup",
    sparse: true,
    partialFilterExpression: {
      source: "hybrid_deposit",
      entryType: "credit",
      "meta.txHash": { $type: "string" },
    },
  }
);

/** Idempotency: at most one first-deposit bonus paid per depositor globally. */
hybridLedgerSchema.index(
  { source: 1, "meta.fromUserId": 1 },
  {
    unique: true,
    partialFilterExpression: { source: "first_deposit_bonus" },
    name: "uniq_first_deposit_bonus_from_user",
  }
);

/** At most one ledger credit per user per salary stage (pairs with claim CAS in salaryService). */
hybridLedgerSchema.index(
  { userId: 1, source: 1, "meta.stage": 1 },
  {
    unique: true,
    partialFilterExpression: { source: "salary_claim" },
    name: "uniq_salary_claim_user_stage",
  }
);

/** Replay guard for admin-created reward credits. */
hybridLedgerSchema.index(
  { source: 1, "meta.idempotencyKey": 1 },
  {
    unique: true,
    partialFilterExpression: {
      source: "admin_credit",
      "meta.idempotencyKey": { $type: "string" },
    },
    name: "uniq_admin_credit_idempotency_key",
  }
);

/** Replay guard for internal admin credits that behave as active USDT. */
hybridLedgerSchema.index(
  { source: 1, "meta.idempotencyKey": 1 },
  {
    unique: true,
    partialFilterExpression: {
      source: "internal_admin_credit",
      "meta.idempotencyKey": { $type: "string" },
    },
    name: "uniq_internal_admin_credit_idempotency_key",
  }
);

const HybridLedger =
  mongoose.models.HybridLedger ||
  mongoose.model("HybridLedger", hybridLedgerSchema);

export default HybridLedger;
