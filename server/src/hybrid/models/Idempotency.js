import mongoose from "mongoose";

const idempotencySchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    type: {
      type: String,
      enum: ["deposit", "withdraw", "payout"],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["processing", "completed", "failed"],
      default: "processing",
      index: true,
    },
    response: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    lastError: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
  },
  {
    timestamps: true,
    collection: "idempotencies",
  }
);

idempotencySchema.index({ key: 1, type: 1 }, { unique: true });
idempotencySchema.index({ type: 1, status: 1, updatedAt: 1 });

const Idempotency =
  mongoose.models.Idempotency ||
  mongoose.model("Idempotency", idempotencySchema);

export default Idempotency;
