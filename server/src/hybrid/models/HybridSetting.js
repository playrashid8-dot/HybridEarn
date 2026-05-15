import mongoose from "mongoose";

const hybridSettingSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    value: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const HybridSetting =
  mongoose.models.HybridSetting ||
  mongoose.model("HybridSetting", hybridSettingSchema);

export default HybridSetting;
