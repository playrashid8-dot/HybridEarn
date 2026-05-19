import mongoose from "mongoose";

const adminFinancialCreditLimitSchema = new mongoose.Schema(
  {
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    dayKey: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    amountUsed: {
      type: Number,
      default: 0,
      min: 0,
    },
    count: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

adminFinancialCreditLimitSchema.index(
  { adminId: 1, dayKey: 1 },
  { unique: true, name: "uniq_admin_financial_credit_limit_day" }
);

const AdminFinancialCreditLimit =
  mongoose.models.AdminFinancialCreditLimit ||
  mongoose.model("AdminFinancialCreditLimit", adminFinancialCreditLimitSchema);

export default AdminFinancialCreditLimit;
