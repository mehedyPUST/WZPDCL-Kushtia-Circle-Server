const express = require("express");
const Admin = require("../models/Admin");
const { generateToken, requireAuth, getTokenFromRequest, normalizeRole } = require("../middleware/auth");
const jwt = require("jsonwebtoken");

const router = express.Router();

const MIN_PASSWORD_LENGTH = 8;

/** Simple in-memory rate limit: max attempts per key per window. */
const rateBuckets = new Map();
function rateLimit(key, maxAttempts = 10, windowMs = 15 * 60 * 1000) {
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

function clientError(err) {
  return process.env.NODE_ENV === "production" ? undefined : err?.message;
}

function cookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  // Cross-site cookie (frontend on *.vercel.app, API on another host)
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  };
}

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
    const limitKey = `login:${ip}:${String(username || "").trim().toLowerCase()}`;
    const rl = rateLimit(limitKey, 10, 15 * 60 * 1000);
    if (rl.limited) {
      return res.status(429).json({
        success: false,
        message: `Too many login attempts. Try again in ${rl.retryAfterSec}s.`,
      });
    }

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: "Username and password are required",
      });
    }

    const admin = await Admin.findOne({
      $or: [
        { username: String(username).trim() },
        { email: String(username).trim().toLowerCase() },
      ],
    });

    if (!admin) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    if (admin.isActive === false) {
      return res.status(403).json({
        success: false,
        message:
          "You are blocked by the site admin. Please contact Bottail SS.",
        blocked: true,
      });
    }

    const isMatch = await admin.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    admin.lastLogin = new Date();
    await admin.save();

    const token = generateToken(admin._id, admin.username, admin.role);

    res.cookie("admin_token", token, cookieOptions());

    // Always return token in body for cross-origin clients (Vercel)
    res.json({
      success: true,
      message: "Login successful",
      token,
      data: {
        id: admin._id,
        username: admin.username,
        email: admin.email,
        role: normalizeRole(admin.role),
        assignedStation: admin.assignedStation || "",
        lastLogin: admin.lastLogin,
      },
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
router.post("/logout", async (req, res) => {
  res.clearCookie("admin_token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    path: "/",
  });
  res.json({ success: true, message: "Logged out" });
});

// GET /api/auth/check
router.get("/check", async (req, res) => {
  try {
    const token = getTokenFromRequest(req);
    if (!token) {
      return res.json({ success: true, authenticated: false });
    }
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? undefined : "dev-only-change-me")
    );
    const admin = await Admin.findById(decoded.id).select(
      "username email role isActive assignedStation lastLogin"
    );
    if (!admin) {
      return res.json({ success: true, authenticated: false });
    }
    if (admin.isActive === false) {
      return res.json({
        success: true,
        authenticated: false,
        blocked: true,
        message:
          "You are blocked by the site admin. Please contact Bottail SS.",
      });
    }
    res.json({
      success: true,
      authenticated: true,
      admin: {
        id: admin._id,
        username: admin.username,
        email: admin.email,
        role: normalizeRole(admin.role),
        assignedStation: admin.assignedStation || "",
        lastLogin: admin.lastLogin,
      },
    });
  } catch {
    res.json({ success: true, authenticated: false });
  }
});

// GET /api/auth/me
router.get("/me", requireAuth, async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin.id).select(
      "username email role isActive assignedStation lastLogin"
    );
    if (!admin) {
      return res.status(404).json({ success: false, message: "Admin not found" });
    }
    res.json({
      success: true,
      data: {
        id: admin._id,
        username: admin.username,
        email: admin.email,
        role: normalizeRole(admin.role),
        assignedStation: admin.assignedStation || "",
        lastLogin: admin.lastLogin,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to load profile",
      error: clientError(error),
    });
  }
});

// POST /api/auth/register — first admin free, later need secret
router.post("/register", async (req, res) => {
  try {
    const { username, password, email, secret } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: "Username and password are required",
      });
    }

    if (String(password).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      });
    }

    const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
    const rl = rateLimit(`register:${ip}`, 5, 60 * 60 * 1000);
    if (rl.limited) {
      return res.status(429).json({
        success: false,
        message: `Too many registration attempts. Try again in ${rl.retryAfterSec}s.`,
      });
    }

    const count = await Admin.countDocuments();
    if (count > 0) {
      const expected = process.env.ADMIN_REGISTRATION_SECRET;
      if (!expected || secret !== expected) {
        return res.status(403).json({
          success: false,
          message: "Registration closed. Valid secret required.",
        });
      }
    }

    const exists = await Admin.findOne({
      $or: [
        { username: String(username).trim() },
        ...(email ? [{ email: String(email).trim().toLowerCase() }] : []),
      ],
    });
    if (exists) {
      return res.status(409).json({
        success: false,
        message: "Username or email already exists",
      });
    }

    const admin = await Admin.create({
      username: String(username).trim(),
      password,
      email: email && String(email).trim() ? String(email).trim().toLowerCase() : undefined,
      role: count === 0 ? "superadmin" : "admin",
      isActive: true,
    });

    res.status(201).json({
      success: true,
      message: "Admin registered",
      data: {
        id: admin._id,
        username: admin.username,
        email: admin.email,
        role: normalizeRole(admin.role),
      },
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({
      success: false,
      message: "Registration failed",
      error: clientError(error),
    });
  }
});

module.exports = router;
