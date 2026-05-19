import mongoose from "mongoose";

const pendingDepositSchema = new mongoose.Schema(
  {
    txHash: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    walletAddress: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    amount: {
      type: Number,
      default: null,
      min: 0,
    },
    blockNumber: {
      type: Number,
      default: null,
      index: true,
    },
    fromAddress: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },
    tokenAddress: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },
    serializedLog: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    status: {
      type: String,
      enum: ["pending", "credited", "failed"],
      default: "pending",
      index: true,
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastError: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
    nextRetryAt: {
      type: Date,
      default: () => new Date(),
      index: true,
    },
    creditedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true, collection: "pendingDeposits" }
);

pendingDepositSchema.index({ status: 1, nextRetryAt: 1, createdAt: 1 });

const PendingDeposit =
  mongoose.models.PendingDeposit ||
  mongoose.model("PendingDeposit", pendingDepositSchema);

export default PendingDeposit;
