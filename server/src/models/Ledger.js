import mongoose from "mongoose";

const ledgerSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["credit", "debit"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    balanceBefore: {
      type: Number,
      required: true,
      min: 0,
    },
    balanceAfter: {
      type: Number,
      required: true,
      min: 0,
    },
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    referenceType: {
      type: String,
      enum: ["deposit", "withdrawal"],
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

ledgerSchema.index({ userId: 1, createdAt: -1 });
ledgerSchema.index(
  { referenceType: 1, referenceId: 1, type: 1 },
  { unique: true }
);

["updateOne", "findOneAndUpdate", "updateMany"].forEach((hook) => {
  ledgerSchema.pre(hook, function () {
    throw new Error("Ledger entries are immutable");
  });
});

ledgerSchema.pre("save", function () {});

const Ledger =
  mongoose.models.Ledger || mongoose.model("Ledger", ledgerSchema);

export default Ledger;
