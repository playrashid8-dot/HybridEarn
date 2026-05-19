import mongoose from "mongoose";

const hybridDepositSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
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
      required: true,
      min: 0.000001,
    },
    txHash: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    blockNumber: {
      type: Number,
      default: null,
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
    status: {
      type: String,
      enum: ["detected", "credited", "swept", "failed"],
      default: "detected",
      index: true,
    },
    /** Set true only after an on-chain sweep is confirmed and written (idempotency). */
    sweeped: {
      type: Boolean,
      default: false,
      index: true,
    },
    sweepTxHash: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },
    errorMessage: {
      type: String,
      default: "",
      trim: true,
      maxlength: 300,
    },
  },
  {
    timestamps: true,
  }
);

hybridDepositSchema.index({ userId: 1, createdAt: -1 });
hybridDepositSchema.index({ walletAddress: 1, createdAt: -1 });
hybridDepositSchema.index({ status: 1, sweeped: 1, createdAt: 1 });

const HybridDeposit =
  mongoose.models.HybridDeposit ||
  mongoose.model("HybridDeposit", hybridDepositSchema);

export default HybridDeposit;
