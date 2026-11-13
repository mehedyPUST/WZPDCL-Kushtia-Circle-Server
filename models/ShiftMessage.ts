const mongoose = require("mongoose");

const shiftMessageSchema = new mongoose.Schema(
  {
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
    createdByUsername: {
      type: String,
      default: "",
      trim: true,
    },
    createdByDisplayName: {
      type: String,
      default: "",
      trim: true,
    },
    dutyDay: {
      type: String,
      default: "",
      trim: true,
    },
    fromShift: {
      type: String,
      enum: ["A", "B", "C", ""],
      default: "",
    },
    targetShift: {
      type: String,
      enum: ["A", "B", "C", ""],
      default: "",
    },
    status: {
      type: String,
      enum: ["pending", "acknowledged", "forwarded"],
      default: "pending",
    },
    acknowledgedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
    acknowledgedByUsername: {
      type: String,
      default: "",
      trim: true,
    },
    acknowledgedByDisplayName: {
      type: String,
      default: "",
      trim: true,
    },
    acknowledgedAt: {
      type: Date,
      default: null,
    },
    forwardedFrom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftMessage",
      default: null,
    },
    forwardNote: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
  },
  { timestamps: true }
);

shiftMessageSchema.index({ status: 1, createdAt: -1 });
shiftMessageSchema.index({ targetShift: 1, status: 1, createdAt: -1 });

module.exports =
  mongoose.models.ShiftMessage ||
  mongoose.model("ShiftMessage", shiftMessageSchema);
