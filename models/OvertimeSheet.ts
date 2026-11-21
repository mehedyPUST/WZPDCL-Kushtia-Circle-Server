import mongoose from "mongoose";

const extraDutyEntrySchema = new mongoose.Schema(
  {
    date: { type: String, required: true, trim: true },
    normalFrom: { type: String, default: "", trim: true },
    normalTo: { type: String, default: "", trim: true },
    dutyFrom: { type: String, default: "22:00", trim: true },
    dutyTo: { type: String, default: "06:00", trim: true },
    purpose: {
      type: String,
      default: "সাপ্তাহিক বিরতির দিনে ডিউটি করা হয়",
      trim: true,
    },
  },
  { _id: false }
);

const overtimeSheetSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true, trim: true },
    year: { type: Number, required: true, min: 2020, max: 2100 },
    month: { type: Number, required: true, min: 1, max: 12 },
    employeeName: { type: String, default: "", trim: true },
    designation: { type: String, default: "SBA-A", trim: true },
    weeklyHoliday: { type: Number, default: 0, min: 0, max: 6 },
    clLeaveDates: { type: [String], default: [] },
    excludedDates: { type: [String], default: [] },
    extraDutyEntries: { type: [extraDutyEntrySchema], default: [] },
    dutyShift: {
      type: String,
      enum: ["A", "B", "C"],
      default: "C",
    },
    purpose: {
      type: String,
      default: "সাপ্তাহিক বিরতির দিনে ডিউটি করা হয়",
      trim: true,
    },
  },
  { timestamps: true }
);

overtimeSheetSchema.index({ userId: 1, year: 1, month: 1 }, { unique: true });

const OvertimeSheet: mongoose.Model<any> =
  mongoose.models.OvertimeSheet ||
  mongoose.model("OvertimeSheet", overtimeSheetSchema);

export default OvertimeSheet;
