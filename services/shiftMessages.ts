import express, { type Request, type Response } from "express";
import ShiftMessage from "../models/ShiftMessage.js";
import { requireAuth } from "../middleware/auth.js";
import { currentShiftInfo } from "../lib/dhakaTime.js";
import { isValidObjectId } from "../lib/errors.js";

const SHIFT_ORDER = ["A", "B", "C"] as const;

const PRIORITY_WEIGHT: Record<string, number> = {
  critical: 2,
  high: 1,
  normal: 0,
};

function nextShiftId(current: "A" | "B" | "C"): "A" | "B" | "C" {
  const idx = SHIFT_ORDER.indexOf(current);
  return SHIFT_ORDER[(idx + 1) % SHIFT_ORDER.length];
}

function normalizePriority(value: unknown): "normal" | "high" | "critical" {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  if (v === "critical" || v === "urgent") return "critical";
  if (v === "high") return "high";
  return "normal";
}

function appendReadReceipt(
  existing: any[] | undefined,
  actor: { id: string | null; username: string; displayName: string },
  shift: string,
  now: Date
) {
  const list = Array.isArray(existing) ? [...existing] : [];
  const userId = actor.id || null;
  const username = actor.username || "unknown";
  const displayName = actor.displayName || username;

  const alreadyIdx = list.findIndex((r: any) => {
    const rUid =
      r?.userId?.toString?.() ||
      (typeof r?.userId === "string" ? r.userId : null);
    if (userId && rUid && String(rUid) === String(userId)) return true;
    if (
      username &&
      r?.username &&
      String(r.username).toLowerCase() === username.toLowerCase()
    ) {
      return true;
    }
    return false;
  });

  if (alreadyIdx >= 0) {
    return { receipts: list, alreadyRead: true };
  }

  list.push({
    userId,
    username,
    displayName,
    shift: ["A", "B", "C"].includes(shift) ? shift : "",
    readAt: now,
  });

  return { receipts: list, alreadyRead: false };
}

