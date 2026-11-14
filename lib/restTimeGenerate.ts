/**
 * Night-log load generation for Bottail 33/11 kV SS (WZPDCL, Kushtia).
 *
 * Local algorithm (used when AI is off or unavailable):
 *  - Piecewise interpolation between operator anchors (start / end / optional mid)
 *  - Feeder-class profiles: residential dip overnight, industrial/outgoing stable
 *  - Fajr-timed trough (month table for Bangladesh latitudes)
 *  - Friday BRB mosque / early-morning reduction
 *  - Bus voltage inverse-to-load with practical ceilings
 *  - Deterministic micro-noise so consecutive nights are not identical clones
 *
 * AI path (Groq API — gsk_ key) is seeded with this local result and only allowed to
 * refine intermediate hours; anchors always stay operator-owned.
 */
import { FEEDERS } from "./constants.js";

export const DEFAULT_NIGHT_START = "00:00";
export const DEFAULT_NIGHT_END = "08:00";

/** @deprecated prefer buildNightWindow() */
export const REST_HOURS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
/** @deprecated */
export const REST_SLOT_LABELS = REST_HOURS.map(
  (h) => `${String(h).padStart(2, "0")}:00`
);
/** @deprecated */
export const REQUIRED_SLOTS = ["00:00", "08:00"];
/** @deprecated */
export const OPTIONAL_REST_SLOTS = [
  "01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00",
];
export const PREV_CONTEXT_SLOTS = ["22:00", "23:00"];

/** Residential / mixed town feeders — stronger overnight dip */
export const RESIDENTIAL_IDS = new Set([3, 4, 5, 6]); // Mozompur, Housing, Rajbari, Campus/GIS
/** Industrial / outgoing 33 kV — flatter night profile */
export const STABLE_IDS = new Set([1, 2, 7, 8, 9]); // BRB, MRS, Koburhat, H-3, T-3

/** Practical 33 kV bus ceilings at light load (operator guidance) */
export const BUS1_MAX_KV = 36.0;
export const BUS2_MAX_KV = 35.6;

/**
 * Per-feeder night behaviour coefficients (tuned for Bottail SS practice).
 * dipStrength: how hard the feeder follows the residential night trough (0–1)
 * morningRamp: extra lift approaching the end anchor (0–1)
 * minFloorRatio: never drop below this fraction of the lighter endpoint
 */
const FEEDER_PROFILE = {
  1: { dipStrength: 0.06, morningRamp: 0.08, minFloorRatio: 0.55, note: "BRB industrial" },
  2: { dipStrength: 0.05, morningRamp: 0.06, minFloorRatio: 0.60, note: "MRS industrial" },
  3: { dipStrength: 0.28, morningRamp: 0.18, minFloorRatio: 0.35, note: "Mozompur residential" },
  4: { dipStrength: 0.30, morningRamp: 0.20, minFloorRatio: 0.32, note: "Housing residential" },
  5: { dipStrength: 0.26, morningRamp: 0.16, minFloorRatio: 0.35, note: "Rajbari mixed" },
  6: { dipStrength: 0.24, morningRamp: 0.14, minFloorRatio: 0.38, note: "Campus/GIS" },
  7: { dipStrength: 0.08, morningRamp: 0.10, minFloorRatio: 0.50, note: "Koburhat outgoing" },
  8: { dipStrength: 0.10, morningRamp: 0.12, minFloorRatio: 0.45, note: "H-3 group" },
  9: { dipStrength: 0.10, morningRamp: 0.12, minFloorRatio: 0.45, note: "T-3 group" },
};

function parseHour(label) {
  const m = String(label || "").match(/^(\d{1,2}):/);
  return m ? Number(m[1]) : null;
}

function hourLabel(h) {
  return `${String(((h % 24) + 24) % 24).padStart(2, "0")}:00`;
}

/**
 * Build ordered hour list and required/optional slots for a night window.
 */
