import mongoose from "mongoose";

const energyRowSchema = new mongoose.Schema(
  {
    feederId: { type: Number, required: true },
    feederName: { type: String, default: "", trim: true },
    meterOwner: { type: String, default: "", trim: true },
    category: { type: String, default: "", trim: true },
    kwh: { type: Number, default: null },
    kvarh: { type: Number, default: null },
    avgPf: { type: Number, default: null },
    hasPeakOffPeak: { type: Boolean, default: false },
    peakKwh: { type: Number, default: null },
    offPeakKwh: { type: Number, default: null },
    peakKvarh: { type: Number, default: null },
    offPeakKvarh: { type: Number, default: null },
    maxLoadMw: { type: Number, default: null },
    maxLoadDate: { type: String, default: "", trim: true },
    maxLoadTime: { type: String, default: "", trim: true },
    interruptionCount: { type: Number, default: null },
    interruptionMinutes: { type: Number, default: null },
    totalLsMinutes: { type: Number, default: null },
    rowColor: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const monthlyEnergySchema = new mongoose.Schema(
  {
    year: { type: Number, required: true },
    month: { type: Number, required: true },
    stationName: { type: String, default: "Bottail SS", trim: true },
    rows: { type: [energyRowSchema], default: [] },
    notes: { type: String, default: "", trim: true },
    updatedByUsername: { type: String, default: "", trim: true },
    updatedByDisplayName: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

monthlyEnergySchema.index({ year: 1, month: 1 }, { unique: true });

const MonthlyEnergyReading: mongoose.Model<any> =
  mongoose.models.MonthlyEnergyReading ||
  mongoose.model("MonthlyEnergyReading", monthlyEnergySchema);

export default MonthlyEnergyReading;
