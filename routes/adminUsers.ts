import express, { type Request, type Response } from "express";
import Admin from "../models/Admin.js";
import { normalizeRole, requireAdmin } from "../middleware/auth.js";
import {
  clientError,
  isDuplicateKeyError,
  isValidObjectId,
} from "../lib/errors.js";

const router = express.Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ASSIGNABLE_ROLES = new Set([
  "viewer",
  "duty",
  "admin",
  "circle-load-input",
]);

function publicUser(doc: any) {
  const o = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return {
    id: String(o._id),
    username: o.username,
    email: o.email || "",
    displayName: o.displayName || "",
    role: normalizeRole(o.role),
    assignedStation: o.assignedStation || "",
    isActive: o.isActive !== false,
    lastLogin: o.lastLogin || null,
    createdAt: o.createdAt || null,
    updatedAt: o.updatedAt || null,
  };
}

router.get("/", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const list = await Admin.find()
      .select(
        "username email displayName role isActive assignedStation lastLogin createdAt updatedAt"
      )
      .sort({ username: 1 })
      .lean();

    const data = list.map((u) => publicUser(u));
    const byRole = data.reduce<Record<string, number>>((acc, u) => {
      const r = u.role || "viewer";
      acc[r] = (acc[r] || 0) + 1;
      return acc;
    }, {});

    res.json({ success: true, data, count: data.length, byRole });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: clientError(err) || "Failed to list users",
    });
  }
});

router.post("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { username, password, email, displayName, role, assignedStation } =
      req.body || {};

    if (!username || !password) {
      res.status(400).json({
        success: false,
        message: "Username and password are required",
      });
      return;
    }
    if (String(password).length < 8) {
      res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters",
      });
      return;
    }

    let nextRole = normalizeRole(role || "viewer");
    if (!ASSIGNABLE_ROLES.has(nextRole)) nextRole = "viewer";

    const uname = String(username).trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(uname)) {
      res.status(400).json({
        success: false,
        message: "Username: 3–32 chars, lowercase letters, numbers, . _ -",
      });
      return;
    }

    const emailTrim = email != null ? String(email).trim().toLowerCase() : "";
    if (emailTrim && !EMAIL_REGEX.test(emailTrim)) {
      res
        .status(400)
        .json({ success: false, message: "Invalid email address" });
      return;
    }

    const exists = await Admin.findOne({
      $or: [
        { username: uname },
        { username: String(username).trim() },
        ...(emailTrim ? [{ email: emailTrim }] : []),
      ],
    });
    if (exists) {
      res.status(409).json({
        success: false,
        message: "Username or email already exists",
      });
      return;
    }

    const createPayload: Record<string, any> = {
      username: uname,
      password: String(password),
      displayName: displayName ? String(displayName).trim() : "",
      role: nextRole,
      isActive: true,
      assignedStation:
        nextRole === "circle-load-input"
          ? String(assignedStation || "").trim()
          : "",
    };
    if (emailTrim) createPayload.email = emailTrim;

    const user = await Admin.create(createPayload);
    res
      .status(201)
      .json({ success: true, message: "User created", data: publicUser(user) });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      res.status(409).json({
        success: false,
        message: "Username or email already exists",
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: clientError(err) || "Failed to create user",
    });
  }
});

router.patch("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      res.status(400).json({ success: false, message: "Invalid user ID" });
      return;
    }

    const user = await Admin.findById(req.params.id);
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    const body = req.body || {};
    const { email, displayName, role, isActive, password, assignedStation } =
      body;

    if (email !== undefined) {
      if (email !== null && typeof email !== "string") {
        res
          .status(400)
          .json({ success: false, message: "Email must be a string" });
        return;
      }
      const emailTrim = email === null ? "" : email.trim().toLowerCase();
      if (emailTrim && !EMAIL_REGEX.test(emailTrim)) {
        res
          .status(400)
          .json({ success: false, message: "Invalid email address" });
        return;
      }
      if (emailTrim) {
        const clash = await Admin.findOne({
          email: emailTrim,
          _id: { $ne: user._id },
        });
        if (clash) {
          res
            .status(409)
            .json({ success: false, message: "Email already in use" });
          return;
        }
        user.email = emailTrim;
      } else {
        user.email = undefined;
        user.set("email", undefined);
      }
    }

    if (displayName !== undefined) {
      user.displayName =
        displayName === null ? "" : String(displayName).trim().slice(0, 80);
    }

    if (typeof isActive === "boolean") {
      if (String(user._id) === String(req.admin!.id) && isActive === false) {
        res.status(400).json({
          success: false,
          message: "You cannot deactivate your own account",
        });
        return;
      }
      user.isActive = isActive;
    }

    if (role != null) {
      user.role = normalizeRole(role);
    }

    if (assignedStation !== undefined) {
      user.assignedStation =
        assignedStation === null ? "" : String(assignedStation).trim();
    }

    if (password != null && String(password).length > 0) {
      if (String(password).length < 8) {
        res.status(400).json({
          success: false,
          message: "Password must be at least 8 characters",
        });
        return;
      }
      user.password = String(password);
    }

    await user.save();
    res.json({
      success: true,
      message: "User updated",
      data: publicUser(user),
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      res
        .status(409)
        .json({ success: false, message: "Email already in use" });
      return;
    }
    res.status(500).json({
      success: false,
      message: clientError(err) || "Failed to update user",
    });
  }
});

router.delete("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      res.status(400).json({ success: false, message: "Invalid user ID" });
      return;
    }
    if (String(req.params.id) === String(req.admin!.id)) {
      res.status(400).json({
        success: false,
        message: "Cannot delete your own account",
      });
      return;
    }
    const user = await Admin.findByIdAndDelete(req.params.id);
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }
    res.json({ success: true, message: "User deleted" });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: clientError(err) || "Failed to delete user",
    });
  }
});

export default router;