function serializeMessage(doc: any) {
  if (!doc) return null;
  const o = typeof doc.toObject === "function" ? doc.toObject() : doc;
  const id = o._id?.toString?.() || o.id || String(o._id);

  const rawReceipts = Array.isArray(o.readReceipts) ? o.readReceipts : [];
  const readReceipts = rawReceipts.map((r: any) => ({
    userId: r?.userId?.toString?.() || r?.userId || null,
    username: r?.username || "",
    displayName: r?.displayName || r?.username || "Operator",
    shift: r?.shift || "",
    readAt: r?.readAt || null,
  }));

  // Legacy acknowledged records without readReceipts still show the SBA as a reader
  if (
    readReceipts.length === 0 &&
    o.acknowledgedByDisplayName &&
    (o.status === "acknowledged" || o.status === "forwarded")
  ) {
    readReceipts.push({
      userId: o.acknowledgedBy?.toString?.() || o.acknowledgedBy || null,
      username: o.acknowledgedByUsername || "",
      displayName:
        o.acknowledgedByDisplayName || o.acknowledgedByUsername || "",
      shift: "",
      readAt: o.acknowledgedAt || null,
    });
  }

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
    priority: normalizePriority(o.priority),
    acknowledgedBy: o.acknowledgedBy?.toString?.() || o.acknowledgedBy || null,
    acknowledgedByUsername: o.acknowledgedByUsername || "",
    acknowledgedByDisplayName:
      o.acknowledgedByDisplayName || o.acknowledgedByUsername || "",
    acknowledgedAt: o.acknowledgedAt || null,
    forwardedFrom: o.forwardedFrom?.toString?.() || o.forwardedFrom || null,
    forwardNote: o.forwardNote || "",
    readReceipts,
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

function sortNotes(docs: any[]) {
  return [...docs].sort((a, b) => {
    if (a.status === "pending" && b.status !== "pending") return -1;
    if (a.status !== "pending" && b.status === "pending") return 1;
    if (a.status === "pending" && b.status === "pending") {
      const pw =
        (PRIORITY_WEIGHT[normalizePriority(b.priority)] ?? 0) -
        (PRIORITY_WEIGHT[normalizePriority(a.priority)] ?? 0);
      if (pw !== 0) return pw;
    }
    return (
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  });
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
          .sort({ createdAt: -1 })
          .limit(Math.max(limit * 2, 60))
          .lean(),
        ShiftMessage.countDocuments({ status: "pending" }),
      ]);

      const sorted = sortNotes(docs as any[]).slice(0, limit);

      res.json({
        success: true,
        messages: sorted.map(serializeMessage),
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
      const targetShiftRaw = req.body?.targetShift
        ? String(req.body.targetShift).toUpperCase()
        : nextShiftId(info.shift);

      if (!["A", "B", "C"].includes(targetShiftRaw)) {
        res
          .status(400)
          .json({ success: false, message: "Invalid target shift" });
        return;
      }

      const actor = actorIdentity(req);
      const priority = normalizePriority(req.body?.priority);

      const doc = await ShiftMessage.create({
        content,
        createdBy: actor.id,
        createdByUsername: actor.username,
        createdByDisplayName: actor.displayName,
        dutyDay: info.dutyDay,
        fromShift: info.shift,
        targetShift: targetShiftRaw,
        status: "pending",
        priority,
        acknowledgedBy: null,
        acknowledgedByUsername: "",
        acknowledgedByDisplayName: "",
        acknowledgedAt: null,
        forwardedFrom: null,
        forwardNote: "",
        readReceipts: [],
      });

      res.json({
        success: true,
        message: serializeMessage(doc),
        currentShift: info.shift,
        nextShift: targetShiftRaw,
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
      const info = currentShiftInfo(now);

      const doc = await ShiftMessage.findById(id);
      if (!doc) {
        res
          .status(404)
          .json({ success: false, message: "Message not found" });
        return;
      }

      const { receipts, alreadyRead } = appendReadReceipt(
        doc.readReceipts,
        actor,
        info.shift,
        now
      );

      if (doc.status !== "pending") {
        if (!alreadyRead) {
          doc.readReceipts = receipts;
          doc.markModified?.("readReceipts");
          await doc.save();
        }
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
      doc.readReceipts = receipts;
      doc.markModified?.("readReceipts");
      await doc.save();

      res.json({
        success: true,
        message: serializeMessage(doc),
      });
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
    "/:id/read",
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

        const actor = actorIdentity(req);
        const now = new Date();
        const info = currentShiftInfo(now);

        const doc = await ShiftMessage.findById(id);
        if (!doc) {
          res
            .status(404)
            .json({ success: false, message: "Message not found" });
          return;
        }

        const { receipts, alreadyRead } = appendReadReceipt(
          doc.readReceipts,
          actor,
          info.shift,
          now
        );

        if (!alreadyRead) {
          doc.readReceipts = receipts;
          doc.markModified?.("readReceipts");
          await doc.save();
        }

        res.json({
          success: true,
          alreadyRead,
          message: serializeMessage(doc),
        });
      } catch (err) {
        console.error(`[${logTag} read]`, err);
        res.status(500).json({
          success: false,
          message:
            err instanceof Error
              ? err.message
              : "Failed to record read receipt",
        });
      }
    }
  );

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

        const { receipts } = appendReadReceipt(
          doc.readReceipts,
          actor,
          info.shift,
          now
        );

        doc.status = "forwarded";
        doc.acknowledgedBy = actor.id;
        doc.acknowledgedByUsername = actor.username;
        doc.acknowledgedByDisplayName = actor.displayName;
        doc.acknowledgedAt = now;
        doc.readReceipts = receipts;
        doc.markModified?.("readReceipts");
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
          priority: normalizePriority(doc.priority),
          forwardedFrom: doc._id,
          forwardNote,
          readReceipts: [],
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
