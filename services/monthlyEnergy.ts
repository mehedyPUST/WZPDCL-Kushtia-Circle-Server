import Settings from "../models/Settings.js";

export const CORE_FEEDERS = [
  { id: 1, name: "BRB" },
  { id: 2, name: "MRS" },
  { id: 3, name: "Mozompur" },
  { id: 4, name: "Housing" },
  { id: 5, name: "Rajbari" },
  { id: 6, name: "Campus / GIS" },
  { id: 7, name: "Koburhat" },
  { id: 8, name: "H-3" },
  { id: 9, name: "T-3" },
];

export const DEFAULT_METER_OWNERS = ["PDB", "WZPDCL"];

export interface EnergyFeederDef {
  feederId: number;
  feederName: string;
  category: "33kv" | "11kv" | "auxiliary";
  meterOwners: string[];
  hasPeakOffPeak: boolean;
  custom: boolean;
}

function coreFeederDefs(): EnergyFeederDef[] {
  return CORE_FEEDERS.map((f) => ({
    feederId: f.id,
    feederName: f.name,
    category: "33kv",
    meterOwners: [...DEFAULT_METER_OWNERS],
    hasPeakOffPeak: false,
    custom: false,
  }));
}

function normalizeFeederDef(raw: any): EnergyFeederDef | null {
  const feederId = Number(raw?.feederId) || 0;
  if (!feederId) return null;
  const owners = Array.isArray(raw?.meterOwners)
    ? raw.meterOwners.map((o: unknown) => String(o || "").trim()).filter(Boolean)
    : DEFAULT_METER_OWNERS;
  const cat = String(raw?.category || "33kv")
    .trim()
    .toLowerCase();
  const category =
    cat === "11kv" || cat === "auxiliary" || cat === "33kv" ? cat : "33kv";
  return {
    feederId,
    feederName: String(raw?.feederName || `Feeder ${feederId}`).trim(),
    category,
    meterOwners: owners.length ? owners : [...DEFAULT_METER_OWNERS],
    hasPeakOffPeak: !!raw?.hasPeakOffPeak,
    custom:
      raw?.custom !== false && !CORE_FEEDERS.some((c) => c.id === feederId),
  };
}

export function mergeFeederRegistry(stored: any[]): EnergyFeederDef[] {
  const byId = new Map<number, EnergyFeederDef>();
  for (const f of coreFeederDefs()) byId.set(f.feederId, f);

  const hasAux = (Array.isArray(stored) ? stored : []).some(
    (s) => String(s?.category || "").toLowerCase() === "auxiliary"
  );
  if (!hasAux) {
    byId.set(9001, {
      feederId: 9001,
      feederName: "Station Auxiliary",
      category: "auxiliary",
      meterOwners: [...DEFAULT_METER_OWNERS],
      hasPeakOffPeak: false,
      custom: true,
    });
  }

  for (const s of Array.isArray(stored) ? stored : []) {
    const n = normalizeFeederDef(s);
    if (!n) continue;
    if (CORE_FEEDERS.some((c) => c.id === n.feederId)) {
      const existing = byId.get(n.feederId)!;
      byId.set(n.feederId, {
        ...existing,
        feederName: n.feederName || existing.feederName,
        hasPeakOffPeak: n.hasPeakOffPeak,
        meterOwners: n.meterOwners?.length
          ? n.meterOwners
          : existing.meterOwners,
        custom: false,
      });
    } else {
      byId.set(n.feederId, n);
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    const ac = a.category === "33kv" ? 0 : a.category === "11kv" ? 1 : 2;
    const bc = b.category === "33kv" ? 0 : b.category === "11kv" ? 1 : 2;
    if (ac !== bc) return ac - bc;
    const aCore = CORE_FEEDERS.some((c) => c.id === a.feederId) ? 0 : 1;
    const bCore = CORE_FEEDERS.some((c) => c.id === b.feederId) ? 0 : 1;
    if (aCore !== bCore) return aCore - bCore;
    return a.feederId - b.feederId;
  });
}

function makeEmptyRow(f: EnergyFeederDef, owner: string) {
  return {
    feederId: f.feederId,
    feederName: f.feederName,
    category: f.category,
    meterOwner: owner,
    kwh: null,
    kvarh: null,
    avgPf: null,
    hasPeakOffPeak: !!f.hasPeakOffPeak,
    peakKwh: null,
    offPeakKwh: null,
    peakKvarh: null,
    offPeakKvarh: null,
    maxLoadMw: null,
    maxLoadDate: "",
    maxLoadTime: "",
    interruptionCount: null,
    interruptionMinutes: null,
    totalLsMinutes: null,
    rowColor: owner === "PDB" ? "yellow" : owner === "WZPDCL" ? "cyan" : "",
  };
}

