import express, { type Request, type Response } from "express";
import MonthlyEnergyReading from "../models/MonthlyEnergyReading.js";
import { requireAdmin } from "../middleware/auth.js";
import { dhakaNowParts } from "../lib/dhakaTime.js";
import {
  ensureRowsForFeeders,
  feedersFromRows,
  loadRegistry,
  mapEnergyRows,
  mergeFeederRegistry,
  rowsFromFeeders,
  saveRegistry,
  serializeMonthlyEnergy,
} from "../services/monthlyEnergy.js";

const router = express.Router();

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

    let feeders = await loadRegistry();

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
      const aligned = ensureRowsForFeeders(doc.rows, feeders);
      const changed =
        JSON.stringify(aligned.map((r) => [r.feederId, r.meterOwner])) !==
        JSON.stringify(
          (doc.rows || []).map((r: any) => [r.feederId, r.meterOwner])
        );
      if (changed) {
        doc.rows = aligned;
        await doc.save();
      }
    }

    res.json({
      success: true,
      sheet: serializeMonthlyEnergy(doc),
      feeders,
    });
  } catch (err) {
    console.error("[monthly-energy GET]", err);
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : "Failed to load sheet",
    });
  }
});

router.put("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const year = parseInt(String(req.body?.year ?? ""), 10);
    const month = parseInt(String(req.body?.month ?? ""), 10);
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      res
        .status(400)
        .json({ success: false, message: "Valid year is required" });
      return;
    }
    if (!Number.isFinite(month) || month < 1 || month > 12) {
      res
        .status(400)
        .json({ success: false, message: "Valid month is required" });
      return;
    }

    const rows = mapEnergyRows(req.body?.rows);
    const admin = req.admin;
    const username = admin?.username || "";
    const displayName = admin?.displayName || admin?.username || "";
    const notes = String(req.body?.notes || "").trim();

    let feeders;
    if (Array.isArray(req.body?.feeders)) {
      feeders = await saveRegistry(req.body.feeders);
    } else {
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

    res.json({
      success: true,
      sheet: serializeMonthlyEnergy(doc),
      feeders,
    });
  } catch (err) {
    console.error("[monthly-energy PUT]", err);
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : "Failed to save sheet",
    });
  }
});

export default router;
