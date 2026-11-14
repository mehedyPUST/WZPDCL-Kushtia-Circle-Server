import express, { type Request, type Response } from "express";
import ShiftMessage from "../models/ShiftMessage.js";
import { requireAuth } from "../middleware/auth.js";
import { currentShiftInfo } from "../lib/dhakaTime.js";
import { isValidObjectId } from "../lib/errors.js";

const SHIFT_ORDER = ["A", "B", "C"] as const;

function nextShiftId(current: "A" | "B" | "C"): "A" | "B" | "C" {
  const idx = SHIFT_ORDER.indexOf(current);
  return SHIFT_ORDER[(idx + 1) % SHIFT_ORDER.length];
}

function serializeMessage(doc: any) {
  if (!doc) return null;
  const o = typeof doc.toObject === "function" ? doc.toObject() : doc;
  const id = o._id?.toString?.() || o.id || String(o._id);
  return {
    id,
    content: o.content || "",
    createdBy: o.createdBy?.toString?.() || o.createdBy || null,
    createdByUsername: o.createdByUsername || "",
    createdByDisplayName: o.createdByDisplayName || o.createdByUsername || "",
    dutyDay: o.dutyDay || "",
    fromShift: o.fromShift || "",
    targetShift: o.targetShift || "",
    status: o.status || "pending",
    acknowledgedBy: o.acknowledgedBy?.toString?.() || o.acknowledgedBy || null,
    acknowledgedByUsername: o.acknowledgedByUsername || "",
    acknowledgedByDisplayName:
      o.acknowledgedByDisplayName || o.acknowledgedByUsername || "",
    acknowledgedAt: o.acknowledgedAt || null,
    forwardedFrom: o.forwardedFrom?.toString?.() || o.forwardedFrom || null,
    forwardNote: o.forwardNote || "",
    createdAt: o.createdAt || null,
    updatedAt: o.updatedAt || null,
  };
}

function actorIdentity(req: Request) {
  const admin = req.admin;
  const username = admin?.username || admin?.displayName || "unknown";
  const displayName = admin?.displayName || admin?.username || username;
  return { id: admin?.id || null, username, displayName };
}

