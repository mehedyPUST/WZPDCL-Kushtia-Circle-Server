const express = require("express");
const CircleLoadEntry = require("../models/CircleLoadEntry");
const Calculation = require("../models/Calculation");
const Admin = require("../models/Admin");
const Settings = require("../models/Settings");
const {
  requireAuth,
  requireDuty,
  requireAdmin,
  optionalAuth,
  normalizeRole,
} = require("../middleware/auth");
const {
  CIRCLE_STATIONS,
  isSlotEditable,
  isActiveSlot,
  dayKeyDhaka,
  DEFAULT_RELAXED,
  editLockState,
  EDIT_LOCK_MINUTES,
} = require("../lib/circleStations");

const router = express.Router();

function toNum(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isRelaxedMsg(hourSlot, opts) {
  if ((opts.relaxedSlots || []).includes(hourSlot)) {
    return `Relaxed slot ${hourSlot} is closed after ${opts.relaxUntil} (today)`;
  }
  return `Slot ${hourSlot} is closed (open ±50% of time to neighbouring slots)`;
}

function publicEntry(doc) {
  if (!doc) return null;
  const o = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return {
    id: String(o._id),
    dayKey: o.dayKey,
    hourSlot: o.hourSlot,
    stationId: o.stationId,
    actualLoad: o.actualLoad,
    pgcbAllotment: o.pgcbAllotment,
    loadshed: o.loadshed,
    pbsLoad: o.pbsLoad,
    pbsAllotment: o.pbsAllotment,
    pbsLoadshed: o.pbsLoadshed,
    note: o.note || "",
    source: o.source || "manual",
    firstSubmittedAt: o.firstSubmittedAt || null,
    updatedByUsername: o.updatedByUsername || "",
    updatedAt: o.updatedAt,
  };
}

async function pullBottailFromCalculations(dayKey, hourSlot) {
  const dayStart = new Date(`${dayKey}T00:00:00+06:00`);
  const dayEnd = new Date(`${dayKey}T24:00:00+06:00`);
  const docs = await Calculation.find({
    hourSlot: String(hourSlot).trim(),
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    calculatedAt: { $gte: dayStart, $lt: dayEnd },
  })
    .sort({ calculatedAt: -1 })
    .limit(1)
    .lean();

  if (!docs.length) return null;
  const c = docs[0];
  const total = Number(c.totalMW);
  if (!Number.isFinite(total)) return null;

  const entry = await CircleLoadEntry.findOneAndUpdate(
    { dayKey, hourSlot: String(hourSlot).trim(), stationId: "bottail" },
    {
      $set: {
        actualLoad: total,
        source: "calculator",
        note: c.note || "From Bottail calculator",
        updatedByUsername: c.updatedByUsername || c.createdByUsername || "",
      },
      $setOnInsert: {
        dayKey,
        hourSlot: String(hourSlot).trim(),
        stationId: "bottail",
        pgcbAllotment: null,
        loadshed: null,
        pbsLoad: null,
        pbsAllotment: null,
        pbsLoadshed: null,
      },
    },
    { upsert: true, new: true }
  );
  return entry;
}

/**
 * Batch-sync Bottail from calculator for multiple calendar days.
 * One query + parallel upserts instead of N sequential find+update pairs.
 */
async function pullBottailForDays(dayKeys) {
  const keys = [...new Set((dayKeys || []).filter(Boolean))];
  if (keys.length === 0) return;

  const ranges = keys.map((dayKey) => ({
    dayKey,
    start: new Date(`${dayKey}T00:00:00+06:00`),
    end: new Date(`${dayKey}T24:00:00+06:00`),
  }));

  const docs = await Calculation.find({
    hourSlot: { $ne: null, $exists: true },
    $and: [
      { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
      {
        $or: ranges.map((r) => ({
          calculatedAt: { $gte: r.start, $lt: r.end },
        })),
      },
    ],
  })
    .sort({ calculatedAt: -1 })
    .select("hourSlot calculatedAt totalMW note updatedByUsername createdByUsername")
    .lean();

  // Latest calculation per dayKey|hourSlot
  const best = new Map();
  for (const c of docs) {
    const slot = String(c.hourSlot || "").trim();
    if (!slot) continue;
    const t = c.calculatedAt ? new Date(c.calculatedAt).getTime() : 0;
    let dayKey = null;
    for (const r of ranges) {
      if (t >= r.start.getTime() && t < r.end.getTime()) {
        dayKey = r.dayKey;
        break;
      }
    }
    if (!dayKey) continue;
    const k = `${dayKey}|${slot}`;
    if (!best.has(k)) best.set(k, c);
  }

  const ops = [];
  for (const [k, c] of best) {
    const [dayKey, hourSlot] = k.split("|");
    const total = Number(c.totalMW);
    if (!Number.isFinite(total)) continue;
    ops.push(
      CircleLoadEntry.findOneAndUpdate(
        { dayKey, hourSlot, stationId: "bottail" },
        {
          $set: {
            actualLoad: total,
            source: "calculator",
            note: c.note || "From Bottail calculator",
            updatedByUsername:
              c.updatedByUsername || c.createdByUsername || "",
          },
          $setOnInsert: {
            dayKey,
            hourSlot,
            stationId: "bottail",
            pgcbAllotment: null,
            loadshed: null,
            pbsLoad: null,
            pbsAllotment: null,
            pbsLoadshed: null,
          },
        },
        { upsert: true }
      )
    );
  }
  if (ops.length) await Promise.all(ops);
}

/** GET /api/circle-load/stations */
router.get("/stations", optionalAuth, (_req, res) => {
  res.json({ success: true, data: CIRCLE_STATIONS });
});

/** GET /api/circle-load/sheet?day=&slot= */
router.get("/sheet", optionalAuth, async (req, res) => {
  try {
    const dayKey = String(req.query.day || dayKeyDhaka()).slice(0, 10);
    const hourSlot = String(req.query.slot || "").trim();
    if (!hourSlot) {
      return res.status(400).json({ success: false, message: "slot required" });
    }

    // Sync Bottail from calculator for this slot
    await pullBottailFromCalculations(dayKey, hourSlot);

    const rows = await CircleLoadEntry.find({ dayKey, hourSlot }).lean();
    const byStation = {};
    for (const r of rows) byStation[r.stationId] = publicEntry(r);

    let settingsDoc = await Settings.findOne({ key: "app" }).lean();
    const relaxedSlots = settingsDoc?.circleRelaxedSlots?.length
      ? settingsDoc.circleRelaxedSlots
      : DEFAULT_RELAXED;
    const relaxUntil = settingsDoc?.circleRelaxUntil || "12:00";
    const slotOpts = { relaxedSlots, relaxUntil };

    const editable = isSlotEditable(dayKey, hourSlot, new Date(), slotOpts);
    const active = isActiveSlot(dayKey, hourSlot);
    const isRelaxed = relaxedSlots.includes(hourSlot);

    const role = normalizeRole(req.admin?.role);
    let assignedStation = "";
    if (req.admin?.id) {
      const u = await Admin.findById(req.admin.id).select("assignedStation").lean();
      assignedStation = u?.assignedStation || "";
    }

    const canEditStation = (stationId) => {
      if (!req.admin) return false;
      if (!editable) return false;
      // Admin may edit any station including Bottail override
      if (role === "admin") return true;
      // Circle-load-input / duty: assigned station only (never auto-block bottail if assigned — but bottail normally not assigned for input)
      if (role === "circle-load-input" || role === "duty") {
        if (!assignedStation) return false;
        return assignedStation === stationId;
      }
      return false;
    };

    const now = new Date();
    const sheet = CIRCLE_STATIONS.map((s) => {
      const e = byStation[s.id] || {
        dayKey,
        hourSlot,
        stationId: s.id,
        actualLoad: null,
        pgcbAllotment: null,
        loadshed: null,
        pbsLoad: null,
        pbsAllotment: null,
        pbsLoadshed: null,
        source: s.source,
        firstSubmittedAt: null,
      };
      const actual = Number(e.actualLoad) || 0;
      const ls = Number(e.loadshed) || 0;
      const lock = editLockState(e.firstSubmittedAt, now);
      const baseCan = canEditStation(s.id);
      return {
        ...s,
        entry: e,
        demand: actual + ls,
        editLocked: lock.locked,
        unlockAt: lock.unlockAt,
        lockRemainingSec: lock.remainingSec,
        canEdit: baseCan && !lock.locked,
        canEditBase: baseCan,
      };
    });

    const totals = sheet.reduce(
      (acc, r) => {
        acc.actualLoad += Number(r.entry.actualLoad) || 0;
        acc.pgcbAllotment += Number(r.entry.pgcbAllotment) || 0;
        acc.loadshed += Number(r.entry.loadshed) || 0;
        acc.pbsLoad += Number(r.entry.pbsLoad) || 0;
        acc.demand += r.demand || 0;
        return acc;
      },
      { actualLoad: 0, pgcbAllotment: 0, loadshed: 0, pbsLoad: 0, demand: 0 }
    );

    res.json({
      success: true,
      data: {
        dayKey,
        hourSlot,
        editable,
        active,
        isRelaxed,
        relaxedSlots,
        relaxUntil,
        editLockMinutes: EDIT_LOCK_MINUTES,
        assignedStation,
        role,
        stations: sheet,
        totals,
      },
    });
  } catch (err) {
    console.error("circle sheet:", err);
    res.status(500).json({ success: false, message: process.env.NODE_ENV === "production" ? "Request failed" : (err.message || "Failed") });
  }
});

/** POST /api/circle-load/entry — upsert one station row */
router.post("/entry", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const dayKey = String(body.dayKey || "").slice(0, 10);
    const hourSlot = String(body.hourSlot || "").trim();
    const stationId = String(body.stationId || "").trim();

    if (!dayKey || !hourSlot || !stationId) {
      return res.status(400).json({
        success: false,
        message: "dayKey, hourSlot, stationId required",
      });
    }
    if (!CIRCLE_STATIONS.some((s) => s.id === stationId)) {
      return res.status(400).json({ success: false, message: "Invalid station" });
    }
    const role = normalizeRole(req.admin?.role);

    if (stationId === "bottail" && role !== "admin") {
      return res.status(403).json({
        success: false,
        message:
          "Bottail is filled from the Calculator. Only admin can override it here.",
      });
    }

    if (role === "admin") {
      // full access
    } else if (role === "circle-load-input" || role === "duty") {
      const u = await Admin.findById(req.admin.id)
        .select("assignedStation")
        .lean();
      if (!u || u.assignedStation !== stationId) {
        return res.status(403).json({
          success: false,
          message: "You can only edit your assigned station",
        });
      }
    } else {
      return res.status(403).json({
        success: false,
        message: "Not allowed to edit circle load",
      });
    }

    const settingsDoc = await Settings.findOne({ key: "app" }).lean();
    const slotOpts = {
      relaxedSlots: settingsDoc?.circleRelaxedSlots?.length
        ? settingsDoc.circleRelaxedSlots
        : DEFAULT_RELAXED,
      relaxUntil: settingsDoc?.circleRelaxUntil || "12:00",
    };
    if (!isSlotEditable(dayKey, hourSlot, new Date(), slotOpts)) {
      return res.status(409).json({
        success: false,
        message: isRelaxedMsg(hourSlot, slotOpts),
      });
    }

    const existing = await CircleLoadEntry.findOne({
      dayKey,
      hourSlot,
      stationId,
    }).lean();

    const lock = editLockState(existing?.firstSubmittedAt);
    if (lock.locked) {
      return res.status(423).json({
        success: false,
        message: `Edit locked for ${EDIT_LOCK_MINUTES} min after first submit. Try again in ${lock.remainingSec}s.`,
        unlockAt: lock.unlockAt,
        remainingSec: lock.remainingSec,
      });
    }

    const fields = {
      actualLoad: toNum(body.actualLoad),
      pgcbAllotment: toNum(body.pgcbAllotment),
      loadshed: toNum(body.loadshed),
      pbsLoad: toNum(body.pbsLoad),
      pbsAllotment: toNum(body.pbsAllotment),
      pbsLoadshed: toNum(body.pbsLoadshed),
      note: body.note != null ? String(body.note) : "",
      source:
        stationId === "bottail"
          ? role === "admin"
            ? "admin-override"
            : "calculator"
          : "manual",
      updatedBy: req.admin.id,
      updatedByUsername: req.admin.username || "",
    };

    if (!existing?.firstSubmittedAt) {
      fields.firstSubmittedAt = new Date();
    }

    const doc = await CircleLoadEntry.findOneAndUpdate(
      { dayKey, hourSlot, stationId },
      {
        $set: fields,
        $setOnInsert: {
          dayKey,
          hourSlot,
          stationId,
          createdBy: req.admin.id,
          createdByUsername: req.admin.username || "",
        },
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, message: "Saved", data: publicEntry(doc) });
  } catch (err) {
    console.error("circle entry:", err);
    res.status(500).json({ success: false, message: process.env.NODE_ENV === "production" ? "Request failed" : (err.message || "Failed") });
  }
});



