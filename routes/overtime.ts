import express, { type Request, type Response } from "express";
import OvertimeSheet from "../models/OvertimeSheet.js";
import Admin from "../models/Admin.js";
import {
  normalizeRole,
  requireAuth,
  requireDuty,
  type NormalizedRole,
} from "../middleware/auth.js";

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

function canAccessOthers(role?: NormalizedRole | string | null): boolean {
  const r = normalizeRole(role);
  return r === "duty" || r === "admin";
}

function isDutyLikeRole(role?: string | null): boolean {
  const r = normalizeRole(role);
  return r === "duty" || r === "admin";
}

/**
 * GET /api/overtime/all?year=&month=
 * Duty SBA + Admin: list every duty person's overtime sheet for the month
 * (includes duty users who have not saved a sheet yet).
 */
router.get("/all", requireDuty, async (req: Request, res: Response) => {
  try {
    const dhaka = dhakaYearMonth();
    let year = parseInt(String(req.query.year || ""), 10);
    let month = parseInt(String(req.query.month || ""), 10);
    if (!Number.isFinite(year) || year < 2000 || year > 2100) year = dhaka.year;
    if (!Number.isFinite(month) || month < 1 || month > 12) month = dhaka.month;

    // All active duty / admin users (SBA duty persons)
    const dutyUsers = await Admin.find({
      isActive: { $ne: false },
      role: {
        $in: ["duty", "duty-person", "operator", "admin", "superadmin"],
      },
    })
      .select("_id username displayName role assignedStation isActive")
      .lean();

    const userIds = dutyUsers.map((u: any) => String(u._id));

    const sheets = await OvertimeSheet.find({
      year,
      month,
      userId: { $in: userIds },
    }).lean();

    const sheetByUser = new Map<string, any>();
    for (const s of sheets) {
      sheetByUser.set(String((s as any).userId), s);
    }

    const items = dutyUsers.map((u: any) => {
      const id = String(u._id);
      const sheet = sheetByUser.get(id);
      return {
        userId: id,
        username: String(u.username || ""),
        displayName: String(u.displayName || u.username || ""),
        role: normalizeRole(u.role),
        assignedStation: String(u.assignedStation || ""),
        hasSheet: Boolean(sheet),
        sheet: sheet
          ? serialize(sheet)
          : {
              userId: id,
              year,
              month,
              employeeName: String(u.displayName || u.username || ""),
              designation: "SBA-A",
              weeklyHoliday: 0,
              clLeaveDates: [],
              excludedDates: [],
              extraDutyEntries: [],
              dutyShift: "C",
              purpose: DEFAULT_PURPOSE,
              updatedAt: null,
              createdAt: null,
            },
        updatedAt: sheet?.updatedAt
          ? new Date(sheet.updatedAt).toISOString()
          : null,
      };
    });

    // Sort: users with sheets first, then by display name
    items.sort((a, b) => {
      if (a.hasSheet !== b.hasSheet) return a.hasSheet ? -1 : 1;
      return a.displayName.localeCompare(b.displayName, "en");
    });

    res.json({
      success: true,
      year,
      month,
      total: items.length,
      items,
    });
  } catch (err: any) {
    console.error("[overtime GET /all]", err);
    res.status(500).json({
      success: false,
      message: err?.message || "Failed to load team overtime data",
    });
  }
});

/**
 * GET /api/overtime?year=&month=&userId=
 * - Without userId: own sheet
 * - With userId: own sheet, or any duty person's sheet if requester is duty/admin
 */
router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const dhaka = dhakaYearMonth();
    let year = parseInt(String(req.query.year || ""), 10);
    let month = parseInt(String(req.query.month || ""), 10);
    if (!Number.isFinite(year) || year < 2000 || year > 2100) year = dhaka.year;
    if (!Number.isFinite(month) || month < 1 || month > 12) month = dhaka.month;

    const selfId = String(req.adminId || req.admin?.id || "");
    if (!selfId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const requestedUserId = String(req.query.userId || "").trim();
    let targetUserId = selfId;

    if (requestedUserId && requestedUserId !== selfId) {
      if (!canAccessOthers(req.admin?.role)) {
        res.status(403).json({
          success: false,
          message: "Only duty SBA or admin can view other persons' overtime sheets",
        });
        return;
      }
      targetUserId = requestedUserId;
    }

    const doc = await OvertimeSheet.findOne({
      userId: targetUserId,
      year,
      month,
    }).lean();

    if (!doc) {
      // Resolve display name for empty sheet
      let employeeName = req.admin?.displayName || "";
      if (targetUserId !== selfId) {
        const u = await Admin.findById(targetUserId)
          .select("displayName username")
          .lean();
        employeeName = String(
          (u as any)?.displayName || (u as any)?.username || ""
        );
      }
      res.json({
        success: true,
        sheet: {
          userId: targetUserId,
          year,
          month,
          employeeName,
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

/**
 * PUT /api/overtime — upsert sheet
 * Body may include userId to edit another duty person's sheet (duty/admin only).
 */
router.put("/", requireDuty, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const year = Number(body.year);
    const month = Number(body.month);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      res.status(400).json({ success: false, message: "Invalid year or month" });
      return;
    }

    const selfId = String(req.adminId || req.admin?.id || "");
    if (!selfId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    let targetUserId = selfId;
    const bodyUserId = String(body.userId || "").trim();
    if (bodyUserId && bodyUserId !== selfId) {
      if (!canAccessOthers(req.admin?.role)) {
        res.status(403).json({
          success: false,
          message: "Only duty SBA or admin can edit other persons' overtime sheets",
        });
        return;
      }
      // Ensure target is a duty-like user
      const target = await Admin.findById(bodyUserId).select("role isActive").lean();
      if (!target || (target as any).isActive === false) {
        res.status(404).json({ success: false, message: "Target user not found" });
        return;
      }
      if (!isDutyLikeRole((target as any).role)) {
        res.status(400).json({
          success: false,
          message: "Target user is not a duty person",
        });
        return;
      }
      targetUserId = bodyUserId;
    }

    const payload = {
      userId: targetUserId,
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
      { userId: targetUserId, year, month },
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
