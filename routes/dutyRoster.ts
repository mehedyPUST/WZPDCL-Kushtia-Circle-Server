const express = require("express");
const Calculation = require("../models/Calculation");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

function addDaysYmd(ymd, delta) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function shiftFromHour(hour) {
  const h = Number(hour);
  if (h >= 9 && h <= 14) return "A";
  if (h >= 15 && h <= 20) return "B";
  return "C";
}

const PERSON_ALIASES = {
  admin: "Mehedy",
  "bottail.mehedy": "Mehedy",
  mehedy: "Mehedy",
  "mehedy/admin": "Mehedy",
  "bottail.mehedy/admin": "Mehedy",
};

function normalizePersonName(raw) {
  const s = String(raw || "").trim().replace(/\s+/g, " ");
  if (!s) return "Unknown";
  const key = s.toLowerCase();
  if (PERSON_ALIASES[key]) return PERSON_ALIASES[key];
  const noSlash = key.split("/")[0];
  if (PERSON_ALIASES[noSlash]) return PERSON_ALIASES[noSlash];
  if (s === s.toLowerCase() && s.length <= 24 && !s.includes(".")) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  return s;
}

function localPartsFromRecord(record) {
  const slot = record?.hourSlot && String(record.hourSlot).trim();
  const raw = record?.calculatedAt || record?.createdAt;
  let base = raw ? new Date(raw) : null;
  if (base && Number.isNaN(base.getTime())) base = null;

  let hour = null;
  let minute = 0;
  let ymd = null;

  if (slot && /^\d{1,2}:\d{2}$/.test(slot)) {
    const [hh, mm] = slot.split(":").map(Number);
    hour = hh;
    minute = mm || 0;
  }

  if (base) {
    try {
      ymd = base.toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
      if (hour == null) {
        const parts = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Dhaka",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).formatToParts(base);
        hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
        minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
      }
    } catch {
      /* ignore */
    }
  }

  if (hour == null) return null;
  if (!ymd && base) ymd = base.toISOString().slice(0, 10);
  if (!ymd) return null;
  return { hour, minute, ymd };
}

function classifyDuty(record) {
  const parts = localPartsFromRecord(record);
  if (!parts) return null;
  const shift = shiftFromHour(parts.hour);
  let dutyDay = parts.ymd;
  if (shift === "C" && parts.hour <= 8) dutyDay = addDaysYmd(parts.ymd, -1);
  return { dutyDay, shift, hour: parts.hour };
}

function topOf(counts) {
  const entries = Object.entries(counts || {});
  if (entries.length === 0) return { person: null, entries: 0, runnersUp: [], all: [] };
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [person, n] = entries[0];
  return {
    person,
    entries: n,
    runnersUp: entries.slice(1, 4).map(([p, e]) => ({ person: p, entries: e })),
    all: entries.map(([p, e]) => ({ person: p, entries: e })),
  };
}

