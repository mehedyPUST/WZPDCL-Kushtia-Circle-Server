import mongoose from "mongoose";

const settingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: "app",
    },
    maxLoadRingMode: {
      type: String,
      enum: ["with", "without"],
      default: "with",
    },
    calculatorRingActive: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    stationName: { type: String, default: "Bottail SS" },
    stationOrg: { type: String, default: "WZPDCL" },
    defaultBus1Kv: { type: Number, default: 33 },
    defaultBus2Kv: { type: Number, default: 33 },
    bus1MaxKv: { type: Number, default: 36 },
    bus2MaxKv: { type: Number, default: 35.6 },
    trashRetentionDays: { type: Number, default: 30 },
    circleRelaxedSlots: {
      type: [String],
      default: [
        "01:00",
        "02:00",
        "03:00",
        "04:00",
        "05:00",
        "06:00",
        "07:00",
        "08:00",
      ],
    },
    circleRelaxUntil: { type: String, default: "12:00" },
    districtDayBoundary: { type: String, default: "22:00" },
    nightLogStartSlot: { type: String, default: "00:00" },
    nightLogEndSlot: { type: String, default: "08:00" },
    nightLogUseAi: { type: Boolean, default: true },
    energyFeeders: {
      type: [
        {
          feederId: { type: Number, required: true },
          feederName: { type: String, default: "", trim: true },
          category: { type: String, default: "33kv", trim: true },
          meterOwners: { type: [String], default: ["PDB", "WZPDCL"] },
          hasPeakOffPeak: { type: Boolean, default: false },
          custom: { type: Boolean, default: true },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

const Settings: mongoose.Model<any> =
  mongoose.models.Settings || mongoose.model("Settings", settingsSchema);

export default Settings;
