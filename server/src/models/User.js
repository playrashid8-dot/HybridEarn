import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    // 🔐 AUTH
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 20,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, "Invalid email"],
    },

    password: {
      type: String,
      required: true,
      select: false,
    },
    number: {
      type: String,
      default: "",
      trim: true,
    },

    // 💰 WALLET
    balance: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalInvested: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalWithdraw: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalEarnings: {
      type: Number,
      default: 0,
      min: 0,
    },

    todayProfit: {
      type: Number,
      default: 0,
      min: 0,
    },

    // 💎 VIP SYSTEM
    vipLevel: {
      type: Number,
      default: 0,
      min: 0,
    },

    vipEarnings: {
      type: Number,
      default: 0,
      min: 0,
    },

    claimedVIP: {
      type: [Number],
      default: [],
    },

    // 👥 REFERRAL SYSTEM
    referralCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
    },

    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    directCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    referralEarnings: {
      type: Number,
      default: 0,
      min: 0,
    },

    teamCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    teamVolume: {
      type: Number,
      default: 0,
      min: 0,
    },

    referrer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // 📍 WALLET ADDRESS (stored lowercase for on-chain Transfer `to` matching)
    // Migration cleanup before creating the production index:
    // db.users.updateMany({ walletAddress: "" }, { $unset: { walletAddress: "" } });
    // Create the Mongo index manually; do not rely on Mongoose for this field:
    // db.users.createIndex(
    //   { walletAddress: 1 },
    //   { unique: true, partialFilterExpression: { walletAddress: { $type: "string" } } }
    // );
    walletAddress: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
    },

    privateKey: {
      type: String,
      default: "",
      select: false,
    },

    depositBalance: {
      type: Number,
      default: 0,
      min: 0,
    },

    rewardBalance: {
      type: Number,
      default: 0,
      min: 0,
    },

    trialBalance: {
      type: Number,
      default: 0,
      min: 0,
    },

    trialStartAt: {
      type: Date,
      default: null,
    },

    trialExpiresAt: {
      type: Date,
      default: null,
    },

    isTrialActive: {
      type: Boolean,
      default: false,
      index: true,
    },

    /** Legacy: optional signup metadata from retired trial program (not written for new users). */
    trialSourceIp: {
      type: String,
      default: null,
      trim: true,
      index: true,
      sparse: true,
    },

    hasQualifiedDeposit: {
      type: Boolean,
      default: false,
      index: true,
    },

    level: {
      type: Number,
      default: 0,
      min: 0,
    },

    salaryDirectCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    salaryTeamCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    salaryStage: {
      type: Number,
      default: 0,
      min: 0,
    },

    claimedSalaryStages: {
      type: [Number],
      default: [],
    },

    salaryProgress: {
      lastClaimedStage: {
        type: Number,
        default: 0,
        min: 0,
      },
      lastClaimedAt: {
        type: Date,
        default: null,
      },
    },

    salaryHistory: {
      type: [
        {
          stage: { type: Number, min: 1 },
          amount: { type: Number, min: 0 },
          claimedAt: { type: Date },
        },
      ],
      default: [],
      validate: {
        validator(arr) {
          return !Array.isArray(arr) || arr.length <= 20;
        },
        message: "Max 20 salary history records",
      },
    },

    levelBonusStage: {
      type: Number,
      default: 0,
      min: 0,
    },

    lastDailyClaim: {
      type: Date,
      default: null,
    },

    pendingWithdraw: {
      type: Number,
      default: 0,
      min: 0,
    },

    lastWithdrawRequest: {
      type: Date,
      default: null,
    },

    monthlyWithdrawn: {
      type: Number,
      default: 0,
      min: 0,
    },

    monthStart: {
      type: Date,
      default: null,
    },

    /** Admin-only review flags (does not alter earn / withdraw logic) */
    adminFraudFlag: {
      type: Boolean,
      default: false,
      index: true,
    },
    adminFraudReason: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },

    // 🔐 SECURITY
    isAdmin: {
      type: Boolean,
      default: false,
      index: true,
    },

    isBlocked: {
      type: Boolean,
      default: false,
    },

    lastLogin: {
      type: Date,
      default: null,
    },
    lastWithdrawalAt: {
      type: Date,
      default: null,
    },

    /** HybridEarn: no withdrawals until this time (UTC), extended on each deposit credit. */
    withdrawLockUntil: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

//
// 🔥 SAFE RESPONSE
//
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.privateKey;
  return obj;
};

//
// 🔥 INDEXES (NO DUPLICATE)
//
userSchema.index({ createdAt: -1 });
userSchema.index({ referredBy: 1, createdAt: -1 });
userSchema.index(
  { walletAddress: 1 },
  {
    unique: true,
    partialFilterExpression: { walletAddress: { $type: "string" } },
  }
);

export default mongoose.model("User", userSchema);