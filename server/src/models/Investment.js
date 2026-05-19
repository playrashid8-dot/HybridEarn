import mongoose from "mongoose";

const investmentSchema = new mongoose.Schema(
  {
    // 🔗 USER
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true, // ✅ keep (used in compound index)
    },

    // 💰 AMOUNT
    amount: {
      type: Number,
      required: true,
      min: 10,
    },

    // 📊 DAILY ROI (%)
    dailyROI: {
      type: Number,
      required: true,
      min: 0,
    },

    // ⏳ DURATION (days)
    duration: {
      type: Number,
      required: true,
      min: 1,
    },

    // 💰 TOTAL EARNED
    totalEarned: {
      type: Number,
      default: 0,
      min: 0,
    },

    // 📅 START / END
    startDate: {
      type: Date,
      default: Date.now,
    },

    endDate: {
      type: Date,
      required: true,
      // ❌ removed index: true (duplicate fix)
    },

    // ⏱ LAST ROI CLAIM
    lastClaim: {
      type: Date,
      default: null,
    },

    // 📊 DAYS COUNT (ANTI-BUG)
    daysClaimed: {
      type: Number,
      default: 0,
      min: 0,
    },

    // 🔥 STATUS
    status: {
      type: String,
      enum: ["active", "completed"],
      default: "active",
      index: true,
    },
  },
  { timestamps: true }
);

//
// 🔥 INDEXES (CLEAN)
//
investmentSchema.index({ userId: 1, status: 1 }); // user queries
investmentSchema.index({ endDate: 1 }); // expiry check

//
// 🔥 SAFE JSON
//
investmentSchema.methods.toJSON = function () {
  return this.toObject();
};

export default mongoose.model("Investment", investmentSchema);