export function buildNightWindow(
  startSlot = DEFAULT_NIGHT_START,
  endSlot = DEFAULT_NIGHT_END
) {
  let startH = parseHour(startSlot);
  let endH = parseHour(endSlot);
  if (startH == null) startH = 0;
  if (endH == null) endH = 8;
  startH = ((startH % 24) + 24) % 24;
  endH = ((endH % 24) + 24) % 24;

  const hours = [];
  if (startH <= endH) {
    for (let h = startH; h <= endH; h++) hours.push(h);
  } else {
    for (let h = startH; h <= 23; h++) hours.push(h);
    for (let h = 0; h <= endH; h++) hours.push(h);
  }
  if (hours.length < 2) {
    return buildNightWindow(DEFAULT_NIGHT_START, DEFAULT_NIGHT_END);
  }
  const labels = hours.map(hourLabel);
  return {
    hours,
    labels,
    requiredSlots: [labels[0], labels[labels.length - 1]],
    optionalSlots: labels.slice(1, -1),
    startSlot: labels[0],
    endSlot: labels[labels.length - 1],
  };
}

/** Approximate Fajr hour (decimal) for Kushtia / central Bangladesh by month */
export function approximateFajrHour(month) {
  const m = Math.min(12, Math.max(1, month || 1));
  const table = {
    1: 5.55,
    2: 5.35,
    3: 5.05,
    4: 4.55,
    5: 4.25,
    6: 4.05,
    7: 4.15,
    8: 4.40,
    9: 4.65,
    10: 4.95,
    11: 5.20,
    12: 5.45,
  };
  return table[m] ?? 5.0;
}

function parseSlotHour(label) {
  return parseHour(label);
}

function isFridayYmd(ymd) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay() === 5;
}

