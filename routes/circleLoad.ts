import express, { type Request, type Response } from "express";
import CircleLoadEntry from "../models/CircleLoadEntry.js";
import Calculation from "../models/Calculation.js";
import Admin from "../models/Admin.js";
import Settings from "../models/Settings.js";
import {
  normalizeRole,
  optionalAuth,
  requireAuth,
} from "../middleware/auth.js";
import {
  CIRCLE_STATIONS,
  DEFAULT_RELAXED,
  EDIT_LOCK_MINUTES,
  SLOT_ORDER,
  dayKeyDhaka,
  editLockState,
  isActiveSlot,
  isSlotEditable,
} from "../lib/circleStations.js";
import { addDaysYmd } from "../lib/dhakaTime.js";
import { clientError } from "../lib/errors.js";

const router = express.Router();

const YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function toNum(v: unknown): number | null {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isRelaxedMsg(
  hourSlot: string,
  opts: { relaxedSlots: string[]; relaxUntil: string }
): string {
  if ((opts.relaxedSlots || []).includes(hourSlot)) {
    return `Relaxed slot ${hourSlot} is closed after ${opts.relaxUntil} (today)`;
  }
  return `Slot ${hourSlot} is closed (open ±50% of time to neighbouring slots)`;
}

function publicEntry(doc: any) {
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

async function pullBottailFromCalculations(dayKey: string, hourSlot: string) {
  const slot = String(hourSlot).trim();
  const existing = await CircleLoadEntry.findOne({
    dayKey,
    hourSlot: slot,
    stationId: "bottail",
  }).lean<{ source?: string }>();
  if (existing?.source === "admin-override") {
    return existing;
  }

  const dayStart = new Date(`${dayKey}T00:00:00+06:00`);
  const dayEnd = new Date(`${dayKey}T24:00:00+06:00`);
  const docs = await Calculation.find({
    hourSlot: slot,
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    calculatedAt: { $gte: dayStart, $lt: dayEnd },
  })
    .sort({ calculatedAt: -1 })
    .limit(1)
    .lean<any[]>();

  if (!docs.length) return null;
  const c = docs[0];
  const total = Number(c.totalMW);
  if (!Number.isFinite(total)) return null;

  return CircleLoadEntry.findOneAndUpdate(
    { dayKey, hourSlot: slot, stationId: "bottail" },
    {
      $set: {
        actualLoad: total,
        source: "calculator",
        note: c.note || "From Bottail calculator",
        updatedByUsername: c.updatedByUsername || c.createdByUsername || "",
      },
      $setOnInsert: {
        dayKey,
        hourSlot: slot,
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
}

async function pullBottailForDays(dayKeys: string[]) {
  const keys = [...new Set((dayKeys || []).filter(Boolean))];
  if (keys.length === 0) return;

  const ranges = keys.map((dayKey) => ({
    dayKey,
    start: new Date(`${dayKey}T00:00:00+06:00`),
    end: new Date(`${dayKey}T24:00:00+06:00`),
  }));

  const [docs, overrides] = await Promise.all([
    Calculation.find({
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
      .select(
        "hourSlot calculatedAt totalMW note updatedByUsername createdByUsername"
      )
      .lean<any[]>(),
    CircleLoadEntry.find({
      dayKey: { $in: keys },
      stationId: "bottail",
      source: "admin-override",
    })
      .select("dayKey hourSlot")
      .lean<{ dayKey: string; hourSlot: string }[]>(),
  ]);

  const overrideKeys = new Set(
    overrides.map((o) => `${o.dayKey}|${o.hourSlot}`)
  );

  const best = new Map<string, any>();
  for (const c of docs) {
    const slot = String(c.hourSlot || "").trim();
    if (!slot) continue;
    const t = c.calculatedAt ? new Date(c.calculatedAt).getTime() : 0;
    const range = ranges.find(
      (r) => t >= r.start.getTime() && t < r.end.getTime()
    );
    if (!range) continue;
    const k = `${range.dayKey}|${slot}`;
    if (!best.has(k) && !overrideKeys.has(k)) best.set(k, c);
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
router.get("/stations", optionalAuth, (_req: Request, res: Response) => {
  res.json({ success: true, data: CIRCLE_STATIONS });
});

/** GET /api/circle-load/sheet?day=&slot= */
router.get("/sheet", optionalAuth, async (req: Request, res: Response) => {
  try {
    const dayKey = String(req.query.day || dayKeyDhaka()).slice(0, 10);
    const hourSlot = String(req.query.slot || "").trim();

    if (!YMD_REGEX.test(dayKey)) {
      res.status(400).json({ success: false, message: "Invalid day" });
      return;
    }
    if (!hourSlot) {
      res.status(400).json({ success: false, message: "slot required" });
      return;
    }

    await pullBottailFromCalculations(dayKey, hourSlot);

    const [rows, settingsDoc] = await Promise.all([
      CircleLoadEntry.find({ dayKey, hourSlot }).lean<any[]>(),
      Settings.findOne({ key: "app" }).lean<{
        circleRelaxedSlots?: string[];
        circleRelaxUntil?: string;
      }>(),
    ]);

    const byStation: Record<string, any> = {};
    for (const r of rows) byStation[r.stationId] = publicEntry(r);

    const relaxedSlots = settingsDoc?.circleRelaxedSlots?.length
      ? settingsDoc.circleRelaxedSlots
      : DEFAULT_RELAXED;
    const relaxUntil = settingsDoc?.circleRelaxUntil || "12:00";
    const slotOpts = { relaxedSlots, relaxUntil };

    const now = new Date();
    const editable = isSlotEditable(dayKey, hourSlot, now, slotOpts);
    const active = isActiveSlot(dayKey, hourSlot, now, slotOpts);
    const isRelaxed = relaxedSlots.includes(hourSlot);

    const role = normalizeRole(req.admin?.role);
    let assignedStation = req.admin?.assignedStation || "";
    if (!assignedStation && req.admin?.id) {
      const u = await Admin.findById(req.admin.id)
        .select("assignedStation")
        .lean<{ assignedStation?: string }>();
      assignedStation = u?.assignedStation || "";
    }

    const canEditStation = (stationId: string) => {
      if (!req.admin || !editable) return false;
      if (role === "admin") return true;
      // Bottail consumption is calculator-driven; duty / circle-load-input
      // may still enter loadshed + allotment for the active slot.
      if (stationId === "bottail") {
        return role === "circle-load-input" || role === "duty";
      }
      if (role === "circle-load-input" || role === "duty") {
        return Boolean(assignedStation) && assignedStation === stationId;
      }
      return false;
    };

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
    res.status(500).json({
      success: false,
      message: clientError(err) || "Request failed",
    });
  }
});

/** POST /api/circle-load/entry — upsert one station row */
router.post("/entry", requireAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const dayKey = String(body.dayKey || "").slice(0, 10);
    const hourSlot = String(body.hourSlot || "").trim();
    const stationId = String(body.stationId || "").trim();

    if (!dayKey || !hourSlot || !stationId) {
      res.status(400).json({
        success: false,
        message: "dayKey, hourSlot, stationId required",
      });
      return;
    }
    if (!YMD_REGEX.test(dayKey)) {
      res.status(400).json({ success: false, message: "Invalid dayKey" });
      return;
    }
    if (!CIRCLE_STATIONS.some((s) => s.id === stationId)) {
      res.status(400).json({ success: false, message: "Invalid station" });
      return;
    }

    const role = normalizeRole(req.admin?.role);

    if (role !== "admin") {
      if (stationId === "bottail") {
        // Non-admin: may submit loadshed + allotment only (consumption stays calculated).
        if (role !== "circle-load-input" && role !== "duty") {
          res.status(403).json({
            success: false,
            message:
              "Bottail consumption is filled from the Calculator. Only duty / circle-load-input can enter LS and allotment.",
          });
          return;
        }
      } else if (role === "circle-load-input" || role === "duty") {
        let station = req.admin?.assignedStation;
        if (station === undefined && req.admin?.id) {
          const u = await Admin.findById(req.admin.id)
            .select("assignedStation")
            .lean<{ assignedStation?: string }>();
          station = u?.assignedStation;
        }
        if (!station || station !== stationId) {
          res.status(403).json({
            success: false,
            message: "You can only edit your assigned station",
          });
          return;
        }
      } else {
        res.status(403).json({
          success: false,
          message: "Not allowed to edit circle load",
        });
        return;
      }
    }

    const settingsDoc = await Settings.findOne({ key: "app" }).lean<{
      circleRelaxedSlots?: string[];
      circleRelaxUntil?: string;
    }>();
    const slotOpts = {
      relaxedSlots: settingsDoc?.circleRelaxedSlots?.length
        ? settingsDoc.circleRelaxedSlots
        : DEFAULT_RELAXED,
      relaxUntil: settingsDoc?.circleRelaxUntil || "12:00",
    };

    if (!isSlotEditable(dayKey, hourSlot, new Date(), slotOpts)) {
      res.status(409).json({
        success: false,
        message: isRelaxedMsg(hourSlot, slotOpts),
      });
      return;
    }

    const existing = await CircleLoadEntry.findOne({
      dayKey,
      hourSlot,
      stationId,
    }).lean<{ firstSubmittedAt?: Date }>();

    const lock = editLockState(existing?.firstSubmittedAt);
    if (lock.locked) {
      res.status(423).json({
        success: false,
        message: `Edit locked for ${EDIT_LOCK_MINUTES} min after first submit. Try again in ${lock.remainingSec}s.`,
        unlockAt: lock.unlockAt,
        remainingSec: lock.remainingSec,
      });
      return;
    }

    // Consumption + LS → demand. Allotment optional; empty ⇒ demand (editable always on client).
    const consumptionIn = toNum(body.actualLoad);
    const loadshedIn = toNum(body.loadshed);
    const loadshedVal = loadshedIn == null ? 0 : loadshedIn;
    let allotmentIn = toNum(body.pgcbAllotment);

    let actualLoadVal = consumptionIn;
    let sourceVal: string =
      stationId === "bottail"
        ? role === "admin"
          ? "admin-override"
          : "calculator"
        : "manual";

    if (stationId === "bottail" && role !== "admin") {
      // Keep calculator consumption; only LS / allotment / note may change.
      const prior = await CircleLoadEntry.findOne({
        dayKey,
        hourSlot,
        stationId,
      }).lean<{ actualLoad?: number | null; source?: string }>();
      if (prior?.actualLoad != null && Number.isFinite(Number(prior.actualLoad))) {
        actualLoadVal = Number(prior.actualLoad);
      } else {
        await pullBottailFromCalculations(dayKey, hourSlot);
        const again = await CircleLoadEntry.findOne({
          dayKey,
          hourSlot,
          stationId,
        }).lean<{ actualLoad?: number | null }>();
        actualLoadVal =
          again?.actualLoad != null && Number.isFinite(Number(again.actualLoad))
            ? Number(again.actualLoad)
            : null;
      }
      sourceVal = "calculator";
    }

    const demandVal =
      actualLoadVal == null ? null : Number(actualLoadVal) + Number(loadshedVal || 0);
    if (allotmentIn == null && demandVal != null) {
      allotmentIn = demandVal;
    }

    const pbsCons = toNum(body.pbsLoad);
    const pbsLs = toNum(body.pbsLoadshed);
    const pbsLsVal = pbsLs == null ? 0 : pbsLs;
    let pbsAllot = toNum(body.pbsAllotment);
    const pbsDemand =
      pbsCons == null ? null : Number(pbsCons) + Number(pbsLsVal || 0);
    if (pbsAllot == null && pbsDemand != null) {
      pbsAllot = pbsDemand;
    }

    const fields: Record<string, any> = {
      actualLoad: actualLoadVal,
      pgcbAllotment: allotmentIn,
      loadshed: loadshedVal,
      pbsLoad: pbsCons,
      pbsAllotment: pbsAllot,
      pbsLoadshed: pbsLs,
      note: body.note != null ? String(body.note) : "",
      source: sourceVal,
      updatedBy: req.admin!.id,
      updatedByUsername: req.admin!.username || "",
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
          createdBy: req.admin!.id,
          createdByUsername: req.admin!.username || "",
        },
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, message: "Saved", data: publicEntry(doc) });
  } catch (err) {
    console.error("circle entry:", err);
    res.status(500).json({
      success: false,
      message: clientError(err) || "Request failed",
    });
  }
});

function slotMinutes(label: string): number {
  const m = String(label).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** GET /api/circle-load/district-day?day=YYYY-MM-DD */
router.get(
  "/district-day",
  optionalAuth,
  async (req: Request, res: Response) => {
    try {
      let dayKey = String(req.query.day || dayKeyDhaka()).slice(0, 10);
      if (!YMD_REGEX.test(dayKey)) {
        res.status(400).json({ success: false, message: "Invalid day" });
        return;
      }

      const todayKey = dayKeyDhaka();
      if (dayKey > todayKey) dayKey = todayKey;

      const settingsDoc = await Settings.findOne({ key: "app" }).lean<{
        districtDayBoundary?: string;
      }>();
      const boundary = settingsDoc?.districtDayBoundary || "22:00";
      const bm = String(boundary).match(/^(\d{1,2}):(\d{2})$/);
      const bHour = bm ? Number(bm[1]) : 22;
      const bMin = bm ? Number(bm[2]) : 0;
      const boundaryLabel = `${String(bHour).padStart(2, "0")}:${String(bMin).padStart(2, "0")}`;

      const prevKey = addDaysYmd(dayKey, -1);
      const bMins = bHour * 60 + bMin;

      const windowSlots: { dayKey: string; hourSlot: string }[] = [];
      for (const s of SLOT_ORDER) {
        if (slotMinutes(s) >= bMins) {
          windowSlots.push({ dayKey: prevKey, hourSlot: s });
        }
      }
      for (const s of SLOT_ORDER) {
        if (slotMinutes(s) <= bMins) {
          windowSlots.push({ dayKey, hourSlot: s });
        }
      }

      const daysToSync = [...new Set(windowSlots.map((w) => w.dayKey))];
      try {
        await pullBottailForDays(daysToSync);
      } catch (syncErr) {
        console.warn(
          "district-day bottail sync:",
          syncErr instanceof Error ? syncErr.message : syncErr
        );
      }

      const rows = await CircleLoadEntry.find({
        dayKey: { $in: daysToSync },
        stationId: { $in: ["bottail", "bheramara"] },
      }).lean<any[]>();

      const byKey: Record<string, any> = {};
      for (const r of rows) {
        byKey[`${r.dayKey}|${r.stationId}|${r.hourSlot}`] = r;
      }

      const pick = (dk: string, stationId: string, hourSlot: string) => {
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

      const sumOpt = (a: number | null, b: number | null) => {
        if (a == null && b == null) return null;
        return (Number(a) || 0) + (Number(b) || 0);
      };

      const slots = windowSlots.map(({ dayKey: dk, hourSlot }) => {
        const bottail = pick(dk, "bottail", hourSlot);
        const bheramara = pick(dk, "bheramara", hourSlot);
        return {
          dayKey: dk,
          hourSlot,
          isPreviousDay: dk === prevKey,
          bottail,
          bheramara,
          total: {
            consumption: sumOpt(bottail.consumption, bheramara.consumption),
            loadshed: sumOpt(bottail.loadshed, bheramara.loadshed),
            allotment: sumOpt(bottail.allotment, bheramara.allotment),
            demand: sumOpt(bottail.demand, bheramara.demand),
          },
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
        message: clientError(err) || "Failed to load district load",
      });
    }
  }
);

export default router;
