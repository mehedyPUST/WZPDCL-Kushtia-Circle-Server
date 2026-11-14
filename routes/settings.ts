import express, { type Request, type Response } from "express";
import Settings from "../models/Settings.js";
import { optionalAuth, requireAdmin } from "../middleware/auth.js";
import { clientError } from "../lib/errors.js";

const router = express.Router();

const DEFAULT_RELAXED_SLOTS = [
  "01:00",
  "02:00",
  "03:00",
  "04:00",
  "05:00",
  "06:00",
  "07:00",
  "08:00",
];

function normalizeRingMap(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!raw || typeof raw !== "object") return out;

  const entries =
    raw instanceof Map ? Array.from(raw.entries()) : Object.entries(raw);
  for (const [k, v] of entries) {
    if (v === true || v === "true" || v === 1) {
      out[String(k)] = true;
    }
  }
  return out;
}

function normalizeSlot(s: unknown): string | null {
  const m = String(s || "")
    .trim()
    .match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || h < 0 || h > 23 || min < 0 || min > 59) {
    return null;
  }
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function serializeSettings(doc: any) {
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
      : DEFAULT_RELAXED_SLOTS,
    circleRelaxUntil: lean.circleRelaxUntil || "12:00",
    districtDayBoundary: lean.districtDayBoundary || "22:00",
    nightLogStartSlot: lean.nightLogStartSlot || "00:00",
    nightLogEndSlot: lean.nightLogEndSlot || "08:00",
    nightLogUseAi: lean.nightLogUseAi !== false,
  };
}

async function getOrCreateSettings() {
  return Settings.findOneAndUpdate(
    { key: "app" },
    { $setOnInsert: { key: "app" } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

router.get("/", optionalAuth, async (_req: Request, res: Response) => {
  try {
    const doc = await getOrCreateSettings();
    res.json({ success: true, data: serializeSettings(doc) });
  } catch (err) {
    console.error("GET /api/settings:", err);
    res.status(500).json({
      success: false,
      message: "Failed to load settings",
      error: clientError(err),
    });
  }
});

router.patch("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const doc = await getOrCreateSettings();
    let changed = false;

    if (body.maxLoadRingMode != null) {
      const mode = String(body.maxLoadRingMode || "").toLowerCase();
      if (mode !== "with" && mode !== "without") {
        res.status(400).json({
          success: false,
          message: 'maxLoadRingMode must be "with" or "without"',
        });
        return;
      }
      doc.maxLoadRingMode = mode;
      changed = true;
    }

    if (body.calculatorRingActive != null) {
      if (
        typeof body.calculatorRingActive !== "object" ||
        Array.isArray(body.calculatorRingActive)
      ) {
        res.status(400).json({
          success: false,
          message: "calculatorRingActive must be an object map",
        });
        return;
      }
      doc.calculatorRingActive = normalizeRingMap(body.calculatorRingActive);
      doc.markModified("calculatorRingActive");
      changed = true;
    }

    for (const f of ["stationName", "stationOrg"] as const) {
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
    ] as const;
    for (const f of numFields) {
      if (body[f] != null && body[f] !== "") {
        const n = Number(body[f]);
        if (!Number.isFinite(n) || n < 0) {
          res.status(400).json({
            success: false,
            message: `${f} must be a non-negative number`,
          });
          return;
        }
        doc[f] = n;
        changed = true;
      }
    }

    const slotFields = [
      { key: "circleRelaxUntil", label: "HH:mm" },
      { key: "districtDayBoundary", label: "HH:mm" },
      { key: "nightLogStartSlot", label: "HH:mm (e.g. 00:00)" },
      { key: "nightLogEndSlot", label: "HH:mm (e.g. 08:00)" },
    ] as const;

    for (const { key, label } of slotFields) {
      if (body[key] != null) {
        const s = normalizeSlot(body[key]);
        if (!s) {
          res.status(400).json({
            success: false,
            message: `${key} must be ${label}`,
          });
          return;
        }
        doc[key] = s;
        changed = true;
      }
    }

    if (body.circleRelaxedSlots != null) {
      let slots = body.circleRelaxedSlots;
      if (typeof slots === "string") {
        slots = slots
          .split(/[,;\s]+/)
          .map((x: string) => x.trim())
          .filter(Boolean);
      }
      if (!Array.isArray(slots)) {
        res.status(400).json({
          success: false,
          message:
            "circleRelaxedSlots must be an array or comma-separated string",
        });
        return;
      }
      const normalized: string[] = [];
      for (const raw of slots) {
        const s = normalizeSlot(raw);
        if (!s) {
          res.status(400).json({
            success: false,
            message: `Invalid relaxed slot: ${raw}`,
          });
          return;
        }
        if (!normalized.includes(s)) normalized.push(s);
      }
      doc.circleRelaxedSlots = normalized;
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
      res.status(400).json({
        success: false,
        message: "No valid settings fields to update",
      });
      return;
    }

    await doc.save();
    res.json({ success: true, data: serializeSettings(doc) });
  } catch (err) {
    console.error("PATCH /api/settings:", err);
    res.status(500).json({
      success: false,
      message: "Failed to save settings",
      error: clientError(err),
    });
  }
});

export default router;