/** GET /api/circle-load/district-day?day=YYYY-MM-DD
 * Operational day labelled as `day` runs from previous calendar day at
 * districtDayBoundary through `day` at districtDayBoundary (inclusive).
 * Default boundary 22:00 → prev 22:00 … today 22:00.
 */
router.get("/district-day", optionalAuth, async (req, res) => {
  try {
    let dayKey = String(req.query.day || dayKeyDhaka()).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
      return res.status(400).json({ success: false, message: "Invalid day" });
    }
    // No future operational days
    const todayKey = dayKeyDhaka();
    if (dayKey > todayKey) dayKey = todayKey;

    const { SLOT_ORDER } = require("../lib/circleStations");

    let settingsDoc = await Settings.findOne({ key: "app" }).lean();
    const boundary = settingsDoc?.districtDayBoundary || "22:00";
    const bm = String(boundary).match(/^(\d{1,2}):(\d{2})$/);
    const bHour = bm ? Number(bm[1]) : 22;
    const bMin = bm ? Number(bm[2]) : 0;
    const boundaryLabel = `${String(bHour).padStart(2, "0")}:${String(bMin).padStart(2, "0")}`;

    // previous calendar day
    const [Y, M, D] = dayKey.split("-").map(Number);
    const prevDt = new Date(Date.UTC(Y, M - 1, D - 1));
    const prevKey = `${prevDt.getUTCFullYear()}-${String(prevDt.getUTCMonth() + 1).padStart(2, "0")}-${String(prevDt.getUTCDate()).padStart(2, "0")}`;

    // Ordered slots: prev day from boundary → end of day, then today 00:00 → boundary (incl.)
    function slotMinutes(label) {
      const m = String(label).match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return 0;
      return Number(m[1]) * 60 + Number(m[2]);
    }
    const bMins = bHour * 60 + bMin;

    const windowSlots = [];
    // Previous day: slots with time >= boundary
    for (const s of SLOT_ORDER) {
      if (slotMinutes(s) >= bMins) {
        windowSlots.push({ dayKey: prevKey, hourSlot: s });
      }
    }
    // Today: slots with time <= boundary
    for (const s of SLOT_ORDER) {
      if (slotMinutes(s) <= bMins) {
        windowSlots.push({ dayKey, hourSlot: s });
      }
    }

    // Sync bottail for involved dayKeys (one batch query, not N sequential)
    const daysToSync = [...new Set(windowSlots.map((w) => w.dayKey))];
    try {
      await pullBottailForDays(daysToSync);
    } catch (syncErr) {
      console.warn("district-day bottail sync:", syncErr.message);
    }

    const rows = await CircleLoadEntry.find({
      dayKey: { $in: daysToSync },
      stationId: { $in: ["bottail", "bheramara"] },
    }).lean();

    const byKey = {};
    for (const r of rows) {
      byKey[`${r.dayKey}|${r.stationId}|${r.hourSlot}`] = r;
    }

    const pick = (dk, stationId, hourSlot) => {
      const e = byKey[`${dk}|${stationId}|${hourSlot}`];
      if (!e) {
        return {
          consumption: null,
          loadshed: null,
          allotment: null,
          demand: null,
        };
      }
      const consumption =
        e.actualLoad == null ? null : Number(e.actualLoad);
      const loadshed = e.loadshed == null ? 0 : Number(e.loadshed);
      const demand =
        consumption == null
          ? null
          : consumption + (Number.isFinite(loadshed) ? loadshed : 0);
      let allotment =
        e.pgcbAllotment == null ? null : Number(e.pgcbAllotment);
      if (allotment == null && demand != null) allotment = demand;
      return { consumption, loadshed, allotment, demand };
    };

    const slots = windowSlots.map(({ dayKey: dk, hourSlot }) => {
      const bottail = pick(dk, "bottail", hourSlot);
      const bheramara = pick(dk, "bheramara", hourSlot);
      const sum = (a, b) => {
        if (a == null && b == null) return null;
        return (Number(a) || 0) + (Number(b) || 0);
      };
      const total = {
        consumption: sum(bottail.consumption, bheramara.consumption),
        loadshed: sum(bottail.loadshed, bheramara.loadshed),
        allotment: sum(bottail.allotment, bheramara.allotment),
        demand: sum(bottail.demand, bheramara.demand),
      };
      return {
        dayKey: dk,
        hourSlot,
        /** true when this row belongs to the previous calendar day */
        isPreviousDay: dk === prevKey,
        bottail,
        bheramara,
        total,
      };
    });

    res.json({
      success: true,
      data: {
        dayKey,
        prevDayKey: prevKey,
        boundary: boundaryLabel,
        rangeLabel: `${prevKey} ${boundaryLabel} → ${dayKey} ${boundaryLabel}`,
        district: "Kushtia",
        stations: ["bottail", "bheramara"],
        slots,
      },
    });
  } catch (err) {
    console.error("district-day:", err);
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === "production" ? "Failed to load district load" : (err.message || "Failed to load district load"),
    });
  }
});

module.exports = router;


