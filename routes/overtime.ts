import express, { type Request, type Response } from "express";
import OvertimeSheet from "../models/OvertimeSheet.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

const DEFAULT_PURPOSE = "সাপ্তাহিক বিরতির দিনে ডিউটি করা হয়";

function normalizeShift(value: unknown): "A" | "B" | "C" {
  const s = String(value || "").trim().toUpperCase();
  if (s === "A" || s === "B" || s === "C") return s;
  return "C";
}

function parseYmdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((d) => String(d || "").trim())
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
}

function parseExtraEntries(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  const out: Array<{
    date: string;
    normalFrom: string;
    normalTo: string;
    dutyFrom: string;
    dutyTo: string;
    purpose: string;
  }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const date = String((item as any).date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.push({
      date,
      normalFrom: String((item as any).normalFrom || "").trim(),
      normalTo: String((item as any).normalTo || "").trim(),
      dutyFrom: String((item as any).dutyFrom || "22:00").trim() || "22:00",
      dutyTo: String((item as any).dutyTo || "06:00").trim() || "06:00",
      purpose:
        String((item as any).purpose || "").trim() || DEFAULT_PURPOSE,
    });
  }
  // de-dupe by date (last wins)
  const map = new Map<string, (typeof out)[0]>();
  for (const e of out) map.set(e.date, e);
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function serialize(doc: any) {
  return {
    id: String(doc._id || doc.id || ""),
    userId: String(doc.userId || ""),
    year: Number(doc.year),
    month: Number(doc.month),
    employeeName: String(doc.employeeName || ""),
    designation: String(doc.designation || "SBA-A"),
    weeklyHoliday: Number(doc.weeklyHoliday ?? 0),
    clLeaveDates: Array.isArray(doc.clLeaveDates)
      ? doc.clLeaveDates.map((d: any) => String(d))
      : [],
    excludedDates: Array.isArray(doc.excludedDates)
      ? doc.excludedDates.map((d: any) => String(d))
      : [],
    extraDutyEntries: Array.isArray(doc.extraDutyEntries)
      ? doc.extraDutyEntries.map((e: any) => ({
          date: String(e.date || ""),
          normalFrom: String(e.normalFrom || ""),
          normalTo: String(e.normalTo || ""),
          dutyFrom: String(e.dutyFrom || "22:00"),
          dutyTo: String(e.dutyTo || "06:00"),
          purpose: String(e.purpose || DEFAULT_PURPOSE),
        }))
      : [],
    dutyShift: normalizeShift(doc.dutyShift),
    purpose: String(doc.purpose || DEFAULT_PURPOSE),
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
  };
}

function dhakaYearMonth() {
  const shifted = new Date(Date.now() + 6 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
  };
}

/** GET /api/overtime?year=&month= — current user's sheet */
router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const dhaka = dhakaYearMonth();
    let year = parseInt(String(req.query.year || ""), 10);
    let month = parseInt(String(req.query.month || ""), 10);
    if (!Number.isFinite(year) || year < 2000 || year > 2100) year = dhaka.year;
    if (!Number.isFinite(month) || month < 1 || month > 12) month = dhaka.month;

    const userId = String(req.adminId || req.admin?.id || "");
    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const doc = await OvertimeSheet.findOne({ userId, year, month }).lean();
    if (!doc) {
      res.json({
        success: true,
        sheet: {
          userId,
          year,
          month,
          employeeName: req.admin?.displayName || "",
          designation: "SBA-A",
          weeklyHoliday: 0,
          clLeaveDates: [],
          excludedDates: [],
          extraDutyEntries: [],
          dutyShift: "C",
          purpose: DEFAULT_PURPOSE,
        },
      });
      return;
    }

    res.json({ success: true, sheet: serialize(doc) });
  } catch (err: any) {
    console.error("[overtime GET]", err);
    res.status(500).json({
      success: false,
      message: err?.message || "Failed to load overtime data",
    });
  }
});

/** PUT /api/overtime — upsert current user's sheet for year/month */
router.put("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const year = Number(body.year);
    const month = Number(body.month);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      res.status(400).json({ success: false, message: "Invalid year or month" });
      return;
    }

    const userId = String(req.adminId || req.admin?.id || "");
    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const payload = {
      userId,
      year,
      month,
      employeeName: String(body.employeeName || "").trim(),
      designation: String(body.designation || "SBA-A").trim() || "SBA-A",
      weeklyHoliday: Math.min(6, Math.max(0, Number(body.weeklyHoliday ?? 0))),
      clLeaveDates: parseYmdList(body.clLeaveDates),
      excludedDates: parseYmdList(body.excludedDates),
      extraDutyEntries: parseExtraEntries(body.extraDutyEntries),
      dutyShift: normalizeShift(body.dutyShift ?? "C"),
      purpose: String(body.purpose || "").trim() || DEFAULT_PURPOSE,
    };

    const doc = await OvertimeSheet.findOneAndUpdate(
      { userId, year, month },
      { $set: payload },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    res.json({
      success: true,
      message: "Overtime data saved",
      sheet: serialize(doc),
    });
  } catch (err: any) {
    console.error("[overtime PUT]", err);
    res.status(500).json({
      success: false,
      message: err?.message || "Failed to save overtime data",
    });
  }
});

export default router;
