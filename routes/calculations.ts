// backend/routes/calculations.js
const express = require("express");
const Calculation = require("../models/Calculation");
const { requireAuth, requireDuty, requireAdmin, optionalAuth } = require("../middleware/auth");

const router = express.Router();

const activeFilter = {
  $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
};
const trashFilter = { deletedAt: { $ne: null } };

/** Permanently remove soft-deleted records older than trashRetentionDays (default 30). */
async function purgeExpiredTrash() {
  try {
    const Settings = require("../models/Settings");
    const doc = await Settings.findOne({ key: "app" }).select("trashRetentionDays").lean();
    const days = Number(doc?.trashRetentionDays);
    const retentionDays = Number.isFinite(days) && days > 0 ? days : 30;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await Calculation.deleteMany({
      deletedAt: { $ne: null, $lt: cutoff },
    });
    return result.deletedCount || 0;
  } catch (err) {
    console.error("purgeExpiredTrash:", err.message);
    return 0;
  }
}

function clientError(err) {
  return process.env.NODE_ENV === "production" ? undefined : err?.message;
}

// POST /api/calculations - Requires authentication
router.post("/", requireDuty, async (req, res) => {
  try {
    const { busVoltages, feeders, bottail11kV, totalMW, note, action, ids } = req.body;

    // Handle bulk operations
    if (action && Array.isArray(ids)) {
      const uniqueIds = [...new Set((ids || []).filter(Boolean).map(String))];

      if (uniqueIds.length === 0) {
        return res.status(400).json({
          success: false,
          message: "No items selected",
        });
      }

      await purgeExpiredTrash();

      if (action === "trash") {
        const result = await Calculation.updateMany(
          {
            _id: { $in: uniqueIds },
            $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
          },
          { $set: { deletedAt: new Date() } }
        );
        return res.json({
          success: true,
          message: "Moved to trash",
          modified: result.modifiedCount,
        });
      }

      if (action === "restore") {
        const result = await Calculation.updateMany(
          { _id: { $in: uniqueIds }, deletedAt: { $ne: null } },
          { $set: { deletedAt: null } }
        );
        return res.json({
          success: true,
          message: "Restored to history",
          modified: result.modifiedCount,
        });
      }

      if (action === "purge") {
        if (req.admin?.role !== "admin") {
          return res.status(403).json({
            success: false,
            message: "Admin access required to permanently delete",
          });
        }
        const result = await Calculation.deleteMany({
          _id: { $in: uniqueIds },
          deletedAt: { $ne: null },
        });
        return res.json({
          success: true,
          message: "Permanently deleted",
          deleted: result.deletedCount,
        });
      }

      if (action === "empty_trash") {
        if (req.admin?.role !== "admin") {
          return res.status(403).json({
            success: false,
            message: "Admin access required to empty trash",
          });
        }
        await purgeExpiredTrash();
        const result = await Calculation.deleteMany(trashFilter);
        return res.json({
          success: true,
          message: "Trash emptied",
          deleted: result.deletedCount,
        });
      }

      return res.status(400).json({
        success: false,
        message: "Unknown action",
      });
    }

    // Regular save
    if (
      !busVoltages ||
      busVoltages.bus1 == null ||
      busVoltages.bus2 == null ||
      !Array.isArray(feeders)
    ) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: busVoltages and feeders",
      });
    }

    const body = req.body;
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

    const normalizedFeeders = (feeders || []).map((f) => ({
      id: f.id,
      name: f.name,
      bus: f.bus,
      amps: Number(f.amps) || 0,
      mw: Number(f.mw) || 0,
      lsMW: Math.max(0, Number(f.lsMW) || 0),
      ringActive: f.ringActive === true,
    }));
    const hasActiveRing = normalizedFeeders.some((f) => f.ringActive === true);

    const allotmentRaw = body.allotment;
    const allotmentNum =
      allotmentRaw === null || allotmentRaw === undefined || allotmentRaw === ""
        ? null
        : Number(allotmentRaw);
    const allotmentVal =
      allotmentNum != null && Number.isFinite(allotmentNum) && allotmentNum >= 0
        ? allotmentNum
        : null;

    const fields = {
      busVoltages: {
        bus1: Number(busVoltages.bus1),
        bus2: Number(busVoltages.bus2),
      },
      feeders: normalizedFeeders,
      bottail11kV: Number(bottail11kV) || 0,
      totalMW: Number(totalMW) || 0,
      allotment: allotmentVal,
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

    // Replace existing same-day / same-slot record when requested
    if (body.replaceExistingId) {
      const updated = await Calculation.findOneAndUpdate(
        {
          _id: body.replaceExistingId,
          $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
        },
        { $set: fields },
        { new: true }
      );
      if (!updated) {
        return res.status(404).json({
          success: false,
          message: "Existing slot record not found or already removed",
        });
      }
      return res.status(200).json({
        success: true,
        message: "Slot data replaced successfully",
        replaced: true,
        data: updated,
      });
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
// Find existing active hourly record for the same calendar slot
router.get("/slot-check", optionalAuth, async (req, res) => {
  try {
    const hourSlot = String(req.query.hourSlot || "").trim();
    const dayStart = req.query.dayStart
      ? new Date(req.query.dayStart)
      : null;
    const dayEnd = req.query.dayEnd ? new Date(req.query.dayEnd) : null;

    if (!hourSlot || !dayStart || !dayEnd || Number.isNaN(dayStart.getTime()) || Number.isNaN(dayEnd.getTime())) {
      return res.status(400).json({
        success: false,
        message: "hourSlot, dayStart and dayEnd are required",
      });
    }

    const existing = await Calculation.findOne({
      $and: [
        activeFilter,
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
      .lean();

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
});

function dayBoundsFromYmd(ymd) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) return null;
  const [y, m, d] = String(ymd).split("-").map(Number);
  if (!y || !m || !d) return null;
  // Asia/Dhaka (UTC+6) — must not use server-local timezone
  const OFFSET_MS = 6 * 60 * 60 * 1000;
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - OFFSET_MS);
  const end = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0) - OFFSET_MS);
  if (Number.isNaN(start.getTime())) return null;
  return { start, end };
}

function buildEventDateFilter(query) {
  const single = query.date;
  const from = query.from;
  const to = query.to;

  if (single) {
    const b = dayBoundsFromYmd(single);
    if (!b) return null;
    const eventAt = { $ifNull: ["$calculatedAt", "$createdAt"] };
    return {
      $expr: {
        $and: [
          { $gte: [eventAt, b.start] },
          { $lt: [eventAt, b.end] },
        ],
      },
    };
  }

  const fromB = from ? dayBoundsFromYmd(from) : null;
  const toB = to ? dayBoundsFromYmd(to) : null;
  if (!fromB && !toB) return null;

  const eventAt = { $ifNull: ["$calculatedAt", "$createdAt"] };
  const parts = [];
  if (fromB) parts.push({ $gte: [eventAt, fromB.start] });
  if (toB) parts.push({ $lt: [eventAt, toB.end] });
  return { $expr: parts.length === 1 ? parts[0] : { $and: parts } };
}

// GET /api/calculations - Optional auth (view without login for read-only)
// Query: page, limit, trash, date=YYYY-MM-DD, from, to
router.get("/", optionalAuth, async (req, res) => {
  try {
    await purgeExpiredTrash();

    const rawLimit = String(req.query.limit ?? "50").toLowerCase();
    let limit;
    if (rawLimit === "0" || rawLimit === "all") {
      limit = 0;
    } else {
      const n = parseInt(rawLimit, 10);
      limit = Math.min(Number.isFinite(n) && n > 0 ? n : 50, 200);
    }
    const pageRaw = parseInt(req.query.page || "1", 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const skip = limit > 0 ? (page - 1) * limit : 0;

    const trash = req.query.trash === "1" || req.query.trash === "true";
    const baseFilter = trash ? trashFilter : activeFilter;
    const dateFilter = buildEventDateFilter(req.query);
    const filter = dateFilter
      ? { $and: [baseFilter, dateFilter] }
      : baseFilter;

    const sort = trash ? { deletedAt: -1 } : { createdAt: -1 };
    const q = Calculation.find(filter).sort(sort);
    if (limit > 0) {
      q.skip(skip).limit(limit);
    } else {
      q.limit(10000);
    }

    const [docs, total, inboxCount, trashCount] = await Promise.all([
      q.lean(),
      Calculation.countDocuments(filter),
      Calculation.countDocuments(activeFilter),
      Calculation.countDocuments(trashFilter),
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

// GET /api/calculations/max-load?range=today|last7days|lastweek|monthly|yearly|alltime&year=YYYY&month=MM
// Top 5 max MW peaks per feeder (prefer hourly / hourSlot saves)
router.get("/max-load", optionalAuth, async (req, res) => {
  try {
    await purgeExpiredTrash();

    const VALID_RANGES = new Set([
      "today",
      "last7days",
      "lastweek",
      "monthly",
      "yearly",
      "alltime",
    ]);

    const now = new Date();
    let range = String(req.query.range || "monthly").toLowerCase();
    if (!VALID_RANGES.has(range)) range = "monthly";

    let year = parseInt(req.query.year, 10);
    let month = parseInt(req.query.month, 10);
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      year = now.getFullYear();
    }
    if (!Number.isFinite(month) || month < 1 || month > 12) {
      month = now.getMonth() + 1;
    }

    let start = null;
    let end = null;
    let label = "";

    switch (range) {
      case "today": {
        const BD = 6 * 60 * 60 * 1000;
        const t = new Date(now.getTime() + BD);
        const y = t.getUTCFullYear(), m = t.getUTCMonth(), d = t.getUTCDate();
        start = new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - BD);
        end = new Date(Date.UTC(y, m, d + 1, 0, 0, 0, 0) - BD);
        label = "Today";
        break;
      }
      case "last7days": {
        const BD = 6 * 60 * 60 * 1000;
        const t = new Date(now.getTime() + BD);
        const y = t.getUTCFullYear(), m = t.getUTCMonth(), d = t.getUTCDate();
        end = new Date(Date.UTC(y, m, d + 1, 0, 0, 0, 0) - BD);
        start = new Date(Date.UTC(y, m, d + 1 - 7, 0, 0, 0, 0) - BD);
        label = "Last 7 days";
        break;
      }
      case "lastweek": {
        const day = now.getDay();
        const daysSinceMon = day === 0 ? 6 : day - 1;
        const thisMon = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate() - daysSinceMon,
          0,
          0,
          0,
          0
        );
        end = thisMon;
        start = new Date(thisMon);
        start.setDate(start.getDate() - 7);
        label = "Last week";
        break;
      }
      case "yearly": {
        start = new Date(year, 0, 1, 0, 0, 0, 0);
        end = new Date(year + 1, 0, 1, 0, 0, 0, 0);
        label = `Year ${year}`;
        break;
      }
      case "alltime": {
        start = null;
        end = null;
        label = "All time";
        break;
      }
      case "monthly":
      default: {
        const BD = 6 * 60 * 60 * 1000;
        start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0) - BD);
        end =
          month === 12
            ? new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0) - BD)
            : new Date(Date.UTC(year, month, 1, 0, 0, 0, 0) - BD);
        const names = [
          "January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December",
        ];
        label = `${names[month - 1]} ${year}`;
        break;
      }
    }

    const andParts = [activeFilter];
    // Include if calculatedAt OR createdAt falls in range (broad match)
    let dateMatchServer = null;
    if (start || end) {
      const rangeQ = {};
      if (start) rangeQ.$gte = start;
      if (end) rangeQ.$lt = end;
      dateMatchServer = {
        $or: [{ calculatedAt: rangeQ }, { createdAt: rangeQ }],
      };
      andParts.push(dateMatchServer);
    }

    /**
     * ringMode for per-feeder MAX (incl. H-3 / T-3):
     * - without: only samples with no ring/coupler ON.
     *   H-3 max = H-3 feeding its own 11 kV feeders only (not via bus coupler).
     *   T-3 max = T-3 feeding its own 11 kV feeders only.
     *   Same rule for Mozompur↔Housing↔Campus/GIS (no direct Mozompur↔GIS) and external rings.
     * - with: include ring/coupler samples (individual peaks may be shared-bus).
     *
     * Station total MW peak and Bottail 11 kV (H3+T3) peak always use ALL
     * samples in range — combined 11 kV load must count even under coupler.
     */
    let ringMode = String(req.query.ringMode || "with").toLowerCase();
    if (!["without", "with", "all"].includes(ringMode)) ringMode = "with";
    let peakBy = String(req.query.peakBy || "mw").toLowerCase();
    if (!["mw", "amps"].includes(peakBy)) peakBy = "mw";
    if (ringMode === "without") {
      andParts.push({
        $and: [
          {
            $or: [
              { hasActiveRing: false },
              { hasActiveRing: { $exists: false } },
              { hasActiveRing: null },
            ],
          },
          { $nor: [{ "feeders.ringActive": true }] },
        ],
      });
    }

    const baseMatch = { $and: andParts };

    const hourlyCount = await Calculation.countDocuments({
      $and: [
        ...andParts,
        {
          $or: [
            { isHourly: true },
            { hourSlot: { $type: "string", $ne: "" } },
          ],
        },
      ],
    });

    const pipeline = [
      { $match: baseMatch },
      { $unwind: "$feeders" },
      {
        $addFields: {
          eventAt: { $ifNull: ["$calculatedAt", "$createdAt"] },
        },
      },
      {
        $sort: peakBy === "amps"
          ? { "feeders.amps": -1, "feeders.mw": -1, eventAt: 1 }
          : { "feeders.mw": -1, "feeders.amps": -1, eventAt: 1 },
      },
      {
        $group: {
          _id: "$feeders.id",
          name: { $first: "$feeders.name" },
          bus: { $first: "$feeders.bus" },
          peaks: {
            $push: {
              maxMW: "$feeders.mw",
              maxLoadAt: "$eventAt",
              ampsAtMax: "$feeders.amps",
              hourSlot: "$hourSlot",
              hasActiveRing: { $eq: ["$hasActiveRing", true] },
            },
          },
          recordCount: { $sum: 1 },
        },
      },
      {
        $project: {
          name: 1,
          bus: 1,
          recordCount: 1,
          peaks: { $slice: ["$peaks", 5] },
          maxMW: { $arrayElemAt: ["$peaks.maxMW", 0] },
          maxLoadAt: { $arrayElemAt: ["$peaks.maxLoadAt", 0] },
          ampsAtMax: { $arrayElemAt: ["$peaks.ampsAtMax", 0] },
        },
      },
      { $sort: { _id: 1 } },
    ];

    const rows = await Calculation.aggregate(pipeline);

    // Station peak always uses ALL data in the date range (ignore ring)
    const stationPeakMatch = {
      $and: [activeFilter, ...(dateMatchServer ? [dateMatchServer] : [])],
    };
    const totalPeak = await Calculation.aggregate([
      { $match: stationPeakMatch },
      {
        $addFields: {
          eventAt: { $ifNull: ["$calculatedAt", "$createdAt"] },
          totalMWNum: {
            $convert: {
              input: "$totalMW",
              to: "double",
              onError: 0,
              onNull: 0,
            },
          },
        },
      },
      { $sort: { totalMWNum: -1, eventAt: 1 } },
      { $limit: 1 },
      {
        $project: {
          _id: 0,
          maxTotalMW: "$totalMWNum",
          maxTotalAt: "$eventAt",
          hourSlot: 1,
          hasActiveRing: { $eq: ["$hasActiveRing", true] },
        },
      },
    ]);

    const bottail11Peaks = await Calculation.aggregate([
      { $match: stationPeakMatch },
      { $addFields: { eventAt: { $ifNull: ["$calculatedAt", "$createdAt"] } } },
      { $sort: { bottail11kV: -1, eventAt: 1 } },
      { $limit: 5 },
      {
        $project: {
          _id: 0,
          maxMW: { $ifNull: ["$bottail11kV", 0] },
          maxLoadAt: "$eventAt",
          hourSlot: 1,
          hasActiveRing: { $eq: ["$hasActiveRing", true] },
          ampsAtMax: {
            $sum: {
              $map: {
                input: {
                  $filter: {
                    input: "$feeders",
                    as: "f",
                    cond: { $in: ["$$f.id", [8, 9]] },
                  },
                },
                as: "f",
                in: { $ifNull: ["$$f.amps", 0] },
              },
            },
          },
        },
      },
    ]);

    const sampleCount = await Calculation.countDocuments(baseMatch);

    res.json({
      success: true,
      range,
      label,
      ringMode,
      peakBy,
      year,
      month,
      start: start ? start.toISOString() : null,
      end: end ? end.toISOString() : null,
      sampleCount,
      hourlyOnly: hourlyCount > 0,
      data: rows.map((r) => ({
        feederId: r._id,
        name: r.name,
        bus: r.bus,
        maxMW: r.maxMW ?? 0,
        maxLoadAt: r.maxLoadAt,
        ampsAtMax: r.ampsAtMax ?? 0,
        recordCount: r.recordCount ?? 0,
        peaks: (r.peaks || []).map((p) => ({
          maxMW: p.maxMW ?? 0,
          maxLoadAt: p.maxLoadAt,
          ampsAtMax: p.ampsAtMax ?? 0,
          hourSlot: p.hourSlot || null,
          hasActiveRing: !!p.hasActiveRing,
        })),
      })),
      bottail11Peaks: (bottail11Peaks || []).map((p) => ({
        maxMW: p.maxMW ?? 0,
        maxLoadAt: p.maxLoadAt,
        ampsAtMax: p.ampsAtMax ?? 0,
        hourSlot: p.hourSlot || null,
        hasActiveRing: !!p.hasActiveRing,
      })),
      totalPeak: totalPeak[0]
        ? {
            ...totalPeak[0],
            hasActiveRing: !!totalPeak[0].hasActiveRing,
          }
        : null,
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

// GET /api/calculations/:id - Optional auth

// ── App settings (ring mode preference) ─────────────────────────────────────
// Mounted at /api/calculations/settings so it works when only this router is updated.
router.get("/settings", optionalAuth, async (_req, res) => {
  try {
    const Settings = require("../models/Settings");
    let doc = await Settings.findOne({ key: "app" }).lean();
    if (!doc) {
      const created = await Settings.create({ key: "app", maxLoadRingMode: "with" });
      doc = created.toObject();
    }
    res.json({
      success: true,
      data: {
        maxLoadRingMode: doc.maxLoadRingMode === "without" ? "without" : "with",
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

router.patch("/settings", requireAdmin, async (req, res) => {
  try {
    const Settings = require("../models/Settings");
    let mode = String(req.body?.maxLoadRingMode || "").toLowerCase();
    if (mode !== "with" && mode !== "without") {
      return res.status(400).json({
        success: false,
        message: 'maxLoadRingMode must be "with" or "without"',
      });
    }
    const doc = await Settings.findOneAndUpdate(
      { key: "app" },
      { $set: { maxLoadRingMode: mode } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    res.json({
      success: true,
      data: {
        maxLoadRingMode: doc.maxLoadRingMode === "without" ? "without" : "with",
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

router.get("/:id", optionalAuth, async (req, res) => {
  try {
    await purgeExpiredTrash();
    const doc = await Calculation.findById(req.params.id).lean();
    if (!doc) {
      return res.status(404).json({ success: false, message: "Not found" });
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

// DELETE /api/calculations/:id - Requires authentication
router.delete("/:id", requireDuty, async (req, res) => {
  try {
    await purgeExpiredTrash();
    const { id } = req.params;
    const permanent = req.query.permanent === "1" || req.query.permanent === "true";

    if (permanent) {
      if (req.admin?.role !== "admin") {
        return res.status(403).json({
          success: false,
          message: "Admin access required to permanently delete",
        });
      }
      const doc = await Calculation.findOneAndDelete({
        _id: id,
        deletedAt: { $ne: null },
      });
      if (!doc) {
        const exists = await Calculation.findById(id).lean();
        if (exists) {
          return res.status(400).json({
            success: false,
            message: "Item is in History. Move to Trash first.",
          });
        }
        return res.status(404).json({
          success: false,
          message: "Not found",
        });
      }
      return res.json({
        success: true,
        message: "Permanently deleted",
      });
    }

    const doc = await Calculation.findOneAndUpdate(
      {
        _id: id,
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      },
      { $set: { deletedAt: new Date() } },
      { new: true }
    );

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: "Not found or already in trash",
      });
    }

    res.json({
      success: true,
      message: "Moved to trash",
      data: doc,
    });
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
// - { action: 'restore' } → restore from trash
// - calculation fields → full update of active record
router.patch("/:id", requireDuty, async (req, res) => {
  try {
    await purgeExpiredTrash();
    const { id } = req.params;
    const body = req.body || {};

    if (body.action === "restore") {
      const doc = await Calculation.findOneAndUpdate(
        { _id: id, deletedAt: { $ne: null } },
        { $set: { deletedAt: null } },
        { new: true }
      );

      if (!doc) {
        return res.status(404).json({
          success: false,
          message: "Not found in trash",
        });
      }

      return res.json({
        success: true,
        message: "Restored",
        data: doc,
      });
    }

    // Full update of an existing (non-trashed) calculation
    const { busVoltages, feeders, bottail11kV, totalMW, note } = body;
    if (
      !busVoltages ||
      busVoltages.bus1 == null ||
      busVoltages.bus2 == null ||
      !Array.isArray(feeders)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Missing required fields: busVoltages and feeders (or use { action: 'restore' })",
      });
    }

    const normalizedFeeders = feeders.map((f) => ({
      id: f.id,
      name: f.name,
      bus: f.bus,
      amps: Number(f.amps) || 0,
      mw: Number(f.mw) || 0,
      lsMW: Math.max(0, Number(f.lsMW) || 0),
      ringActive: f.ringActive === true,
    }));

    const allotmentRaw = body.allotment;
    const allotmentNum =
      allotmentRaw === null || allotmentRaw === undefined || allotmentRaw === ""
        ? null
        : Number(allotmentRaw);
    const allotmentVal =
      allotmentNum != null && Number.isFinite(allotmentNum) && allotmentNum >= 0
        ? allotmentNum
        : null;

    const fields = {
      busVoltages: {
        bus1: Number(busVoltages.bus1),
        bus2: Number(busVoltages.bus2),
      },
      feeders: normalizedFeeders,
      bottail11kV: Number(bottail11kV) || 0,
      totalMW: Number(totalMW) || 0,
      allotment: allotmentVal,
      hasActiveRing: normalizedFeeders.some((f) => f.ringActive === true),
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
      {
        _id: id,
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      },
      { $set: fields },
      { new: true }
    );

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: "Not found or in trash",
      });
    }

    return res.json({
      success: true,
      message: "Updated",
      data: doc,
    });
  } catch (err) {
    console.error("Restore error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to restore",
      error: clientError(err),
    });
  }
});

module.exports = router;