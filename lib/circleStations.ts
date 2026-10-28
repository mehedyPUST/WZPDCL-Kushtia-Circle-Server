/** Kushtia circle grid stations */
const CIRCLE_STATIONS = [
  {
    id: "bottail",
    name: "Bottail (Kushtia)",
    source: "calculator",
    note: "Filled from Calculator / Manual hourly saves",
  },
  { id: "jhinaidah", name: "Jhinaidah", source: "manual" },
  { id: "kaligonj", name: "Kaligonj", source: "manual" },
  { id: "bheramara", name: "Bheramara", source: "manual" },
  { id: "chuadanga", name: "Chuadanga", source: "manual" },
];

const SLOT_ORDER = (() => {
  const slots = [];
  for (let h = 0; h < 24; h++) {
    slots.push(`${String(h).padStart(2, "0")}:00`);
    if (h === 18) slots.push("18:30");
    if (h === 19) slots.push("19:30");
  }
  return slots;
})();

const DEFAULT_RELAXED = [
  "01:00",
  "02:00",
  "03:00",
  "04:00",
  "05:00",
  "06:00",
  "07:00",
  "08:00",
];

/** Minutes after first submit before edit is allowed again */
const EDIT_LOCK_MINUTES = 10;

const OFFSET_MS = 6 * 60 * 60 * 1000;

function dayKeyDhaka(d = new Date()) {
  const shifted = new Date(d.getTime() + OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function slotInstantUtc(dayKey, hourSlot) {
  const m = String(hourSlot || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(String(dayKey || ""))) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const [Y, M, D] = String(dayKey).split("-").map(Number);
  return new Date(Date.UTC(Y, M - 1, D, hh, mm, 0, 0) - OFFSET_MS);
}

function shiftDayKey(dayKey, delta) {
  const [Y, M, D] = dayKey.split("-").map(Number);
  const nd = new Date(Date.UTC(Y, M - 1, D + delta));
  return `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, "0")}-${String(nd.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Slot open window (Dhaka wall clock on dayKey).
 *
 * Special rules:
 * - 19:00 → open 18:30 … 19:30
 * - 18:30 → open 18:00 for 60 min (until 19:00)
 * - 19:30 → open 19:00 for 60 min (until 20:00)
 *
 * Other full-hour slots: open 30 min before until 30 min after (half hour each side).
 * Relaxed 01:00–08:00: open until relaxUntil (default 12:00) same day.
 */
function getSlotWindow(dayKey, hourSlot, opts = {}) {
  const slotAt = slotInstantUtc(dayKey, hourSlot);
  if (!slotAt) return null;

  const relaxed = Array.isArray(opts.relaxedSlots)
    ? opts.relaxedSlots
    : DEFAULT_RELAXED;
  const relaxUntil = String(opts.relaxUntil || "12:00");

  if (relaxed.includes(hourSlot)) {
    const openAt = slotInstantUtc(dayKey, "00:00");
    const closeAt = slotInstantUtc(dayKey, relaxUntil);
    return { openAt, closeAt, kind: "relaxed" };
  }

  if (hourSlot === "19:00") {
    return {
      openAt: slotInstantUtc(dayKey, "18:30"),
      closeAt: slotInstantUtc(dayKey, "19:30"),
      kind: "special-19:00",
    };
  }
  if (hourSlot === "18:30") {
    const openAt = slotInstantUtc(dayKey, "18:00");
    return {
      openAt,
      closeAt: new Date(openAt.getTime() + 60 * 60 * 1000),
      kind: "half-hour",
    };
  }
  if (hourSlot === "19:30") {
    const openAt = slotInstantUtc(dayKey, "19:00");
    return {
      openAt,
      closeAt: new Date(openAt.getTime() + 60 * 60 * 1000),
      kind: "half-hour",
    };
  }

  // Standard hour: ±30 minutes
  return {
    openAt: new Date(slotAt.getTime() - 30 * 60 * 1000),
    closeAt: new Date(slotAt.getTime() + 30 * 60 * 1000),
    kind: "hour",
  };
}

function isSlotEditable(dayKey, hourSlot, now = new Date(), opts = {}) {
  const w = getSlotWindow(dayKey, hourSlot, opts);
  if (!w || !w.openAt || !w.closeAt) return false;
  const t = now.getTime();
  return t >= w.openAt.getTime() - 500 && t < w.closeAt.getTime() + 500;
}

function isActiveSlot(dayKey, hourSlot, now = new Date(), opts = {}) {
  const today = dayKeyDhaka(now);
  if (dayKey !== today) return false;
  return isSlotEditable(dayKey, hourSlot, now, {
    ...opts,
    relaxedSlots: [], // active highlight ignores relaxed all-day window
  });
}

/**
 * After first submit, fields locked for EDIT_LOCK_MINUTES.
 * Returns { locked, unlockAt, remainingSec }
 */
function editLockState(firstSubmittedAt, now = new Date()) {
  if (!firstSubmittedAt) {
    return { locked: false, unlockAt: null, remainingSec: 0 };
  }
  const start = new Date(firstSubmittedAt).getTime();
  if (!Number.isFinite(start)) {
    return { locked: false, unlockAt: null, remainingSec: 0 };
  }
  const unlockAt = new Date(start + EDIT_LOCK_MINUTES * 60 * 1000);
  const remainingMs = unlockAt.getTime() - now.getTime();
  if (remainingMs <= 0) {
    return { locked: false, unlockAt, remainingSec: 0 };
  }
  return {
    locked: true,
    unlockAt,
    remainingSec: Math.ceil(remainingMs / 1000),
  };
}

module.exports = {
  CIRCLE_STATIONS,
  SLOT_ORDER,
  DEFAULT_RELAXED,
  EDIT_LOCK_MINUTES,
  dayKeyDhaka,
  slotInstantUtc,
  getSlotWindow,
  isSlotEditable,
  isActiveSlot,
  editLockState,
};