export function createShiftMessageRouter(logTag: string) {
  const router = express.Router();

  router.get("/", requireAuth, async (req: Request, res: Response) => {
    try {
      const status = String(req.query.status || "").toLowerCase();
      const limit = Math.min(
        50,
        Math.max(1, parseInt(String(req.query.limit || "30"), 10) || 30)
      );
      const info = currentShiftInfo();

      const filter: Record<string, any> = {};
      if (status === "pending") filter.status = "pending";
      else if (status === "acknowledged") {
        filter.status = { $in: ["acknowledged", "forwarded"] };
      }

      const [docs, pendingCount] = await Promise.all([
        ShiftMessage.find(filter)
          .sort({ status: 1, createdAt: -1 })
          .limit(limit)
          .lean(),
        ShiftMessage.countDocuments({ status: "pending" }),
      ]);

      res.json({
        success: true,
        messages: docs.map(serializeMessage),
        currentShift: info.shift,
        dutyDay: info.dutyDay,
        nextShift: nextShiftId(info.shift),
        pendingCount,
      });
    } catch (err) {
      console.error(`[${logTag} GET]`, err);
      res.status(500).json({
        success: false,
        message:
          err instanceof Error ? err.message : "Failed to load messages",
      });
    }
  });

  router.post("/", requireAuth, async (req: Request, res: Response) => {
    try {
      const content = String(req.body?.content || "").trim();
      if (!content) {
        res
          .status(400)
          .json({ success: false, message: "Message content is required" });
        return;
      }
      if (content.length > 2000) {
        res.status(400).json({
          success: false,
          message: "Message is too long (max 2000 chars)",
        });
        return;
      }

      const info = currentShiftInfo();
      const targetShift = req.body?.targetShift
        ? String(req.body.targetShift).toUpperCase()
        : nextShiftId(info.shift);

      if (!["A", "B", "C"].includes(targetShift)) {
        res
          .status(400)
          .json({ success: false, message: "Invalid target shift" });
        return;
      }

      const actor = actorIdentity(req);
      const doc = await ShiftMessage.create({
        content,
        createdBy: actor.id,
        createdByUsername: actor.username,
        createdByDisplayName: actor.displayName,
        dutyDay: info.dutyDay,
        fromShift: info.shift,
        targetShift,
        status: "pending",
      });

      res.json({
        success: true,
        message: serializeMessage(doc),
        currentShift: info.shift,
        nextShift: targetShift,
      });
    } catch (err) {
      console.error(`[${logTag} POST]`, err);
      res.status(500).json({
        success: false,
        message:
          err instanceof Error ? err.message : "Failed to save message",
      });
    }
  });

  router.post("/:id/ack", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!isValidObjectId(id)) {
        res
          .status(400)
          .json({ success: false, message: "Invalid message id" });
        return;
      }

      const actor = actorIdentity(req);
      const now = new Date();

      const doc = await ShiftMessage.findById(id);
      if (!doc) {
        res
          .status(404)
          .json({ success: false, message: "Message not found" });
        return;
      }

      if (doc.status !== "pending") {
        res.json({
          success: true,
          message: serializeMessage(doc),
          alreadyHandled: true,
        });
        return;
      }

      doc.status = "acknowledged";
      doc.acknowledgedBy = actor.id;
      doc.acknowledgedByUsername = actor.username;
      doc.acknowledgedByDisplayName = actor.displayName;
      doc.acknowledgedAt = now;
      await doc.save();

      res.json({ success: true, message: serializeMessage(doc) });
    } catch (err) {
      console.error(`[${logTag} ack]`, err);
      res.status(500).json({
        success: false,
        message:
          err instanceof Error ? err.message : "Failed to acknowledge",
      });
    }
  });

  router.post(
    "/:id/forward",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const id = String(req.params.id || "").trim();
        if (!isValidObjectId(id)) {
          res
            .status(400)
            .json({ success: false, message: "Invalid message id" });
          return;
        }

        const forwardNote = String(
          req.body?.note || req.body?.forwardNote || ""
        )
          .trim()
          .slice(0, 500);

        const actor = actorIdentity(req);
        const now = new Date();
        const info = currentShiftInfo(now);
        const targetShift = nextShiftId(info.shift);

        const doc = await ShiftMessage.findById(id);
        if (!doc) {
          res
            .status(404)
            .json({ success: false, message: "Message not found" });
          return;
        }

        doc.status = "forwarded";
        doc.acknowledgedBy = actor.id;
        doc.acknowledgedByUsername = actor.username;
        doc.acknowledgedByDisplayName = actor.displayName;
        doc.acknowledgedAt = now;
        if (forwardNote) doc.forwardNote = forwardNote;
        await doc.save();

        const originalContent = doc.content || "";
        const prefix = forwardNote
          ? `[Fwd from ${actor.displayName} / ${info.shift}]: ${forwardNote}\n\n`
          : `[Fwd from ${actor.displayName} / ${info.shift}]\n\n`;

        const newDoc = await ShiftMessage.create({
          content: prefix + originalContent,
          createdBy: actor.id,
          createdByUsername: actor.username,
          createdByDisplayName: actor.displayName,
          dutyDay: info.dutyDay,
          fromShift: info.shift,
          targetShift,
          status: "pending",
          forwardedFrom: doc._id,
          forwardNote,
        });

        res.json({
          success: true,
          message: serializeMessage(doc),
          forwardedMessage: serializeMessage(newDoc),
        });
      } catch (err) {
        console.error(`[${logTag} forward]`, err);
        res.status(500).json({
          success: false,
          message:
            err instanceof Error ? err.message : "Failed to forward message",
        });
      }
    }
  );

  return router;
}