/** Deterministic noise in [-1, 1] from day + feeder + hour */
function noise01(dayKey, feederId, hour) {
  const s = `${dayKey}|${feederId}|${hour}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 5000 - 1;
}

/** Linear interpolation across known hour→value map */
function interpKnown(known, hour) {
  const keys = Object.keys(known)
    .map(Number)
    .filter((h) => Number.isFinite(known[h]))
    .sort((a, b) => a - b);
  if (keys.length === 0) return 0;
  if (keys.length === 1) return known[keys[0]];
  if (hour <= keys[0]) return known[keys[0]];
  if (hour >= keys[keys.length - 1]) return known[keys[keys.length - 1]];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (hour >= a && hour <= b) {
      const t = (hour - a) / (b - a || 1);
      // smoothstep for gentler night curve
      const s = t * t * (3 - 2 * t);
      return known[a] + (known[b] - known[a]) * s;
    }
  }
  return known[keys[keys.length - 1]];
}

/**
 * Night shape in [-1, 0]: 0 at window ends, deepest trough near Fajr.
 * Positive return values are not used; callers treat this as a dip multiplier.
 */
function nightDipShape(hour, startH, endH, fajrH) {
  // Normalize hour position in [0, 1] along the window (handles wrap)
  const hours = [];
  if (startH <= endH) {
    for (let h = startH; h <= endH; h++) hours.push(h);
  } else {
    for (let h = startH; h <= 23; h++) hours.push(h);
    for (let h = 0; h <= endH; h++) hours.push(h);
  }
  const idx = hours.indexOf(hour);
  if (idx <= 0 || idx >= hours.length - 1) return 0;
  const t = idx / (hours.length - 1); // 0 → 1 across window

  // Map Fajr into window position (approximate)
  let fajrIdx = hours.findIndex((h) => h >= Math.floor(fajrH));
  if (fajrIdx < 0) fajrIdx = Math.floor(hours.length * 0.55);
  const trough = Math.max(0.25, Math.min(0.75, fajrIdx / (hours.length - 1)));

  // Two-lobe: deepen toward trough, recover toward morning
  if (t <= trough) {
    const u = t / trough;
    return -Math.sin((u * Math.PI) / 2);
  }
  const u = (t - trough) / (1 - trough || 1);
  return -Math.cos((u * Math.PI) / 2);
}

/**
 * Extra morning recovery factor [0, 1] in the last ~30% of the window.
 */
function morningRampShape(hour, startH, endH) {
  const hours = [];
  if (startH <= endH) {
    for (let h = startH; h <= endH; h++) hours.push(h);
  } else {
    for (let h = startH; h <= 23; h++) hours.push(h);
    for (let h = 0; h <= endH; h++) hours.push(h);
  }
  const idx = hours.indexOf(hour);
  if (idx < 0) return 0;
  const t = idx / (hours.length - 1 || 1);
  if (t < 0.65) return 0;
  return (t - 0.65) / 0.35;
}

function sumAmps(ampsMap) {
  let s = 0;
  FEEDERS.forEach((f) => {
    const v = parseFloat(ampsMap?.[f.id] ?? ampsMap?.[String(f.id)]);
    if (Number.isFinite(v) && v > 0) s += v;
  });
  return s;
}

/**
 * Voltage rises when load falls. Uses anchors + inverse-load lift, capped.
 */
function predictBusKv({
  hour,
  totalAmps,
  knownBus,
  loadByHour,
  maxKv,
  startH,
  endH,
  fajrH,
}) {
  if (knownBus[hour] != null) {
    return Math.round(Number(knownBus[hour]) * 100) / 100;
  }

  const base = interpKnown(knownBus, hour);
  if (!base || base <= 0) {
    return Math.round(Math.min(maxKv, 33.4) * 100) / 100;
  }

  const loads = (Object.values(loadByHour) as number[]).filter((x) => x > 0);
  const loadRef = loads.length ? Math.max(...loads) : totalAmps || 1;
  const loadNow = totalAmps || loadRef;
  const relief = Math.max(0, Math.min(1, 1 - loadNow / (loadRef || 1)));

  const keys = Object.keys(knownBus)
    .map(Number)
    .filter((h) => Number.isFinite(knownBus[h]));
  const vFloor = keys.length
    ? Math.min(...keys.map((h) => knownBus[h]), base)
    : base;
  const headroom = Math.max(0, maxKv - vFloor);
  const dipBoost =
    Math.abs(nightDipShape(hour, startH, endH, fajrH)) * 0.4 + 0.6;
  const lift = headroom * relief * 0.8 * dipBoost;
  const v = base + lift;
  return (
    Math.round(Math.min(maxKv, Math.max(vFloor * 0.995, v)) * 100) / 100
  );
}

/**
 * Generate intermediate night hours from required end anchors (+ optional mids).
 */
export function generateRestTimeData({
  dayKey,
  slots = {},
  startSlot = DEFAULT_NIGHT_START,
  endSlot = DEFAULT_NIGHT_END,
  bus1MaxKv = BUS1_MAX_KV,
  bus2MaxKv = BUS2_MAX_KV,
}: {
  dayKey?: string;
  slots?: Record<string, any>;
  startSlot?: string;
  endSlot?: string;
  bus1MaxKv?: number;
  bus2MaxKv?: number;
} = {}) {
  const window = buildNightWindow(startSlot, endSlot);
  const hours = window.hours;
  const required = window.requiredSlots;
  const startH = hours[0];
  const endH = hours[hours.length - 1];
  const month = dayKey ? Number(dayKey.split("-")[1]) : new Date().getMonth() + 1;
  const fajrH = approximateFajrHour(month);
  const friday = isFridayYmd(dayKey);

  if (!slots[required[0]] || !slots[required[1]]) {
    throw new Error(`${required[0]} and ${required[1]} data are required`);
  }

  const knownByFeeder = {};
  const knownBus1 = {};
  const knownBus2 = {};
  FEEDERS.forEach((f) => {
    knownByFeeder[f.id] = {};
  });

  // Ingest anchors across the full window labels (+ any prev context if passed)
  const ingestLabels = [
    ...new Set([...PREV_CONTEXT_SLOTS, ...window.labels, ...Object.keys(slots || {})]),
  ];
  for (const label of ingestLabels) {
    const block = slots[label];
    if (!block) continue;
    const hour = parseSlotHour(label);
    if (hour == null) continue;
    FEEDERS.forEach((f) => {
      const v = parseFloat(block.amps?.[f.id] ?? block.amps?.[String(f.id)]);
      if (Number.isFinite(v) && v >= 0) knownByFeeder[f.id][hour] = v;
    });
    const b1 = parseFloat(block.bus1);
    const b2 = parseFloat(block.bus2);
    if (Number.isFinite(b1) && b1 > 0) knownBus1[hour] = b1;
    if (Number.isFinite(b2) && b2 > 0) knownBus2[hour] = b2;
  }

  const startKey = startH;
  const endKey = endH;
  if (
    !FEEDERS.some((f) => knownByFeeder[f.id][startKey] != null) ||
    !FEEDERS.some((f) => knownByFeeder[f.id][endKey] != null)
  ) {
    throw new Error(
      `Enter feeder amps for both ${required[0]} and ${required[1]}`
    );
  }

  // ── First pass: amps ──────────────────────────────────────────
  const ampRows = {};
  const sourceRows = {};
  const loadByHour = {};

  for (const hour of hours) {
    const label = hourLabel(hour);
    const amps = {};
    const source = {};

    FEEDERS.forEach((f) => {
      const known = knownByFeeder[f.id];
      if (known[hour] != null) {
        amps[f.id] = Math.round(known[hour]);
        source[f.id] = "anchor";
        return;
      }

      const profile = FEEDER_PROFILE[f.id] || {
        dipStrength: 0.15,
        morningRamp: 0.1,
        minFloorRatio: 0.4,
      };

      // Smooth interpolation between nearest anchors
      let base = interpKnown(known, hour);

      const aStart = known[startKey];
      const aEnd = known[endKey];
      const lightEnd =
        aStart != null && aEnd != null
          ? Math.min(aStart, aEnd)
          : aStart ?? aEnd ?? base;
      const scaleRef =
        aStart != null && aEnd != null
          ? (aStart + aEnd) / 2
          : aStart ?? aEnd ?? base;

      // Night trough (residential-weighted)
      const dip = nightDipShape(hour, startH, endH, fajrH); // [-1, 0]
      base = base + dip * Math.max(0, scaleRef) * profile.dipStrength;

      // Morning recovery toward end anchor
      const ramp = morningRampShape(hour, startH, endH);
      if (aEnd != null && scaleRef > 0) {
        const pull = (aEnd - base) * ramp * profile.morningRamp;
        base = base + pull;
      }

      // Deterministic micro-variation (±1.5–2.5%) so nights aren't clones
      const n = noise01(dayKey || "d", f.id, hour);
      const noiseAmp = RESIDENTIAL_IDS.has(f.id) ? 0.02 : 0.012;
      base = base * (1 + n * noiseAmp);

      // Floor: never collapse below a realistic fraction of the lighter endpoint
      if (lightEnd > 0) {
        base = Math.max(base, lightEnd * profile.minFloorRatio);
      }

      // Friday special: BRB (id 1) often near-zero around Jumu'ah morning path
      // Operators historically zero BRB by ~07:00 on Fridays when plant offline
      if (friday && f.id === 1) {
        if (hour >= 7) base = 0;
        else if (hour === 6) base = base * 0.35;
        else if (hour === 5) base = base * 0.75;
      }

      amps[f.id] = Math.max(0, Math.round(base));
      source[f.id] = "predicted";
    });

    ampRows[label] = amps;
    sourceRows[label] = source;
    loadByHour[hour] = sumAmps(amps);
  }

  // ── Second pass: voltages inverse to station load ─────────────
  const out = {};
  for (const hour of hours) {
    const label = hourLabel(hour);
    const amps = ampRows[label];
    const totalAmps = loadByHour[hour];
    const bus1 = predictBusKv({
      hour,
      totalAmps,
      knownBus: knownBus1,
      loadByHour,
      maxKv: bus1MaxKv,
      startH,
      endH,
      fajrH,
    });
    const bus2 = predictBusKv({
      hour,
      totalAmps,
      knownBus: knownBus2,
      loadByHour,
      maxKv: bus2MaxKv,
      startH,
      endH,
      fajrH,
    });
    out[label] = {
      amps,
      bus1,
      bus2,
      source: sourceRows[label],
      busSource: {
        bus1: knownBus1[hour] != null ? "anchor" : "predicted",
        bus2: knownBus2[hour] != null ? "anchor" : "predicted",
      },
    };
  }

  return {
    slots: out,
    meta: {
      dayKey,
      friday,
      fajrHour: fajrH,
      requiredOk: true,
      bus1Max: bus1MaxKv,
      bus2Max: bus2MaxKv,
      startSlot: window.startSlot,
      endSlot: window.endSlot,
      requiredSlots: required,
      engine: "local-v2",
    },
  };
}
