import mongoose from "mongoose";

const hybridDepositTxLockSchema = new mongoose.Schema(
  {
    txHash: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 80,
      index: true,
    },
    lockedUntil: {
      type: Date,
      required: true,
      index: true,
    },
    holderPid: {
      type: Number,
      default: null,
    },
  },
  { timestamps: { createdAt: true, updatedAt: true }, versionKey: false }
);

const HybridDepositTxLock =
  mongoose.models.HybridDepositTxLock ||
  mongoose.model("HybridDepositTxLock", hybridDepositTxLockSchema);

export default HybridDepositTxLock;
