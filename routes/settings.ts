const express = require("express");
const Settings = require("../models/Settings");
const { requireAdmin, optionalAuth } = require("../middleware/auth");

const router = express.Router();

function normalizeRingMap(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  if (raw instanceof Map) {
    for (const [k, v] of raw.entries()) {
      if (v === true || v === "true" || v === 1) out[String(k)] = true;
    }
    return out;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (v === true || v === "true" || v === 1) out[String(k)] = true;
  }
  return out;
}

function payload(doc) {
  const lean = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return {
    maxLoadRingMode: lean.maxLoadRingMode === "without" ? "without" : "with",
    calculatorRingActive: normalizeRingMap(lean.calculatorRingActive),
    stationName: lean.stationName || "Bottail SS",
    stationOrg: lean.stationOrg || "WZPDCL",
    defaultBus1Kv: Number(lean.defaultBus1Kv) || 33,
    defaultBus2Kv: Number(lean.defaultBus2Kv) || 33,
    bus1MaxKv: Number(lean.bus1MaxKv) || 36,
    bus2MaxKv: Number(lean.bus2MaxKv) || 35.6,
    trashRetentionDays: Number(lean.trashRetentionDays) || 30,
    circleRelaxedSlots: Array.isArray(lean.circleRelaxedSlots)
      ? lean.circleRelaxedSlots
      : [
          "01:00",
          "02:00",
          "03:00",
          "04:00",
          "05:00",
          "06:00",
          "07:00",
          "08:00",
        ],
    circleRelaxUntil: lean.circleRelaxUntil || "12:00",
    districtDayBoundary: lean.districtDayBoundary || "22:00",
  };
}

async function getOrCreateSettings() {
  let doc = await Settings.findOne({ key: "app" });
  if (!doc) {
    doc = await Settings.create({ key: "app" });
  }
  return doc;
}

router.get("/", optionalAuth, async (_req, res) => {
  try {
    const doc = await getOrCreateSettings();
    res.json({ success: true, data: payload(doc) });
  } catch (err) {
    console.error("GET /api/settings:", err);
    res.status(500).json({
      success: false,
      message: "Failed to load settings",
      error: process.env.NODE_ENV === "production" ? undefined : err.message,
    });
  }
});

router.patch("/", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    let doc = await Settings.findOne({ key: "app" });
    if (!doc) doc = new Settings({ key: "app" });

    let changed = false;

    if (body.maxLoadRingMode != null) {
      const mode = String(body.maxLoadRingMode || "").toLowerCase();
      if (mode !== "with" && mode !== "without") {
        return res.status(400).json({
          success: false,
          message: 'maxLoadRingMode must be "with" or "without"',
        });
      }
      doc.maxLoadRingMode = mode;
      changed = true;
    }

    if (body.calculatorRingActive != null) {
      if (
        typeof body.calculatorRingActive !== "object" ||
        Array.isArray(body.calculatorRingActive)
      ) {
        return res.status(400).json({
          success: false,
          message: "calculatorRingActive must be an object map",
        });
      }
      doc.calculatorRingActive = normalizeRingMap(body.calculatorRingActive);
      doc.markModified("calculatorRingActive");
      changed = true;
    }

    const strFields = ["stationName", "stationOrg"];
    for (const f of strFields) {
      if (body[f] != null) {
        doc[f] = String(body[f]).trim();
        changed = true;
      }
    }

    const numFields = [
      "defaultBus1Kv",
      "defaultBus2Kv",
      "bus1MaxKv",
      "bus2MaxKv",
      "trashRetentionDays",
    ];
    for (const f of numFields) {
      if (body[f] != null && body[f] !== "") {
        const n = Number(body[f]);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({
            success: false,
            message: `${f} must be a non-negative number`,
          });
        }
        doc[f] = n;
        changed = true;
      }
    }

    if (!changed) {
      return res.status(400).json({
        success: false,
        message: "No valid settings fields to update",
      });
    }

    await doc.save();
    res.json({ success: true, data: payload(doc) });
  } catch (err) {
    console.error("PATCH /api/settings:", err);
    res.status(500).json({
      success: false,
      message: "Failed to save settings",
      error: process.env.NODE_ENV === "production" ? undefined : err.message,
    });
  }
});

module.exports = router;
