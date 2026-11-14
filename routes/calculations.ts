import express, { type Request, type Response } from "express";
import Calculation from "../models/Calculation.js";
import Settings from "../models/Settings.js";
import {
  optionalAuth,
  requireAdmin,
  requireDuty,
} from "../middleware/auth.js";
import { dayBoundsFromYmd } from "../lib/dhakaTime.js";
import { clientError, isValidObjectId } from "../lib/errors.js";
import {
  ACTIVE_CALCULATION_FILTER,
  computeMaxLoadReport,
  TRASH_CALCULATION_FILTER,
} from "../services/maxLoad.js";

const router = express.Router();

/** Permanently remove soft-deleted records older than trashRetentionDays (default 30). */
async function purgeExpiredTrash(): Promise<number> {
  try {
    const doc = await Settings.findOne({ key: "app" })
      .select("trashRetentionDays")
      .lean<{ trashRetentionDays?: number }>();
    const days = Number(doc?.trashRetentionDays);
    const retentionDays = Number.isFinite(days) && days > 0 ? days : 30;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await Calculation.deleteMany({
      deletedAt: { $ne: null, $lt: cutoff },
    });
    return result.deletedCount || 0;
  } catch (err) {
    console.error(
      "purgeExpiredTrash:",
      err instanceof Error ? err.message : err
    );
    return 0;
  }
}

function normalizeFeeders(feeders: any[]) {
  return feeders.map((f) => ({
    id: f.id,
    name: f.name,
    bus: f.bus,
    amps: Number(f.amps) || 0,
    mw: Number(f.mw) || 0,
    lsMW: Math.max(0, Number(f.lsMW) || 0),
    ringActive: f.ringActive === true,
  }));
}