export function rowsFromFeeders(feeders: EnergyFeederDef[]) {
  const rows = [];
  for (const f of feeders) {
    const owners =
      Array.isArray(f.meterOwners) && f.meterOwners.length
        ? f.meterOwners
        : DEFAULT_METER_OWNERS;
    for (const owner of owners) {
      rows.push(makeEmptyRow(f, owner));
    }
  }
  return rows;
}

export function ensureRowsForFeeders(
  existingRows: any[],
  feeders: EnergyFeederDef[]
) {
  const existing = Array.isArray(existingRows) ? existingRows : [];
  const key = (fid: unknown, owner: unknown) =>
    `${Number(fid)}::${String(owner || "").toLowerCase()}`;
  const map = new Map<string, any>();
  for (const r of existing) {
    map.set(key(r.feederId, r.meterOwner), r);
  }

  const out = [];
  for (const f of feeders) {
    const owners =
      Array.isArray(f.meterOwners) && f.meterOwners.length
        ? f.meterOwners
        : DEFAULT_METER_OWNERS;
    for (const owner of owners) {
      const k = key(f.feederId, owner);
      const prev = map.get(k);
      if (prev) {
        out.push({
          ...prev,
          feederName: f.feederName || prev.feederName,
          category: f.category || prev.category,
          meterOwner: owner,
          hasPeakOffPeak:
            prev.hasPeakOffPeak != null
              ? !!prev.hasPeakOffPeak
              : !!f.hasPeakOffPeak,
        });
        map.delete(k);
      } else {
        out.push(makeEmptyRow(f, owner));
      }
    }
  }
  return out;
}

export function feedersFromRows(rows: any[]) {
  const byId = new Map<number, any>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = Number(r.feederId) || 0;
    if (!id) continue;
    if (!byId.has(id)) {
      byId.set(id, {
        feederId: id,
        feederName: String(r.feederName || `Feeder ${id}`),
        category: String(r.category || "33kv"),
        meterOwners: [],
        hasPeakOffPeak: !!r.hasPeakOffPeak,
        custom: !CORE_FEEDERS.some((c) => c.id === id),
      });
    }
    const f = byId.get(id);
    if (r.feederName) f.feederName = String(r.feederName);
    if (r.category) f.category = String(r.category);
    if (r.hasPeakOffPeak) f.hasPeakOffPeak = true;
    const owner = String(r.meterOwner || "").trim();
    if (owner && !f.meterOwners.includes(owner)) f.meterOwners.push(owner);
  }
  return Array.from(byId.values());
}

async function getOrCreateSettings() {
  return Settings.findOneAndUpdate(
    { key: "app" },
    { $setOnInsert: { key: "app" } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

export async function loadRegistry(): Promise<EnergyFeederDef[]> {
  const settings = await getOrCreateSettings();
  return mergeFeederRegistry(settings.energyFeeders || []);
}

export async function saveRegistry(feeders: any[]): Promise<EnergyFeederDef[]> {
  const settings = await getOrCreateSettings();
  const normalized = mergeFeederRegistry(feeders);
  settings.energyFeeders = normalized;
  settings.markModified("energyFeeders");
  await settings.save();
  return normalized;
}

const numOrNull = (v: unknown) =>
  v === "" || v == null || Number.isNaN(Number(v)) ? null : Number(v);

export function mapEnergyRows(rowsIn: unknown) {
  return (Array.isArray(rowsIn) ? rowsIn : []).map((r: any) => ({
    feederId: Number(r.feederId) || 0,
    feederName: String(r.feederName || "").trim(),
    meterOwner: String(r.meterOwner || "").trim(),
    category: String(r.category || "").trim(),
    kwh: numOrNull(r.kwh),
    kvarh: numOrNull(r.kvarh),
    avgPf: numOrNull(r.avgPf),
    hasPeakOffPeak: !!r.hasPeakOffPeak,
    peakKwh: numOrNull(r.peakKwh),
    offPeakKwh: numOrNull(r.offPeakKwh),
    peakKvarh: numOrNull(r.peakKvarh),
    offPeakKvarh: numOrNull(r.offPeakKvarh),
    maxLoadMw: numOrNull(r.maxLoadMw),
    maxLoadDate: String(r.maxLoadDate || "").trim(),
    maxLoadTime: String(r.maxLoadTime || "").trim(),
    interruptionCount: numOrNull(r.interruptionCount),
    interruptionMinutes: numOrNull(r.interruptionMinutes),
    totalLsMinutes: numOrNull(r.totalLsMinutes),
    rowColor: String(r.rowColor || "").trim(),
  }));
}

export function serializeMonthlyEnergy(doc: any) {
  if (!doc) return null;
  const o = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return {
    id: o._id?.toString?.() || o.id,
    year: o.year,
    month: o.month,
    stationName: o.stationName || "Bottail SS",
    rows: Array.isArray(o.rows) ? o.rows : [],
    notes: o.notes || "",
    updatedByUsername: o.updatedByUsername || "",
    updatedByDisplayName: o.updatedByDisplayName || "",
    createdAt: o.createdAt || null,
    updatedAt: o.updatedAt || null,
  };
}
