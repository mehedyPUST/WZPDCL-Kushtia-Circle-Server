const express = require("express");
const MonthlyEnergyReading = require("../models/MonthlyEnergyReading");
const Settings = require("../models/Settings");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

const CORE_FEEDERS = [
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

const DEFAULT_METER_OWNERS = ["PDB", "WZPDCL"];

function coreFeederDefs() {
  return CORE_FEEDERS.map((f) => ({
    feederId: f.id,
    feederName: f.name,
    category: "33kv",
    meterOwners: [...DEFAULT_METER_OWNERS],
    hasPeakOffPeak: false,
    custom: false,
  }));
}

function normalizeFeederDef(raw) {
  const feederId = Number(raw?.feederId) || 0;
  if (!feederId) return null;
  const owners = Array.isArray(raw?.meterOwners)
    ? raw.meterOwners.map((o) => String(o || "").trim()).filter(Boolean)
    : DEFAULT_METER_OWNERS;
  const cat = String(raw?.category || "33kv").trim().toLowerCase();
  const category =
    cat === "11kv" || cat === "auxiliary" || cat === "33kv" ? cat : "33kv";
  return {
    feederId,
    feederName: String(raw?.feederName || `Feeder ${feederId}`).trim(),
    category,
    meterOwners: owners.length ? owners : [...DEFAULT_METER_OWNERS],
    hasPeakOffPeak: !!raw?.hasPeakOffPeak,
    custom: raw?.custom !== false && !CORE_FEEDERS.some((c) => c.id === feederId),
  };
}

/** Merge core + stored custom feeders; custom overrides by id. */
function mergeFeederRegistry(stored) {
  const byId = new Map();
  for (const f of coreFeederDefs()) byId.set(f.feederId, f);
  // Always keep a starter auxiliary if none custom aux exists
  const hasAux = (Array.isArray(stored) ? stored : []).some(
    (s) => String(s.category || "").toLowerCase() === "auxiliary"
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
    // Never let custom overwrite core ids' custom:false
    if (CORE_FEEDERS.some((c) => c.id === n.feederId)) {
      byId.set(n.feederId, {
        ...byId.get(n.feederId),
        feederName: n.feederName || byId.get(n.feederId).feederName,
        hasPeakOffPeak: n.hasPeakOffPeak,
        meterOwners: n.meterOwners?.length
          ? n.meterOwners
          : byId.get(n.feederId).meterOwners,
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

function rowsFromFeeders(feeders) {
  const rows = [];
  for (const f of feeders) {
    const owners =
      Array.isArray(f.meterOwners) && f.meterOwners.length
        ? f.meterOwners
        : DEFAULT_METER_OWNERS;
    for (const owner of owners) {
      rows.push({
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
        rowColor:
          owner === "PDB" ? "yellow" : owner === "WZPDCL" ? "cyan" : "",
      });
    }
  }
  return rows;
}

/**
 * Ensure month rows include every registry feeder (empty values if new).
 * Keep readings that already exist.
 */
function ensureRowsForFeeders(existingRows, feeders) {
  const existing = Array.isArray(existingRows) ? existingRows : [];
  const key = (fid, owner) => `${Number(fid)}::${String(owner || "").toLowerCase()}`;
  const map = new Map();
  for (const r of existing) {
    map.set(key(r.feederId, r.meterOwner), r);
  }
  const out = [];
  for (const f of feeders) {
    const owners =
      Array.isArray(f.meterOwners) && f.meterOwners.length
        ? f.meterOwners
        : DEFAULT_METER_OWNERS;
    owners.forEach((owner, idx) => {
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
        out.push({
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
          maxLoadMw: idx === 0 ? null : null,
          maxLoadDate: "",
          maxLoadTime: "",
          interruptionCount: null,
          interruptionMinutes: null,
          totalLsMinutes: null,
          rowColor:
            owner === "PDB" ? "yellow" : owner === "WZPDCL" ? "cyan" : "",
        });
      }
    });
  }
  // Keep orphan readings (removed feeders) only if still useful — drop them
  // so registry is the single source of feeder list across months.
  return out;
}

function feedersFromRows(rows) {
  const byId = new Map();
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
  let doc = await Settings.findOne({ key: "app" });
  if (!doc) doc = await Settings.create({ key: "app" });
  return doc;
}

async function loadRegistry() {
  const settings = await getOrCreateSettings();
  return mergeFeederRegistry(settings.energyFeeders || []);
}

async function saveRegistry(feeders) {
  const settings = await getOrCreateSettings();
  const normalized = mergeFeederRegistry(feeders);
  // Persist only custom (and peak flags / renames for core)
  settings.energyFeeders = normalized;
  settings.markModified("energyFeeders");
  await settings.save();
  return normalized;
}

function serialize(doc) {
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

const numOrNull = (v) =>
  v === "" || v == null || Number.isNaN(Number(v)) ? null : Number(v);

function mapRows(rowsIn) {
  return (Array.isArray(rowsIn) ? rowsIn : []).map((r) => ({
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

router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    let year = parseInt(String(req.query.year || ""), 10);
    let month = parseInt(String(req.query.month || ""), 10);
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      year = now.getFullYear();
    }
    if (!Number.isFinite(month) || month < 1 || month > 12) {
      month = now.getMonth() + 1;
    }

    let feeders = await loadRegistry();

    // Bootstrap registry from any existing month rows (one-time enrichment)
    const sample = await MonthlyEnergyReading.findOne().sort({ updatedAt: -1 });
    if (sample && Array.isArray(sample.rows) && sample.rows.length) {
      const fromRows = feedersFromRows(sample.rows);
      const before = feeders.length;
      feeders = mergeFeederRegistry([...feeders, ...fromRows]);
      if (feeders.length !== before) {
        await saveRegistry(feeders);
      }
    }

    let doc = await MonthlyEnergyReading.findOne({ year, month });
    if (!doc) {
      doc = await MonthlyEnergyReading.create({
        year,
        month,
        stationName: "Bottail SS",
        rows: rowsFromFeeders(feeders),
        notes: "",
      });
    } else {
      // Align sheet rows to global registry so new feeders appear every month
      const aligned = ensureRowsForFeeders(doc.rows, feeders);
      const changed =
        JSON.stringify(aligned.map((r) => [r.feederId, r.meterOwner])) !==
        JSON.stringify((doc.rows || []).map((r) => [r.feederId, r.meterOwner]));
      if (changed) {
        doc.rows = aligned;
        await doc.save();
      }
    }

    res.json({
      success: true,
      sheet: serialize(doc),
      feeders,
    });
  } catch (err) {
    console.error("[monthly-energy GET]", err);
    res.status(500).json({
      success: false,
      message: err?.message || "Failed to load sheet",
    });
  }
});

router.put("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    let year = parseInt(String(req.body?.year ?? ""), 10);
    let month = parseInt(String(req.body?.month ?? ""), 10);
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      return res
        .status(400)
        .json({ success: false, message: "Valid year is required" });
    }
    if (!Number.isFinite(month) || month < 1 || month > 12) {
      return res
        .status(400)
        .json({ success: false, message: "Valid month is required" });
    }

    const rows = mapRows(req.body?.rows);
    const admin = req.admin || {};
    const username = admin.username || "";
    const displayName = admin.displayName || admin.username || "";
    const notes = String(req.body?.notes || "").trim();

    // Global feeder registry (all months)
    let feeders;
    if (Array.isArray(req.body?.feeders)) {
      feeders = await saveRegistry(req.body.feeders);
    } else {
      // Derive from saved rows and merge into registry
      const derived = feedersFromRows(rows);
      const current = await loadRegistry();
      feeders = await saveRegistry([...current, ...derived]);
    }

    const alignedRows = ensureRowsForFeeders(rows, feeders);

    const doc = await MonthlyEnergyReading.findOneAndUpdate(
      { year, month },
      {
        $set: {
          rows: alignedRows,
          notes,
          stationName: "Bottail SS",
          updatedByUsername: username,
          updatedByDisplayName: displayName,
        },
        $setOnInsert: { year, month },
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, sheet: serialize(doc), feeders });
  } catch (err) {
    console.error("[monthly-energy PUT]", err);
    res.status(500).json({
      success: false,
      message: err?.message || "Failed to save sheet",
    });
  }
});

module.exports = router;
