const express = require("express");
const ShiftMessage = require("../models/ShiftMessage");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const SHIFT_ORDER = ["A", "B", "C"];

function nextShiftId(current) {
  const idx = SHIFT_ORDER.indexOf(current);
  return SHIFT_ORDER[(idx + 1) % SHIFT_ORDER.length];
}

function shiftFromHour(hour) {
  const h = Number(hour);
  if (h >= 9 && h <= 14) return "A";
  if (h >= 15 && h <= 20) return "B";
  return "C";
}

function dhakaNowParts(now = new Date()) {
  try {
    const ymd = now.toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Dhaka",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
    let hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
    const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
    if (hour === 24) hour = 0;
    return { ymd, hour, minute };
  } catch {
    const shifted = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    return {
      ymd: shifted.toISOString().slice(0, 10),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
    };
  }
}

function currentShiftInfo(now = new Date()) {
  const parts = dhakaNowParts(now);
  const shift = shiftFromHour(parts.hour);
  let dutyDay = parts.ymd;
  if (shift === "C" && parts.hour <= 8) {
    const [y, m, d] = parts.ymd.split("-").map(Number);
    const prev = new Date(Date.UTC(y, m - 1, d - 1));
    dutyDay = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}-${String(prev.getUTCDate()).padStart(2, "0")}`;
  }
  return { shift, dutyDay, hour: parts.hour, minute: parts.minute };
}

function serializeMessage(doc) {
  if (!doc) return null;
  const o = typeof doc.toObject === "function" ? doc.toObject() : doc;
  const id = o._id?.toString?.() || o.id || String(o._id);
  return {
    id,
    content: o.content || "",
    createdBy: o.createdBy?.toString?.() || o.createdBy || null,
    createdByUsername: o.createdByUsername || "",
    createdByDisplayName: o.createdByDisplayName || o.createdByUsername || "",
    dutyDay: o.dutyDay || "",
    fromShift: o.fromShift || "",
    targetShift: o.targetShift || "",
    status: o.status || "pending",
    acknowledgedBy: o.acknowledgedBy?.toString?.() || o.acknowledgedBy || null,
    acknowledgedByUsername: o.acknowledgedByUsername || "",
    acknowledgedByDisplayName:
      o.acknowledgedByDisplayName || o.acknowledgedByUsername || "",
    acknowledgedAt: o.acknowledgedAt || null,
    forwardedFrom: o.forwardedFrom?.toString?.() || o.forwardedFrom || null,
    forwardNote: o.forwardNote || "",
    createdAt: o.createdAt || null,
    updatedAt: o.updatedAt || null,
  };
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const status = String(req.query.status || "").toLowerCase();
    const limit = Math.min(
      50,
      Math.max(1, parseInt(String(req.query.limit || "30"), 10) || 30)
    );
    const info = currentShiftInfo();

    const filter = {};
    if (status === "pending") filter.status = "pending";
    else if (status === "acknowledged")
      filter.status = { $in: ["acknowledged", "forwarded"] };

    const docs = await ShiftMessage.find(filter)
      .sort({ status: 1, createdAt: -1 })
      .limit(limit)
      .lean();
    const pendingCount = await ShiftMessage.countDocuments({
      status: "pending",
    });

    res.json({
      success: true,
      messages: docs.map(serializeMessage),
      currentShift: info.shift,
      dutyDay: info.dutyDay,
      nextShift: nextShiftId(info.shift),
      pendingCount,
    });
  } catch (err) {
    console.error("[shift-messages GET]", err);
    res.status(500).json({
      success: false,
      message: err?.message || "Failed to load messages",
    });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const content = String(req.body?.content || "").trim();
    if (!content) {
      return res
        .status(400)
        .json({ success: false, message: "Message content is required" });
    }
    if (content.length > 2000) {
      return res.status(400).json({
        success: false,
        message: "Message is too long (max 2000 chars)",
      });
    }

    const info = currentShiftInfo();
    const targetShift = req.body?.targetShift
      ? String(req.body.targetShift).toUpperCase()
      : nextShiftId(info.shift);

    if (!["A", "B", "C"].includes(targetShift)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid target shift" });
    }

    const admin = req.admin || {};
    const username = admin.username || admin.displayName || "unknown";
    const displayName = admin.displayName || admin.username || username;

    const doc = await ShiftMessage.create({
      content,
      createdBy: admin._id || admin.id || null,
      createdByUsername: username,
      createdByDisplayName: displayName,
      dutyDay: info.dutyDay,
      fromShift: info.shift,
      targetShift,
      status: "pending",
    });

    res.json({
      success: true,
      message: serializeMessage(doc),
      currentShift: info.shift,
      nextShift: targetShift,
    });
  } catch (err) {
    console.error("[shift-messages POST]", err);
    res.status(500).json({
      success: false,
      message: err?.message || "Failed to save message",
    });
  }
});

router.post("/:id/ack", requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) {
      return res
        .status(400)
        .json({ success: false, message: "Message id is required" });
    }

    const admin = req.admin || {};
    const username = admin.username || admin.displayName || "unknown";
    const displayName = admin.displayName || admin.username || username;
    const now = new Date();

    const doc = await ShiftMessage.findById(id);
    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: "Message not found" });
    }

    if (doc.status !== "pending") {
      return res.json({
        success: true,
        message: serializeMessage(doc),
        alreadyHandled: true,
      });
    }

    doc.status = "acknowledged";
    doc.acknowledgedBy = admin._id || admin.id || null;
    doc.acknowledgedByUsername = username;
    doc.acknowledgedByDisplayName = displayName;
    doc.acknowledgedAt = now;
    await doc.save();

    res.json({ success: true, message: serializeMessage(doc) });
  } catch (err) {
    console.error("[shift-messages ack]", err);
    res.status(500).json({
      success: false,
      message: err?.message || "Failed to acknowledge",
    });
  }
});

router.post("/:id/forward", requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) {
      return res
        .status(400)
        .json({ success: false, message: "Message id is required" });
    }

    const forwardNote = String(req.body?.note || req.body?.forwardNote || "")
      .trim()
      .slice(0, 500);

    const admin = req.admin || {};
    const username = admin.username || admin.displayName || "unknown";
    const displayName = admin.displayName || admin.username || username;
    const now = new Date();
    const info = currentShiftInfo(now);
    const targetShift = nextShiftId(info.shift);

    const doc = await ShiftMessage.findById(id);
    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: "Message not found" });
    }

    doc.status = "forwarded";
    doc.acknowledgedBy = admin._id || admin.id || null;
    doc.acknowledgedByUsername = username;
    doc.acknowledgedByDisplayName = displayName;
    doc.acknowledgedAt = now;
    if (forwardNote) doc.forwardNote = forwardNote;
    await doc.save();

    const originalContent = doc.content || "";
    const prefix = forwardNote
      ? `[Fwd from ${displayName} / ${info.shift}]: ${forwardNote}\n\n`
      : `[Fwd from ${displayName} / ${info.shift}]\n\n`;

    const newDoc = await ShiftMessage.create({
      content: prefix + originalContent,
      createdBy: admin._id || admin.id || null,
      createdByUsername: username,
      createdByDisplayName: displayName,
      dutyDay: info.dutyDay,
      fromShift: info.shift,
      targetShift,
      status: "pending",
      forwardedFrom: doc._id,
      forwardNote,
    });

    res.json({
      success: true,
      message: serializeMessage(doc),
      forwardedMessage: serializeMessage(newDoc),
    });
  } catch (err) {
    console.error("[shift-messages forward]", err);
    res.status(500).json({
      success: false,
      message: err?.message || "Failed to forward message",
    });
  }
});

module.exports = router;
