/**
 * Feeder definitions for Bottail 33/11 kV Substation
 * bus: 1 → BUS-1 voltage, 2 → BUS-2 voltage
 *
 * BRB, MRS → participate in load shed (same as other feeders)
 * H-3, T-3 → H3+T3 group (participate in LS)
 * Others → outgoing 33 kV to remote SS (participate in LS)
 *
 * Campus and GIS are the SAME feeder (alternate names only) → id 6.
 */
export const FEEDERS = [
  { id: 1, name: "BRB", bus: 2 },
  { id: 2, name: "MRS", bus: 1 },
  { id: 3, name: "Mozompur", bus: 2 },
  { id: 4, name: "Housing", bus: 1 },
  { id: 5, name: "Rajbari", bus: 1 },
  { id: 6, name: "Campus / GIS", bus: 2 },
  { id: 7, name: "Koburhat", bus: 2 },
  { id: 8, name: "H-3", bus: 1 },
  { id: 9, name: "T-3", bus: 2 },
];

/**
 * Stable feeder colors (match CSS --feeder-N tokens).
 * Use for charts, legends, and row accents in JS.
 */
export const FEEDER_COLORS = {
  1: "#2563eb", // BRB
  2: "#10b981", // MRS
  3: "#8b5cf6", // Mozompur
  4: "#ec4899", // Housing
  5: "#f97316", // Rajbari
  6: "#06b6d4", // Campus / GIS
  7: "#eab308", // Koburhat
  8: "#6366f1", // H-3
  9: "#ef4444", // T-3
};

/** Ordered series for Recharts / stats */
export const CHART_COLORS = [
  "#2563eb",
  "#ef4444",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#94a3b8",
];

export const BUS_COLORS = {
  1: "#2563eb",
  2: "#f59e0b",
};

export const STATUS_COLORS = {
  normal: "#10b981",
  high: "#f59e0b",
  overload: "#ef4444",
  shed: "#ef4444",
  offline: "#64748b",
  live: "#10b981",
  ring: "#8b5cf6",
};

/** H3+T3 = sum of feeders H-3 (id 8) + T-3 (id 9) — included in load shed */
export const BOTTAIL_11KV_IDS = [8, 9];

/**
 * Feeders excluded from proportional load-shed.
 * Empty = all feeders (including BRB & MRS) are loadshedable.
 */
export const LS_PROTECTED_IDS = [];

/** Feeders that never operate a ring line */
export const NO_RING_FEEDER_IDS = [1, 2]; // BRB, MRS

/**
 * Ring-line topology (Bottail SS)
 *
 * INTERNAL chain (Campus ≡ GIS — one feeder, id 6):
 *   Mozompur ↔ Housing ↔ Campus/GIS
 *   Campus/GIS ↔ Housing ↔ Mozompur
 *   Mozompur ↔ Campus/GIS DIRECT is NOT possible (must go through Housing).
 *
 * Power on internal rings still comes from Bottail, but not always on the
 * regular radial meter. Receiving leg often ~0; intermediate/partner rises.
 *
 * EXTERNAL (partner outside Bottail grid):
 *   Koburhat ↔ Alomdanga
 *   Rajbari  ↔ Pangsha
 *
 * BUS COUPLER:
 *   H-3 ↔ T-3 — one TX can feed both 11 kV sides when the other is shutdown.
 */
