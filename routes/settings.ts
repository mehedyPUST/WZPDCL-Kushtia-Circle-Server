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

function isValidHHmm(s) {
  return /^\d{1,2}:\d{2}$/.test(String(s || "").trim());
}

function normalizeSlot(s) {
  const m = String(s || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
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
    nightLogStartSlot: lean.nightLogStartSlot || "00:00",
    nightLogEndSlot: lean.nightLogEndSlot || "08:00",
    nightLogUseAi: lean.nightLogUseAi !== false,
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

    if (body.circleRelaxUntil != null) {
      const s = normalizeSlot(body.circleRelaxUntil);
      if (!s) {
        return res.status(400).json({
          success: false,
          message: "circleRelaxUntil must be HH:mm",
        });
      }
      doc.circleRelaxUntil = s;
      changed = true;
    }

    if (body.districtDayBoundary != null) {
      const s = normalizeSlot(body.districtDayBoundary);
      if (!s) {
        return res.status(400).json({
          success: false,
          message: "districtDayBoundary must be HH:mm",
        });
      }
      doc.districtDayBoundary = s;
      changed = true;
    }

    if (body.circleRelaxedSlots != null) {
      let slots = body.circleRelaxedSlots;
      if (typeof slots === "string") {
        slots = slots.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
      }
      if (!Array.isArray(slots)) {
        return res.status(400).json({
          success: false,
          message: "circleRelaxedSlots must be an array or comma-separated string",
        });
      }
      const normalized = [];
      for (const raw of slots) {
        const s = normalizeSlot(raw);
        if (!s) {
          return res.status(400).json({
            success: false,
            message: `Invalid relaxed slot: ${raw}`,
          });
        }
        if (!normalized.includes(s)) normalized.push(s);
      }
      doc.circleRelaxedSlots = normalized;
      changed = true;
    }

    if (body.nightLogStartSlot != null) {
      const s = normalizeSlot(body.nightLogStartSlot);
      if (!s) {
        return res.status(400).json({
          success: false,
          message: "nightLogStartSlot must be HH:mm (e.g. 00:00)",
        });
      }
      doc.nightLogStartSlot = s;
      changed = true;
    }

    if (body.nightLogEndSlot != null) {
      const s = normalizeSlot(body.nightLogEndSlot);
      if (!s) {
        return res.status(400).json({
          success: false,
          message: "nightLogEndSlot must be HH:mm (e.g. 08:00)",
        });
      }
      doc.nightLogEndSlot = s;
      changed = true;
    }

    if (body.nightLogUseAi != null) {
      doc.nightLogUseAi =
        body.nightLogUseAi === true ||
        body.nightLogUseAi === "true" ||
        body.nightLogUseAi === 1 ||
        body.nightLogUseAi === "1";
      changed = true;
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