function parseAllotment(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const num = Number(raw);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function buildEventDateFilter(query: Record<string, any>) {
  const single = query.date ? String(query.date) : "";
  const from = query.from ? String(query.from) : "";
  const to = query.to ? String(query.to) : "";

  if (single) {
    const b = dayBoundsFromYmd(single);
    if (!b) return null;
    const eventAt = { $ifNull: ["$calculatedAt", "$createdAt"] };
    return {
      $expr: {
        $and: [{ $gte: [eventAt, b.start] }, { $lt: [eventAt, b.end] }],
      },
    };
  }

  const fromB = from ? dayBoundsFromYmd(from) : null;
  const toB = to ? dayBoundsFromYmd(to) : null;
  if (!fromB && !toB) return null;

  const eventAt = { $ifNull: ["$calculatedAt", "$createdAt"] };
  const parts: any[] = [];
  if (fromB) parts.push({ $gte: [eventAt, fromB.start] });
  if (toB) parts.push({ $lt: [eventAt, toB.end] });
  return { $expr: parts.length === 1 ? parts[0] : { $and: parts } };
}

// POST /api/calculations - Save or bulk-manage calculations
router.post("/", requireDuty, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const { busVoltages, feeders, bottail11kV, totalMW, note, action, ids } =
      body;

    if (action && Array.isArray(ids)) {
      const uniqueIds = [
        ...new Set(ids.filter(Boolean).map(String).filter(isValidObjectId)),
      ];

      if (uniqueIds.length === 0) {
        res.status(400).json({ success: false, message: "No items selected" });
        return;
      }

      await purgeExpiredTrash();

      if (action === "trash") {
        const result = await Calculation.updateMany(
          { _id: { $in: uniqueIds }, ...ACTIVE_CALCULATION_FILTER },
          { $set: { deletedAt: new Date() } }
        );
        res.json({
          success: true,
          message: "Moved to trash",
          modified: result.modifiedCount,
        });
        return;
      }

      if (action === "restore") {
        const result = await Calculation.updateMany(
          { _id: { $in: uniqueIds }, deletedAt: { $ne: null } },
          { $set: { deletedAt: null } }
        );
        res.json({
          success: true,
          message: "Restored to history",
          modified: result.modifiedCount,
        });
        return;
      }

      if (action === "purge") {
        if (req.admin?.role !== "admin") {
          res.status(403).json({
            success: false,
            message: "Admin access required to permanently delete",
          });
          return;
        }
        const result = await Calculation.deleteMany({
          _id: { $in: uniqueIds },
          deletedAt: { $ne: null },
        });
        res.json({
          success: true,
          message: "Permanently deleted",
          deleted: result.deletedCount,
        });
        return;
      }

      if (action === "empty_trash") {
        if (req.admin?.role !== "admin") {
          res.status(403).json({
            success: false,
            message: "Admin access required to empty trash",
          });
          return;
        }
        await purgeExpiredTrash();
        const result = await Calculation.deleteMany(TRASH_CALCULATION_FILTER);
        res.json({
          success: true,
          message: "Trash emptied",
          deleted: result.deletedCount,
        });
        return;
      }

      res.status(400).json({ success: false, message: "Unknown action" });
      return;
    }

    if (
      !busVoltages ||
      busVoltages.bus1 == null ||
      busVoltages.bus2 == null ||
      !Array.isArray(feeders)
    ) {
      res.status(400).json({
        success: false,
        message: "Missing required fields: busVoltages and feeders",
      });
      return;
    }

    const bus1 = Number(busVoltages.bus1);
    const bus2 = Number(busVoltages.bus2);
    if (!Number.isFinite(bus1) || !Number.isFinite(bus2)) {
      res.status(400).json({
        success: false,
        message: "busVoltages.bus1 and busVoltages.bus2 must be valid numbers",
      });
      return;
    }

    let calculatedAt = new Date();
    if (body.calculatedAt) {
      const parsed = new Date(body.calculatedAt);
      if (!Number.isNaN(parsed.getTime())) calculatedAt = parsed;
    }

    const hourSlot =
      typeof body.hourSlot === "string" && body.hourSlot.trim()
        ? body.hourSlot.trim()
        : null;
    const isHourly = body.isHourly === true || !!hourSlot;

    const normalizedFeeders = normalizeFeeders(feeders);
    const hasActiveRing = normalizedFeeders.some((f) => f.ringActive);

    const fields = {
      busVoltages: { bus1, bus2 },
      feeders: normalizedFeeders,
      bottail11kV: Number(bottail11kV) || 0,
      totalMW: Number(totalMW) || 0,
      allotment: parseAllotment(body.allotment),
      note: note || "",
      calculatedAt,
      hourSlot,
      isHourly,
      hasActiveRing,
      deletedAt: null,
      createdBy: req.admin?.id || req.adminId || null,
      updatedBy: req.admin?.id || req.adminId || null,
      createdByUsername: req.admin?.username || "",
      updatedByUsername: req.admin?.username || "",
    };

    if (body.replaceExistingId) {
      if (!isValidObjectId(String(body.replaceExistingId))) {
        res.status(400).json({
          success: false,
          message: "Invalid replaceExistingId",
        });
        return;
      }

      const updated = await Calculation.findOneAndUpdate(
        { _id: body.replaceExistingId, ...ACTIVE_CALCULATION_FILTER },
        { $set: fields },
        { new: true }
      );
      if (!updated) {
        res.status(404).json({
          success: false,
          message: "Existing slot record not found or already removed",
        });
        return;
      }
      res.status(200).json({
        success: true,
        message: "Slot data replaced successfully",
        replaced: true,
        data: updated,
      });
      return;
    }

    const doc = await Calculation.create(fields);
    res.status(201).json({
      success: true,
      message: "Calculation saved successfully",
      data: doc,
    });
  } catch (err) {
    console.error("Save error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to save calculation",
      error: clientError(err),
    });
  }
});

// GET /api/calculations/slot-check?hourSlot=08:00&dayStart=...&dayEnd=...
router.get(
  "/slot-check",
  optionalAuth,
  async (req: Request, res: Response) => {
    try {
      const hourSlot = String(req.query.hourSlot || "").trim();
      const dayStart = req.query.dayStart
        ? new Date(String(req.query.dayStart))
        : null;
      const dayEnd = req.query.dayEnd
        ? new Date(String(req.query.dayEnd))
        : null;

      if (
        !hourSlot ||
        !dayStart ||
        !dayEnd ||
        Number.isNaN(dayStart.getTime()) ||
        Number.isNaN(dayEnd.getTime())
      ) {
        res.status(400).json({
          success: false,
          message: "hourSlot, dayStart and dayEnd are required",
        });
        return;
      }

      const existing = await Calculation.findOne({
        $and: [
          ACTIVE_CALCULATION_FILTER,
          { hourSlot },
          {
            $or: [
              { calculatedAt: { $gte: dayStart, $lt: dayEnd } },
              {
                calculatedAt: { $exists: false },
                createdAt: { $gte: dayStart, $lt: dayEnd },
              },
            ],
          },
        ],
      })
        .sort({ calculatedAt: -1 })
        .lean<any>();

      res.json({
        success: true,
        exists: !!existing,
        data: existing
          ? {
              _id: existing._id,
              hourSlot: existing.hourSlot,
              calculatedAt: existing.calculatedAt,
              totalMW: existing.totalMW,
              note: existing.note || "",
            }
          : null,
      });
    } catch (err) {
      console.error("Slot-check error:", err);
      res.status(500).json({
        success: false,
        message: "Failed to check slot",
        error: clientError(err),
      });
    }
  }
);