export const RING_LINES = [
  {
    id: "mozompur-housing",
    type: "internal",
    feederIds: [3, 4],
    label: "Mozompur ↔ Housing",
    partner: "Housing",
    note:
      "Ring still from Bottail. Receiving feeder ~0; Housing/Mozompur partner rises. " +
      "May chain Housing → Campus/GIS.",
  },
  {
    id: "housing-campus-gis",
    type: "internal",
    feederIds: [4, 6],
    label: "Housing ↔ Campus/GIS",
    partner: "Campus/GIS · Housing",
    note:
      "Campus and GIS are the same feeder. No direct Mozompur ↔ Campus/GIS.",
  },
  {
    id: "koburhat-alomdanga",
    type: "external",
    feederIds: [7],
    label: "Koburhat ↔ Alomdanga",
    partner: "Alomdanga",
    note:
      "Share→Alomdanga raises Bottail load. Take←Alomdanga → Koburhat input 0.",
  },
  {
    id: "rajbari-pangsha",
    type: "external",
    feederIds: [5],
    label: "Rajbari ↔ Pangsha",
    partner: "Pangsha",
    note:
      "Share→Pangsha can raise load. Take←Pangsha → Rajbari input 0.",
  },
  {
    id: "h3-t3-coupler",
    type: "bus_coupler",
    feederIds: [8, 9],
    label: "H-3 ↔ T-3 (bus coupler)",
    partner: "H-3 / T-3 via bus coupler",
    note:
      "One TX shutdown: the other feeds both 11 kV sides via coupler. " +
      "Individual H-3/T-3 max = own feeders only (coupler OFF). " +
      "Bottail 11 kV total max always uses combined H3+T3 load.",
  },
];

/**
 * Direct ring partners only (no Mozompur↔Campus/GIS).
 * Housing partners with both Mozompur and Campus/GIS.
 */
export const RING_BY_FEEDER = (() => {
  const map = {};
  for (const line of RING_LINES) {
    for (const fid of line.feederIds) {
      if (NO_RING_FEEDER_IDS.includes(fid)) continue;
      if (!map[fid]) {
        map[fid] = {
          partner: line.partner,
          labels: [line.label],
          type: line.type,
          partnerFeederIds: line.feederIds.filter((id) => id !== fid),
          canRing: true,
        };
      } else {
        map[fid].labels.push(line.label);
        map[fid].partner = map[fid].labels.join(" · ");
        for (const id of line.feederIds) {
          if (id !== fid && !map[fid].partnerFeederIds.includes(id)) {
            map[fid].partnerFeederIds.push(id);
          }
        }
        if (line.type === "internal" || line.type === "bus_coupler") {
          map[fid].type = line.type === "bus_coupler" ? "bus_coupler" : map[fid].type || line.type;
        }
      }
    }
  }
  return map;
})();

/** Partner feeder IDs that distort this feeder's meter when ring is on */
export function getRingPartnerIds(feederId) {
  const id = Number(feederId);
  if (NO_RING_FEEDER_IDS.includes(id)) return [];
  const info = RING_BY_FEEDER[id];
  if (!info) return [];
  return info.partnerFeederIds || [];
}

export function feederAllowsRing(feederId) {
  const id = Number(feederId);
  if (NO_RING_FEEDER_IDS.includes(id)) return false;
  return !!RING_BY_FEEDER[id]?.canRing;
}

/**
 * True if two feeders may be directly ring-tied.
 * Mozompur (3) and Campus/GIS (6) → false (only via Housing).
 */
export function canDirectRing(feederIdA, feederIdB) {
  const a = Number(feederIdA);
  const b = Number(feederIdB);
  if (a === b) return false;
  // Explicit: no Mozompur ↔ Campus/GIS
  if ((a === 3 && b === 6) || (a === 6 && b === 3)) return false;
  for (const line of RING_LINES) {
    if (line.feederIds.includes(a) && line.feederIds.includes(b)) return true;
  }
  return false;
}

/** MW = (√3 × V_kV × PF × I_A) / 1000 */
export const POWER_FACTOR = 0.95;

export const APP_META = {
  title: "WZPDCL Load Calculator | Bottail-Kushtia",
  shortTitle: "WZPDCL - Bottail-Kushtia",
  subtitle: "33/11 kV Power Substation",
  tagline: "Load Calculator Dashboard",
  footer: "© All Rights Reserved · SBA-Bottail, WZPDCL",
  logoUrl: "/logo.png",
  logoFallbackUrl: "https://i.ibb.co.com/sL3vSkg/Logo.png",
};
