import mongoose from "mongoose";

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
    /** Duty day (YYYY-MM-DD, Asia/Dhaka) the message was written on */
    dutyDay: {
      type: String,
      default: "",
      trim: true,
    },
    /** Shift that wrote it: A | B | C */
    fromShift: {
      type: String,
      enum: ["A", "B", "C", ""],
      default: "",
    },
    /** Target shift that should see it: A | B | C */
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
    priority: {
      type: String,
      enum: ["normal", "high", "critical"],
      default: "normal",
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
    /** If this was forwarded, original message id */
    forwardedFrom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftMessage",
      default: null,
    },
    /** Optional note when forwarding */
    forwardNote: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
    /** Per-officer read receipts confirming operational instructions were read */
    readReceipts: {
      type: [
        {
          userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Admin",
            default: null,
          },
          username: { type: String, default: "", trim: true },
          displayName: { type: String, default: "", trim: true },
          shift: { type: String, enum: ["A", "B", "C", ""], default: "" },
          readAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

// Pending messages first, then newest
shiftMessageSchema.index({ status: 1, createdAt: -1 });
shiftMessageSchema.index({ targetShift: 1, status: 1, createdAt: -1 });
shiftMessageSchema.index({ priority: 1, status: 1, createdAt: -1 });

const ShiftMessage: mongoose.Model<any> =
  mongoose.models.ShiftMessage ||
  mongoose.model("ShiftMessage", shiftMessageSchema);

export default ShiftMessage;
