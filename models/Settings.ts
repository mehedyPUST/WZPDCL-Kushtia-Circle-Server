const mongoose = require("mongoose");

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
    /** Station branding */
    stationName: { type: String, default: "Bottail SS" },
    stationOrg: { type: String, default: "WZPDCL" },
    /** Default bus voltages for calculator (kV) */
    defaultBus1Kv: { type: Number, default: 33 },
    defaultBus2Kv: { type: Number, default: 33 },
    /** Soft guidance ceilings used in night-log voltage logic */
    bus1MaxKv: { type: Number, default: 36 },
    bus2MaxKv: { type: Number, default: 35.6 },
    /** Days soft-deleted history is kept before purge */
    trashRetentionDays: { type: Number, default: 30 },
    /** Circle load: night/rest slots editable until circleRelaxUntil same day */
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
    /** HH:mm Dhaka — relaxed slots stay open until this time */
    circleRelaxUntil: { type: String, default: "12:00" },
    /**
     * Kushtia district operational day boundary (HH:mm Dhaka).
     * District day labelled as date D runs from (D-1) boundary → D boundary (inclusive).
     * Default 22:00 → previous day 22:00 through today 22:00.
     */
    districtDayBoundary: { type: String, default: "22:00" },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.Settings || mongoose.model("Settings", settingsSchema);
