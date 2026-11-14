import mongoose from "mongoose";

const circleLoadEntrySchema = new mongoose.Schema(
  {
    dayKey: { type: String, required: true, index: true },
    hourSlot: { type: String, required: true },
    stationId: {
      type: String,
      required: true,
      enum: ["bottail", "jhinaidah", "kaligonj", "bheramara", "chuadanga"],
    },
    actualLoad: { type: Number, default: null },
    pgcbAllotment: { type: Number, default: null },
    loadshed: { type: Number, default: null },
    pbsLoad: { type: Number, default: null },
    pbsAllotment: { type: Number, default: null },
    pbsLoadshed: { type: Number, default: null },
    note: { type: String, default: "" },
    source: { type: String, default: "manual" },
    firstSubmittedAt: { type: Date, default: null },
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
    createdByUsername: { type: String, default: "" },
    updatedByUsername: { type: String, default: "" },
  },
  { timestamps: true }
);

circleLoadEntrySchema.index(
  { dayKey: 1, hourSlot: 1, stationId: 1 },
  { unique: true }
);

const CircleLoadEntry: mongoose.Model<any> =
  mongoose.models.CircleLoadEntry ||
  mongoose.model("CircleLoadEntry", circleLoadEntrySchema);

export default CircleLoadEntry;
