import { dayKeyDhaka, DHAKA_OFFSET_MS } from "./dhakaTime.js";

export interface CircleStation {
  id: string;
  name: string;
  source: "calculator" | "manual";
  note?: string;
}

export interface SlotOptions {
  relaxedSlots?: string[];
  relaxUntil?: string;
}

export const CIRCLE_STATIONS: CircleStation[] = [
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

export const SLOT_ORDER: string[] = (() => {
  const slots: string[] = [];
  for (let h = 0; h < 24; h++) {
    slots.push(`${String(h).padStart(2, "0")}:00`);
    if (h === 18) slots.push("18:30");
    if (h === 19) slots.push("19:30");
  }
  return slots;
})();

export const DEFAULT_RELAXED = [
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
export const EDIT_LOCK_MINUTES = 10;

export { dayKeyDhaka };

export function slotInstantUtc(dayKey: string, hourSlot: string): Date | null {
  const m = String(hourSlot || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(String(dayKey || ""))) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const [y, month, d] = String(dayKey).split("-").map(Number);
  return new Date(Date.UTC(y, month - 1, d, hh, mm, 0, 0) - DHAKA_OFFSET_MS);
}

/**
 * Slot open window (Dhaka wall clock on dayKey).
 *
 * Special rules:
 * - 19:00 -> open 18:30 .. 19:30
 * - 18:30 -> open 18:00 for 60 min (until 19:00)
 * - 19:30 -> open 19:00 for 60 min (until 20:00)
 *
 * Other full-hour slots: open 30 min before until 30 min after.
 * Relaxed 01:00-08:00: open until relaxUntil (default 12:00) same day.
 */
export function getSlotWindow(
  dayKey: string,
  hourSlot: string,
  opts: SlotOptions = {}
): { openAt: Date | null; closeAt: Date | null; kind: string } | null {
  const slotAt = slotInstantUtc(dayKey, hourSlot);
  if (!slotAt) return null;

  const relaxed = Array.isArray(opts.relaxedSlots)
    ? opts.relaxedSlots
    : DEFAULT_RELAXED;
  const relaxUntil = String(opts.relaxUntil || "12:00");

  if (relaxed.includes(hourSlot)) {
    return {
      openAt: slotInstantUtc(dayKey, "00:00"),
      closeAt: slotInstantUtc(dayKey, relaxUntil),
      kind: "relaxed",
    };
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
    if (!openAt) return null;
    return {
      openAt,
      closeAt: new Date(openAt.getTime() + 60 * 60 * 1000),
      kind: "half-hour",
    };
  }

  if (hourSlot === "19:30") {
    const openAt = slotInstantUtc(dayKey, "19:00");
    if (!openAt) return null;
    return {
      openAt,
      closeAt: new Date(openAt.getTime() + 60 * 60 * 1000),
      kind: "half-hour",
    };
  }

  return {
    openAt: new Date(slotAt.getTime() - 30 * 60 * 1000),
    closeAt: new Date(slotAt.getTime() + 30 * 60 * 1000),
    kind: "hour",
  };
}

export function isSlotEditable(
  dayKey: string,
  hourSlot: string,
  now: Date = new Date(),
  opts: SlotOptions = {}
): boolean {
  const w = getSlotWindow(dayKey, hourSlot, opts);
  if (!w || !w.openAt || !w.closeAt) return false;
  const t = now.getTime();
  return t >= w.openAt.getTime() - 500 && t < w.closeAt.getTime() + 500;
}

export function isActiveSlot(
  dayKey: string,
  hourSlot: string,
  now: Date = new Date(),
  opts: SlotOptions = {}
): boolean {
  if (dayKey !== dayKeyDhaka(now)) return false;
  return isSlotEditable(dayKey, hourSlot, now, {
    ...opts,
    relaxedSlots: [],
  });
}

/**
 * After first submit, fields lock for EDIT_LOCK_MINUTES.
 */
export function editLockState(
  firstSubmittedAt?: Date | string | null,
  now: Date = new Date()
): { locked: boolean; unlockAt: Date | null; remainingSec: number } {
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
