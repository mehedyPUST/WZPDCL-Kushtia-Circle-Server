import {
  addDaysYmd,
  dhakaNowParts,
  shiftFromHour,
} from "../lib/dhakaTime.js";

const PERSON_ALIASES: Record<string, string> = {
  admin: "Mehedy",
  "bottail.mehedy": "Mehedy",
  mehedy: "Mehedy",
  "mehedy/admin": "Mehedy",
  "bottail.mehedy/admin": "Mehedy",
};

function normalizePersonName(raw: unknown): string {
  const s = String(raw || "")
    .trim()
    .replace(/\s+/g, " ");
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

function localPartsFromRecord(record: any) {
  const slot = record?.hourSlot && String(record.hourSlot).trim();
  const raw = record?.calculatedAt || record?.createdAt;
  let base = raw ? new Date(raw) : null;
  if (base && Number.isNaN(base.getTime())) base = null;

  let hour: number | null = null;
  let minute = 0;
  let ymd: string | null = null;

  if (slot && /^\d{1,2}:\d{2}$/.test(slot)) {
    const [hh, mm] = slot.split(":").map(Number);
    hour = hh;
    minute = mm || 0;
  }

  if (base) {
    const dhaka = dhakaNowParts(base);
    ymd = dhaka.ymd;
    if (hour == null) {
      hour = dhaka.hour;
      minute = dhaka.minute;
    }
  }

  if (hour == null || !ymd) return null;
  return { hour, minute, ymd };
}

function classifyDuty(record: any) {
  const parts = localPartsFromRecord(record);
  if (!parts) return null;
  const shift = shiftFromHour(parts.hour);
  const dutyDay =
    shift === "C" && parts.hour <= 8 ? addDaysYmd(parts.ymd, -1) : parts.ymd;
  return { dutyDay, shift, hour: parts.hour };
}

function topOf(counts: Record<string, number>) {
  const entries = Object.entries(counts || {}) as [string, number][];
  if (entries.length === 0) {
    return { person: null, entries: 0, runnersUp: [], all: [] };
  }
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [person, n] = entries[0];
  return {
    person,
    entries: n,
    runnersUp: entries.slice(1, 4).map(([p, e]) => ({ person: p, entries: e })),
    all: entries.map(([p, e]) => ({ person: p, entries: e })),
  };
}

export function buildMonthlyDutyRoster(
  records: any[],
  year: number,
  month: number
) {
  const y = Number(year);
  const m = Number(month);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const byDay: Record<
    string,
    {
      A: Record<string, number>;
      B: Record<string, number>;
      C: Record<string, number>;
    }
  > = {};

  for (let d = 1; d <= daysInMonth; d++) {
    const ymd = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    byDay[ymd] = { A: {}, B: {}, C: {} };
  }

  const personTotals: Record<string, number> = {};
  const personDayShifts: Record<string, Record<string, Set<"A" | "B" | "C">>> =
    {};
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
    byDay[c.dutyDay][c.shift][who] =
      (byDay[c.dutyDay][c.shift][who] || 0) + 1;
    personTotals[who] = (personTotals[who] || 0) + 1;
    classified++;
  }

  const personShiftCounts: Record<string, number> = {};
  for (const ymd of Object.keys(byDay)) {
    for (const sh of ["A", "B", "C"] as const) {
      const top = topOf(byDay[ymd][sh]);
      if (!top.person) continue;
      if (!personDayShifts[top.person]) personDayShifts[top.person] = {};
      if (!personDayShifts[top.person][ymd]) {
        personDayShifts[top.person][ymd] = new Set();
      }
      personDayShifts[top.person][ymd].add(sh);
      personShiftCounts[top.person] =
        (personShiftCounts[top.person] || 0) + 1;
    }
  }

  const allNames = new Set([
    ...Object.keys(personTotals),
    ...Object.keys(personShiftCounts),
  ]);
  const persons = [...allNames]
    .map((person) => ({
      person,
      entries: personTotals[person] || 0,
      shifts: personShiftCounts[person] || 0,
    }))
    .sort(
      (a, b) =>
        b.shifts - a.shifts ||
        b.entries - a.entries ||
        a.person.localeCompare(b.person)
    );

  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const ymd = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const cell = byDay[ymd];
    const byPerson: Record<
      string,
      { shifts: string[]; label: string; entries: number }
    > = {};

    for (const { person } of persons) {
      const set = personDayShifts[person]?.[ymd];
      if (!set || set.size === 0) {
        byPerson[person] = { shifts: [], label: "—", entries: 0 };
        continue;
      }
      const shifts = (["A", "B", "C"] as const).filter((s) => set.has(s));
      let entries = 0;
      for (const s of shifts) entries += cell[s][person] || 0;
      byPerson[person] = {
        shifts,
        label: shifts.map((s) => s.toLowerCase()).join(","),
        entries,
      };
    }

    const utcDate = new Date(Date.UTC(y, m - 1, d));
    days.push({
      day: d,
      ymd,
      dateLabel: utcDate.toLocaleDateString("en-GB", {
        timeZone: "UTC",
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
      weekday: utcDate.toLocaleDateString("en-GB", {
        timeZone: "UTC",
        weekday: "short",
      }),
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

  const shiftLeaders: Record<"A" | "B" | "C", Record<string, number>> = {
    A: {},
    B: {},
    C: {},
  };
  for (const day of days) {
    for (const sh of ["A", "B", "C"] as const) {
      const dutyPerson = day[sh]?.person;
      if (!dutyPerson) continue;
      shiftLeaders[sh][dutyPerson] =
        (shiftLeaders[sh][dutyPerson] || 0) + 1;
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
      C: {
        id: "C",
        label: "C Shift",
        window: "21:00 – 08:00 (+1)",
        hours: "21–08",
      },
    },
  };
}