function buildMonthlyDutyRoster(records, year, month) {
  const y = Number(year);
  const m = Number(month);
  const daysInMonth = new Date(y, m, 0).getDate();
  const byDay = {};
  for (let d = 1; d <= daysInMonth; d++) {
    const ymd = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    byDay[ymd] = { A: {}, B: {}, C: {} };
  }
  const personTotals = {};
  const personDayShifts = {};
  let classified = 0;
  let skipped = 0;

  for (const rec of records || []) {
    const c = classifyDuty(rec);
    if (!c || !byDay[c.dutyDay]) {
      skipped++;
      continue;
    }
    const who = normalizePersonName(
      (rec.createdByUsername && String(rec.createdByUsername).trim()) ||
        (rec.createdBy && String(rec.createdBy)) ||
        "Unknown"
    );
    byDay[c.dutyDay][c.shift][who] = (byDay[c.dutyDay][c.shift][who] || 0) + 1;
    personTotals[who] = (personTotals[who] || 0) + 1;
    classified++;
  }

  // Duty = max entries per shift/day
  const personShiftCounts = {};
  for (const ymd of Object.keys(byDay)) {
    for (const sh of ["A", "B", "C"]) {
      const top = topOf(byDay[ymd][sh]);
      if (!top.person) continue;
      if (!personDayShifts[top.person]) personDayShifts[top.person] = {};
      if (!personDayShifts[top.person][ymd]) personDayShifts[top.person][ymd] = new Set();
      personDayShifts[top.person][ymd].add(sh);
      personShiftCounts[top.person] = (personShiftCounts[top.person] || 0) + 1;
    }
  }

  const allNames = new Set([...Object.keys(personTotals), ...Object.keys(personShiftCounts)]);
  const persons = [...allNames]
    .map((person) => ({
      person,
      entries: personTotals[person] || 0,
      shifts: personShiftCounts[person] || 0,
    }))
    .sort((a, b) => b.shifts - a.shifts || b.entries - a.entries || a.person.localeCompare(b.person));

  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const ymd = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const cell = byDay[ymd];
    const byPerson = {};
    for (const { person } of persons) {
      const set = personDayShifts[person]?.[ymd];
      if (!set || set.size === 0) {
        byPerson[person] = { shifts: [], label: "—", entries: 0 };
        continue;
      }
      const shifts = ["A", "B", "C"].filter((s) => set.has(s));
      let entries = 0;
      for (const s of shifts) entries += cell[s][person] || 0;
      byPerson[person] = {
        shifts,
        label: shifts.map((s) => s.toLowerCase()).join(","),
        entries,
      };
    }
    days.push({
      day: d,
      ymd,
      dateLabel: new Date(y, m - 1, d).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
      weekday: new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "short" }),
      byPerson,
      A: topOf(cell.A),
      B: topOf(cell.B),
      C: topOf(cell.C),
      totalEntries:
        Object.values(cell.A).reduce((s, n) => s + n, 0) +
        Object.values(cell.B).reduce((s, n) => s + n, 0) +
        Object.values(cell.C).reduce((s, n) => s + n, 0),
    });
  }

  const leaderboard = persons
    .filter((p) => p.shifts > 0)
    .map((p) => ({ person: p.person, shifts: p.shifts, entries: p.entries }));

  const shiftLeaders = { A: {}, B: {}, C: {} };
  for (const day of days) {
    for (const sh of ["A", "B", "C"]) {
      const dutyPerson = day[sh]?.person;
      if (!dutyPerson) continue;
      shiftLeaders[sh][dutyPerson] = (shiftLeaders[sh][dutyPerson] || 0) + 1;
    }
  }

  return {
    year: y,
    month: m,
    daysInMonth,
    classified,
    skipped,
    persons,
    days,
    leaderboard,
    shiftLeaders: {
      A: topOf(shiftLeaders.A),
      B: topOf(shiftLeaders.B),
      C: topOf(shiftLeaders.C),
    },
    shifts: {
      A: { id: "A", label: "A Shift", window: "09:00 – 14:00", hours: "9–14" },
      B: { id: "B", label: "B Shift", window: "15:00 – 20:00", hours: "15–20" },
      C: { id: "C", label: "C Shift", window: "21:00 – 08:00 (+1)", hours: "21–08" },
    },
  };
}

function dayBoundsFromYmd(ymd) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  const OFFSET_MS = 6 * 60 * 60 * 1000;
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - OFFSET_MS);
  const end = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0) - OFFSET_MS);
  return { start, end };
}

// GET /api/admin/duty-roster?year=&month=
router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    let year = parseInt(String(req.query.year || ""), 10);
    let month = parseInt(String(req.query.month || ""), 10);
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      year = Number(now.toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" }).slice(0, 4));
    }
    if (!Number.isFinite(month) || month < 1 || month > 12) {
      month = Number(now.toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" }).slice(5, 7));
    }

    const from = addDaysYmd(`${year}-${String(month).padStart(2, "0")}-01`, -1);
    const last = new Date(year, month, 0).getDate();
    const to = addDaysYmd(
      `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`,
      1
    );
    const fromB = dayBoundsFromYmd(from);
    const toB = dayBoundsFromYmd(to);

    const eventAt = { $ifNull: ["$calculatedAt", "$createdAt"] };
    const filter = {
      $and: [
        { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
        {
          $expr: {
            $and: [{ $gte: [eventAt, fromB.start] }, { $lt: [eventAt, toB.end] }],
          },
        },
      ],
    };

    const records = await Calculation.find(filter)
      .select("hourSlot calculatedAt createdAt createdBy createdByUsername totalMW isHourly")
      .lean()
      .limit(20000);

    const roster = buildMonthlyDutyRoster(records, year, month);

    res.json({
      success: true,
      data: roster,
      meta: { from, to, recordCount: records.length },
    });
  } catch (err) {
    console.error("duty-roster error:", err);
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === "production" ? "Failed to load duty roster" : err.message,
    });
  }
});

module.exports = router;
