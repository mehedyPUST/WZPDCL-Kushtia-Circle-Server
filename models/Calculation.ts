// backend/models/Calculation.js
const mongoose = require("mongoose");

const feederSchema = new mongoose.Schema(
  {
    id: { type: Number, required: true },
    name: { type: String, required: true },
    bus: { type: Number, required: true },
    amps: { type: Number, default: 0 },
    mw: { type: Number, default: 0 },
    /** Actual load-shed applied on this feeder (MW) for the slot */
    lsMW: { type: Number, default: 0 },
    ringActive: { type: Boolean, default: false },
  },
  { _id: false }
);

const calculationSchema = new mongoose.Schema(
  {
    busVoltages: {
      bus1: { type: Number, required: true },
      bus2: { type: Number, required: true },
    },
    feeders: [feederSchema],
    bottail11kV: { type: Number, default: 0 },
    totalMW: { type: Number, default: 0 },
    /** Grid allotment for this slot (MW). null/undefined = unlimited */
    allotment: { type: Number, default: null },
    calculatedAt: { type: Date, default: Date.now },
    /** e.g. "14:00" or "18:30" — set for hourly / special-slot saves */
    hourSlot: { type: String, default: null },
    /** true when saved via "Calculate & Save for this hour" */
    isHourly: { type: Boolean, default: false },
    note: { type: String, default: "" },
    hasActiveRing: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
    /** Denormalized for list UI without populate */
    createdByUsername: { type: String, default: "" },
    updatedByUsername: { type: String, default: "" },
  },
  { timestamps: true }
);

// Indexes
calculationSchema.index({ deletedAt: 1, createdAt: -1 });
calculationSchema.index({ deletedAt: 1 });
calculationSchema.index({ createdBy: 1 });
calculationSchema.index({ deletedAt: 1, isHourly: 1, calculatedAt: -1 });
calculationSchema.index({ deletedAt: 1, hasActiveRing: 1, calculatedAt: -1 });

module.exports = mongoose.model("Calculation", calculationSchema);