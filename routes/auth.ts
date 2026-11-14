import express, { type CookieOptions, type Request, type Response } from "express";
import Admin from "../models/Admin.js";
import {
  generateToken,
  getTokenFromRequest,
  normalizeRole,
  requireAuth,
  verifyToken,
} from "../middleware/auth.js";
import { clientError, isDuplicateKeyError } from "../lib/errors.js";

const router = express.Router();

const MIN_PASSWORD_LENGTH = 8;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(
  key: string,
  maxAttempts = 10,
  windowMs = 15 * 60 * 1000
): { limited: boolean; retryAfterSec?: number } {
  const now = Date.now();
  let entry = rateBuckets.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > maxAttempts) {
    return {
      limited: true,
      retryAfterSec: Math.ceil((entry.resetAt - now) / 1000),
    };
  }
  return { limited: false };
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "unknown";
}

function cookieOptions(): CookieOptions {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  };
}

function serializeAdmin(admin: any) {
  return {
    id: admin._id,
    username: admin.username,
    email: admin.email || "",
    displayName: admin.displayName || "",
    role: normalizeRole(admin.role),
    assignedStation: admin.assignedStation || "",
    lastLogin: admin.lastLogin || null,
  };
}

// POST /api/auth/login
router.post("/login", async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body || {};
    const ip = getClientIp(req);
    const limitKey = `login:${ip}:${String(username || "").trim().toLowerCase()}`;
    const rl = rateLimit(limitKey, 10, 15 * 60 * 1000);
    if (rl.limited) {
      res.status(429).json({
        success: false,
        message: `Too many login attempts. Try again in ${rl.retryAfterSec}s.`,
      });
      return;
    }

    if (!username || !password) {
      res.status(400).json({
        success: false,
        message: "Username and password are required",
      });
      return;
    }

    const identifier = String(username).trim();
    const admin = await Admin.findOne({
      $or: [{ username: identifier }, { email: identifier.toLowerCase() }],
    });

    if (!admin) {
      res.status(401).json({ success: false, message: "Invalid credentials" });
      return;
    }

    if (admin.isActive === false) {
      res.status(403).json({
        success: false,
        message:
          "You are blocked by the site admin. Please contact Bottail SS.",
        blocked: true,
      });
      return;
    }

    const isMatch = await admin.comparePassword(String(password));
    if (!isMatch) {
      res.status(401).json({ success: false, message: "Invalid credentials" });
      return;
    }

    admin.lastLogin = new Date();
    await admin.save();

    const token = generateToken(admin._id, admin.username, admin.role);
    res.cookie("admin_token", token, cookieOptions());

    res.json({
      success: true,
      message: "Login successful",
      token,
      data: serializeAdmin(admin),
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      message: "Login failed",
      error: clientError(error),
    });
  }
});

// POST /api/auth/logout
router.post("/logout", (_req: Request, res: Response) => {
  res.clearCookie("admin_token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    path: "/",
  });
  res.json({ success: true, message: "Logged out" });
});

// GET /api/auth/check
router.get("/check", async (req: Request, res: Response) => {
  try {
    const token = getTokenFromRequest(req);
    if (!token) {
      res.json({ success: true, authenticated: false });
      return;
    }
    const decoded = verifyToken(token);
    const admin = await Admin.findById(decoded.id).select(
      "username email displayName role isActive assignedStation lastLogin"
    );
    if (!admin) {
      res.json({ success: true, authenticated: false });
      return;
    }
    if (admin.isActive === false) {
      res.json({
        success: true,
        authenticated: false,
        blocked: true,
        message:
          "You are blocked by the site admin. Please contact Bottail SS.",
      });
      return;
    }
    res.json({
      success: true,
      authenticated: true,
      admin: serializeAdmin(admin),
    });
  } catch {
    res.json({ success: true, authenticated: false });
  }
});

// GET /api/auth/me
router.get("/me", requireAuth, async (req: Request, res: Response) => {
  try {
    const admin = await Admin.findById(req.admin!.id).select(
      "username email displayName role isActive assignedStation lastLogin"
    );
    if (!admin) {
      res.status(404).json({ success: false, message: "Admin not found" });
      return;
    }
    if (admin.isActive === false) {
      res.status(403).json({
        success: false,
        blocked: true,
        message: "Account is blocked",
      });
      return;
    }
    res.json({ success: true, data: serializeAdmin(admin) });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load profile",
      error: clientError(error),
    });
  }
});