// GET /api/calculations
router.get("/", optionalAuth, async (req: Request, res: Response) => {
  try {
    await purgeExpiredTrash();

    const rawLimit = String(req.query.limit ?? "50").toLowerCase();
    let limit: number;
    if (rawLimit === "0" || rawLimit === "all") {
      limit = 0;
    } else {
      const n = parseInt(rawLimit, 10);
      limit = Math.min(Number.isFinite(n) && n > 0 ? n : 50, 200);
    }
    const pageRaw = parseInt(String(req.query.page || "1"), 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const skip = limit > 0 ? (page - 1) * limit : 0;

    const trash = req.query.trash === "1" || req.query.trash === "true";
    const baseFilter = trash
      ? TRASH_CALCULATION_FILTER
      : ACTIVE_CALCULATION_FILTER;
    const dateFilter = buildEventDateFilter(req.query);
    const filter = dateFilter
      ? { $and: [baseFilter, dateFilter] }
      : baseFilter;

    const sort = trash ? { deletedAt: -1 as const } : { createdAt: -1 as const };
    const q = Calculation.find(filter).sort(sort);
    if (limit > 0) {
      q.skip(skip).limit(limit);
    } else {
      q.limit(10000);
    }

    const [docs, total, inboxCount, trashCount] = await Promise.all([
      q.lean(),
      Calculation.countDocuments(filter),
      Calculation.countDocuments(ACTIVE_CALCULATION_FILTER),
      Calculation.countDocuments(TRASH_CALCULATION_FILTER),
    ]);

    const pages = limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1;

    res.json({
      success: true,
      count: docs.length,
      total,
      page: limit > 0 ? page : 1,
      limit: limit > 0 ? limit : total,
      pages,
      inboxCount,
      trashCount,
      trash,
      data: docs,
      isAuthenticated: !!req.admin,
    });
  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch calculations",
      error: clientError(err),
    });
  }
});

// GET /api/calculations/max-load
router.get("/max-load", optionalAuth, async (req: Request, res: Response) => {
  try {
    await purgeExpiredTrash();
    const report = await computeMaxLoadReport(req.query);
    res.json({
      success: true,
      ...report,
      isAuthenticated: !!req.admin,
    });
  } catch (err) {
    console.error("Max-load error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to compute max load",
      error: clientError(err),
    });
  }
});

// Legacy settings routes mounted under /api/calculations/settings
router.get("/settings", optionalAuth, async (_req: Request, res: Response) => {
  try {
    const doc = await Settings.findOneAndUpdate(
      { key: "app" },
      { $setOnInsert: { key: "app", maxLoadRingMode: "with" } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean<{ maxLoadRingMode?: string }>();

    res.json({
      success: true,
      data: {
        maxLoadRingMode: doc?.maxLoadRingMode === "without" ? "without" : "with",
      },
    });
  } catch (err) {
    console.error("GET /api/calculations/settings:", err);
    res.status(500).json({
      success: false,
      message: "Failed to load settings",
      error: clientError(err),
    });
  }
});

router.patch("/settings", requireAdmin, async (req: Request, res: Response) => {
  try {
    const mode = String(req.body?.maxLoadRingMode || "").toLowerCase();
    if (mode !== "with" && mode !== "without") {
      res.status(400).json({
        success: false,
        message: 'maxLoadRingMode must be "with" or "without"',
      });
      return;
    }
    const doc = await Settings.findOneAndUpdate(
      { key: "app" },
      { $set: { maxLoadRingMode: mode } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean<{ maxLoadRingMode?: string }>();

    res.json({
      success: true,
      data: {
        maxLoadRingMode: doc?.maxLoadRingMode === "without" ? "without" : "with",
      },
    });
  } catch (err) {
    console.error("PATCH /api/calculations/settings:", err);
    res.status(500).json({
      success: false,
      message: "Failed to save settings",
      error: clientError(err),
    });
  }
});

// GET /api/calculations/:id
router.get("/:id", optionalAuth, async (req: Request, res: Response) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      res.status(400).json({ success: false, message: "Invalid calculation ID" });
      return;
    }
    await purgeExpiredTrash();
    const doc = await Calculation.findById(req.params.id).lean();
    if (!doc) {
      res.status(404).json({ success: false, message: "Not found" });
      return;
    }
    res.json({ success: true, data: doc });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch calculation",
      error: clientError(err),
    });
  }
});

