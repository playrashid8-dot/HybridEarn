import mongoose from "mongoose";

const walletCounterSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    value: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

const WalletCounter =
  mongoose.models.WalletCounter ||
  mongoose.model("WalletCounter", walletCounterSchema);

export default WalletCounter;