// PATCH / PUT /api/auth/profile — self-service displayName + email
async function updateProfileHandler(req: Request, res: Response) {
  try {
    const admin = await Admin.findById(req.admin!.id);
    if (!admin) {
      res.status(404).json({ success: false, message: "Admin not found" });
      return;
    }
    if (admin.isActive === false) {
      res.status(403).json({ success: false, message: "Account is blocked" });
      return;
    }

    const { displayName, email } = req.body || {};

    if (displayName !== undefined) {
      if (displayName !== null && typeof displayName !== "string") {
        res.status(400).json({
          success: false,
          message: "Display name must be a string",
        });
        return;
      }
      admin.displayName =
        displayName === null ? "" : displayName.trim().slice(0, 80);
    }

    if (email !== undefined) {
      if (email !== null && typeof email !== "string") {
        res.status(400).json({
          success: false,
          message: "Email must be a string",
        });
        return;
      }
      const nextEmail = email === null ? "" : email.trim().toLowerCase();
      if (nextEmail && !EMAIL_REGEX.test(nextEmail)) {
        res
          .status(400)
          .json({ success: false, message: "Invalid email address" });
        return;
      }
      if (nextEmail) {
        const clash = await Admin.findOne({
          email: nextEmail,
          _id: { $ne: admin._id },
        });
        if (clash) {
          res
            .status(409)
            .json({ success: false, message: "Email already in use" });
          return;
        }
        admin.email = nextEmail;
      } else {
        admin.email = undefined;
        admin.set("email", undefined);
      }
    }

    await admin.save();

    const data = serializeAdmin(admin);
    const token = generateToken(admin._id, admin.username, admin.role);
    res.cookie("admin_token", token, cookieOptions());
    res.json({ success: true, message: "Profile updated", token, data });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      res
        .status(409)
        .json({ success: false, message: "Email already in use" });
      return;
    }
    console.error("Profile update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update profile",
      error: clientError(error),
    });
  }
}

router.patch("/profile", requireAuth, updateProfileHandler);
router.put("/profile", requireAuth, updateProfileHandler);

// POST /api/auth/change-password
router.post(
  "/change-password",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { currentPassword, newPassword } = req.body || {};
      if (!currentPassword || !newPassword) {
        res.status(400).json({
          success: false,
          message: "Current password and new password are required",
        });
        return;
      }
      if (String(newPassword).length < MIN_PASSWORD_LENGTH) {
        res.status(400).json({
          success: false,
          message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        });
        return;
      }
      if (String(currentPassword) === String(newPassword)) {
        res.status(400).json({
          success: false,
          message: "New password must be different from current password",
        });
        return;
      }

      const admin = await Admin.findById(req.admin!.id);
      if (!admin) {
        res.status(404).json({ success: false, message: "Admin not found" });
        return;
      }
      if (admin.isActive === false) {
        res
          .status(403)
          .json({ success: false, message: "Account is blocked" });
        return;
      }

      const match = await admin.comparePassword(String(currentPassword));
      if (!match) {
        res.status(401).json({
          success: false,
          message: "Current password is incorrect",
        });
        return;
      }

      admin.password = String(newPassword);
      await admin.save();

      const data = serializeAdmin(admin);
      const token = generateToken(admin._id, admin.username, admin.role);
      res.cookie("admin_token", token, cookieOptions());
      res.json({
        success: true,
        message: "Password changed successfully",
        token,
        data,
      });
    } catch (error) {
      console.error("Change password error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to change password",
        error: clientError(error),
      });
    }
  }
);

// POST /api/auth/register — first admin free, later need secret
router.post("/register", async (req: Request, res: Response) => {
  try {
    const { username, password, email, secret } = req.body || {};

    if (!username || !password) {
      res.status(400).json({
        success: false,
        message: "Username and password are required",
      });
      return;
    }

    if (String(password).length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({
        success: false,
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      });
      return;
    }

    const ip = getClientIp(req);
    const rl = rateLimit(`register:${ip}`, 5, 60 * 60 * 1000);
    if (rl.limited) {
      res.status(429).json({
        success: false,
        message: `Too many registration attempts. Try again in ${rl.retryAfterSec}s.`,
      });
      return;
    }

    const count = await Admin.countDocuments();
    if (count > 0) {
      const expected = process.env.ADMIN_REGISTRATION_SECRET;
      if (!expected || secret !== expected) {
        res.status(403).json({
          success: false,
          message: "Registration closed. Valid secret required.",
        });
        return;
      }
    }

    const cleanUsername = String(username).trim();
    const cleanEmail =
      email && String(email).trim() ? String(email).trim().toLowerCase() : "";

    if (cleanEmail && !EMAIL_REGEX.test(cleanEmail)) {
      res.status(400).json({ success: false, message: "Invalid email address" });
      return;
    }

    const exists = await Admin.findOne({
      $or: [
        { username: cleanUsername },
        ...(cleanEmail ? [{ email: cleanEmail }] : []),
      ],
    });
    if (exists) {
      res.status(409).json({
        success: false,
        message: "Username or email already exists",
      });
      return;
    }

    const admin = await Admin.create({
      username: cleanUsername,
      password: String(password),
      email: cleanEmail || undefined,
      role: count === 0 ? "superadmin" : "admin",
      isActive: true,
    });

    res.status(201).json({
      success: true,
      message: "Admin registered",
      data: {
        id: admin._id,
        username: admin.username,
        email: admin.email || "",
        role: normalizeRole(admin.role),
      },
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      res.status(409).json({
        success: false,
        message: "Username or email already exists",
      });
      return;
    }
    console.error("Register error:", error);
    res.status(500).json({
      success: false,
      message: "Registration failed",
      error: clientError(error),
    });
  }
});

export default router;