// DELETE /api/calculations/:id
router.delete("/:id", requireDuty, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      res.status(400).json({ success: false, message: "Invalid calculation ID" });
      return;
    }

    await purgeExpiredTrash();
    const permanent =
      req.query.permanent === "1" || req.query.permanent === "true";

    if (permanent) {
      if (req.admin?.role !== "admin") {
        res.status(403).json({
          success: false,
          message: "Admin access required to permanently delete",
        });
        return;
      }
      const doc = await Calculation.findOneAndDelete({
        _id: id,
        deletedAt: { $ne: null },
      });
      if (!doc) {
        const exists = await Calculation.findById(id).lean();
        if (exists) {
          res.status(400).json({
            success: false,
            message: "Item is in History. Move to Trash first.",
          });
          return;
        }
        res.status(404).json({ success: false, message: "Not found" });
        return;
      }
      res.json({ success: true, message: "Permanently deleted" });
      return;
    }

    const doc = await Calculation.findOneAndUpdate(
      { _id: id, ...ACTIVE_CALCULATION_FILTER },
      { $set: { deletedAt: new Date() } },
      { new: true }
    );

    if (!doc) {
      res.status(404).json({
        success: false,
        message: "Not found or already in trash",
      });
      return;
    }

    res.json({ success: true, message: "Moved to trash", data: doc });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to delete",
      error: clientError(err),
    });
  }
});

// PATCH /api/calculations/:id
router.patch("/:id", requireDuty, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      res.status(400).json({ success: false, message: "Invalid calculation ID" });
      return;
    }

    await purgeExpiredTrash();
    const body = req.body || {};

    if (body.action === "restore") {
      const doc = await Calculation.findOneAndUpdate(
        { _id: id, deletedAt: { $ne: null } },
        { $set: { deletedAt: null } },
        { new: true }
      );
      if (!doc) {
        res.status(404).json({ success: false, message: "Not found in trash" });
        return;
      }
      res.json({ success: true, message: "Restored", data: doc });
      return;
    }

    const { busVoltages, feeders, bottail11kV, totalMW, note } = body;
    if (
      !busVoltages ||
      busVoltages.bus1 == null ||
      busVoltages.bus2 == null ||
      !Array.isArray(feeders)
    ) {
      res.status(400).json({
        success: false,
        message:
          "Missing required fields: busVoltages and feeders (or use { action: 'restore' })",
      });
      return;
    }

    const bus1 = Number(busVoltages.bus1);
    const bus2 = Number(busVoltages.bus2);
    if (!Number.isFinite(bus1) || !Number.isFinite(bus2)) {
      res.status(400).json({
        success: false,
        message: "busVoltages.bus1 and busVoltages.bus2 must be valid numbers",
      });
      return;
    }

    const normalizedFeeders = normalizeFeeders(feeders);
    const fields: Record<string, any> = {
      busVoltages: { bus1, bus2 },
      feeders: normalizedFeeders,
      bottail11kV: Number(bottail11kV) || 0,
      totalMW: Number(totalMW) || 0,
      allotment: parseAllotment(body.allotment),
      hasActiveRing: normalizedFeeders.some((f) => f.ringActive),
      updatedBy: req.admin?.id || req.adminId || null,
      updatedByUsername: req.admin?.username || "",
    };

    if (note != null) fields.note = String(note);
    if (typeof body.hourSlot === "string" && body.hourSlot.trim()) {
      fields.hourSlot = body.hourSlot.trim();
      fields.isHourly = true;
    }
    if (body.calculatedAt) {
      const parsed = new Date(body.calculatedAt);
      if (!Number.isNaN(parsed.getTime())) fields.calculatedAt = parsed;
    }

    const doc = await Calculation.findOneAndUpdate(
      { _id: id, ...ACTIVE_CALCULATION_FILTER },
      { $set: fields },
      { new: true }
    );

    if (!doc) {
      res.status(404).json({ success: false, message: "Not found or in trash" });
      return;
    }

    res.json({ success: true, message: "Updated", data: doc });
  } catch (err) {
    console.error("Update error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to update calculation",
      error: clientError(err),
    });
  }
});

export default router;