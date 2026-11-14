import express, { type Request, type Response } from "express";
import Calculation from "../models/Calculation.js";
import { requireAdmin } from "../middleware/auth.js";
import {
  addDaysYmd,
  dayBoundsFromYmd,
  dhakaNowParts,
} from "../lib/dhakaTime.js";
import { clientError } from "../lib/errors.js";
import { buildMonthlyDutyRoster } from "../services/dutyRoster.js";

const router = express.Router();

// GET /api/admin/duty-roster?year=&month=
router.get("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const dhakaNow = dhakaNowParts();
    let year = parseInt(String(req.query.year || ""), 10);
    let month = parseInt(String(req.query.month || ""), 10);

    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      year = dhakaNow.year;
    }
    if (!Number.isFinite(month) || month < 1 || month > 12) {
      month = dhakaNow.month;
    }

    const from = addDaysYmd(
      `${year}-${String(month).padStart(2, "0")}-01`,
      -1
    );
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const to = addDaysYmd(
      `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
      1
    );
    const fromB = dayBoundsFromYmd(from)!;
    const toB = dayBoundsFromYmd(to)!;

    const eventAt = { $ifNull: ["$calculatedAt", "$createdAt"] };
    const filter = {
      $and: [
        { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
        {
          $expr: {
            $and: [
              { $gte: [eventAt, fromB.start] },
              { $lt: [eventAt, toB.end] },
            ],
          },
        },
      ],
    };

    const records = await Calculation.find(filter)
      .select(
        "hourSlot calculatedAt createdAt createdBy createdByUsername totalMW isHourly"
      )
      .lean()
      .limit(20000);

    const roster = buildMonthlyDutyRoster(records, year, month);

    res.json({
      success: true,
      data: roster,
      meta: { from, to, recordCount: records.length },
    });
  } catch (err) {
    console.error("duty-roster error:", err);
    res.status(500).json({
      success: false,
      message: clientError(err) || "Failed to load duty roster",
    });
  }
});

export default router;
