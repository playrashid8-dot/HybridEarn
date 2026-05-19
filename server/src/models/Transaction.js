import mongoose from "mongoose";

const transactionSchema = new mongoose.Schema(
  {
    // 👤 USER
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // 🔁 TYPE
    type: {
      type: String,
      enum: ["deposit", "withdraw", "investment"],
      required: true,
    },

    // 💰 AMOUNT
    amount: {
      type: Number,
      required: true,
    },

    // 📌 STATUS
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },

    // 🔗 LINK (Deposit / Withdraw / Investment ID)
    refId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    // 📝 OPTIONAL NOTE (future use)
    note: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

transactionSchema.index(
  { type: 1, refId: 1 },
  {
    unique: true,
    partialFilterExpression: { refId: { $type: "objectId" } },
  }
);

// ❌ duplicate model error fix (important for dev)
const Transaction =
  mongoose.models.Transaction ||
  mongoose.model("Transaction", transactionSchema);

export default Transaction;