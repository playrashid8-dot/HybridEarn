import mongoose from "mongoose";

const hybridStakeSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    planDays: {
      type: Number,
      required: true,
      enum: [7, 15, 30, 60],
    },
    dailyRate: {
      type: Number,
      required: true,
      min: 0,
    },
    totalReward: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: ["active", "claimed"],
      default: "active",
      index: true,
    },
    startAt: {
      type: Date,
      required: true,
    },
    endAt: {
      type: Date,
      required: true,
      index: true,
    },
    claimedAt: {
      type: Date,
      default: null,
    },
    sourceBreakdown: {
      rewardBalance: {
        type: Number,
        default: 0,
        min: 0,
      },
      depositBalance: {
        type: Number,
        default: 0,
        min: 0,
      },
    },
  },
  {
    timestamps: true,
  }
);

hybridStakeSchema.index({ userId: 1, status: 1, createdAt: -1 });

const HybridStake =
  mongoose.models.HybridStake ||
  mongoose.model("HybridStake", hybridStakeSchema);

export default HybridStake;
