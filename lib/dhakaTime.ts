export const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

export function formatUtcYmd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function dayKeyDhaka(now: Date = new Date()): string {
  return formatUtcYmd(new Date(now.getTime() + DHAKA_OFFSET_MS));
}

export function dhakaNowParts(now: Date = new Date()): {
  ymd: string;
  hour: number;
  minute: number;
  year: number;
  month: number;
  day: number;
} {
  const shifted = new Date(now.getTime() + DHAKA_OFFSET_MS);
  return {
    ymd: formatUtcYmd(shifted),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function addDaysYmd(ymd: string, delta: number): string {
  const [y, m, d] = String(ymd).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return formatUtcYmd(dt);
}

export function dayBoundsFromYmd(
  ymd: string
): { start: Date; end: Date } | null {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) return null;
  const [y, m, d] = String(ymd).split("-").map(Number);
  if (!y || !m || !d) return null;
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - DHAKA_OFFSET_MS);
  const end = new Date(
    Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0) - DHAKA_OFFSET_MS
  );
  if (Number.isNaN(start.getTime())) return null;
  return { start, end };
}

export function shiftFromHour(hour: number): "A" | "B" | "C" {
  const h = Number(hour);
  if (h >= 9 && h <= 14) return "A";
  if (h >= 15 && h <= 20) return "B";
  return "C";
}

export function currentShiftInfo(now: Date = new Date()): {
  shift: "A" | "B" | "C";
  dutyDay: string;
  hour: number;
  minute: number;
} {
  const parts = dhakaNowParts(now);
  const shift = shiftFromHour(parts.hour);
  const dutyDay =
    shift === "C" && parts.hour <= 8 ? addDaysYmd(parts.ymd, -1) : parts.ymd;

  return { shift, dutyDay, hour: parts.hour, minute: parts.minute };
}
