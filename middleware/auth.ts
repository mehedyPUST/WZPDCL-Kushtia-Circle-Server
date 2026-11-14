import type { NextFunction, Request, Response } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";
import Admin from "../models/Admin.js";
import { isDbConnected } from "../config/db.js";

export type NormalizedRole = "viewer" | "circle-load-input" | "duty" | "admin";

export interface AuthAdmin {
  id: string;
  username: string;
  email?: string;
  displayName?: string;
  role: NormalizedRole;
  assignedStation?: string;
}

declare global {
  namespace Express {
    interface Request {
      admin?: AuthAdmin;
      adminId?: string;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = (process.env.JWT_EXPIRY || "7d") as SignOptions["expiresIn"];

if (!JWT_SECRET) {
  console.warn(
    "[auth] JWT_SECRET is not set — using insecure dev fallback. Set JWT_SECRET before deploying."
  );
}

export const EFFECTIVE_JWT_SECRET = JWT_SECRET || "dev-only-change-me";

/** Normalize legacy roles -> viewer | circle-load-input | duty | admin */
export function normalizeRole(role?: string | null): NormalizedRole {
  const r = String(role || "")
    .toLowerCase()
    .replace(/_/g, "-");
  if (r === "viewer") return "viewer";
  if (
    r === "circle-load-input" ||
    r === "circleloadinput" ||
    r === "circle-input"
  ) {
    return "circle-load-input";
  }
  if (r === "duty" || r === "duty-person" || r === "operator") return "duty";
  if (r === "admin" || r === "superadmin") return "admin";
  return "viewer";
}

export function generateToken(
  adminId: unknown,
  username: string,
  role?: string | null
): string {
  return jwt.sign(
    { id: String(adminId), username, role: normalizeRole(role) },
    EFFECTIVE_JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

export function verifyToken(token: string): {
  id: string;
  username: string;
  role?: string;
} {
  return jwt.verify(token, EFFECTIVE_JWT_SECRET) as {
    id: string;
    username: string;
    role?: string;
  };
}

export function getTokenFromRequest(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }
  if (req.cookies && req.cookies.admin_token) {
    return String(req.cookies.admin_token);
  }
  return null;
}

function fromTokenPayload(decoded: {
  id: string;
  username: string;
  role?: string;
}): AuthAdmin {
  return {
    id: String(decoded.id),
    username: decoded.username,
    role: normalizeRole(decoded.role),
  };
}

async function resolveAdminSession(decoded: {
  id: string;
  username: string;
  role?: string;
}): Promise<{ admin: AuthAdmin | null; blocked: boolean }> {
  if (!isDbConnected()) {
    return { admin: fromTokenPayload(decoded), blocked: false };
  }

  const doc = await Admin.findById(decoded.id)
    .select("username email displayName role isActive assignedStation")
    .lean<{
      _id: unknown;
      username: string;
      email?: string;
      displayName?: string;
      role?: string;
      isActive?: boolean;
      assignedStation?: string;
    }>();

  if (!doc) {
    return { admin: null, blocked: false };
  }
  if (doc.isActive === false) {
    return { admin: null, blocked: true };
  }

  return {
    blocked: false,
    admin: {
      id: String(doc._id),
      username: doc.username,
      email: doc.email || "",
      displayName: doc.displayName || "",
      role: normalizeRole(doc.role),
      assignedStation: doc.assignedStation || "",
    },
  };
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = getTokenFromRequest(req);
    if (!token) {
      res.status(401).json({
        success: false,
        message: "Authentication required. Please log in.",
      });
      return;
    }

    const decoded = verifyToken(token);
    const { admin, blocked } = await resolveAdminSession(decoded);

    if (blocked) {
      res.status(403).json({
        success: false,
        blocked: true,
        message:
          "You are blocked by the site admin. Please contact Bottail SS.",
      });
      return;
    }

    if (!admin) {
      res.status(401).json({
        success: false,
        message: "Invalid or expired session. Please log in again.",
      });
      return;
    }

    req.admin = admin;
    req.adminId = admin.id;
    next();
  } catch {
    res.status(401).json({
      success: false,
      message: "Invalid or expired session. Please log in again.",
    });
  }
}

/** Duty person or admin — can save / modify operational data */
export function requireDuty(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  void requireAuth(req, res, () => {
    if (req.admin?.role === "viewer") {
      res.status(403).json({
        success: false,
        message:
          "Viewers cannot save or modify data. Duty person or admin required.",
      });
      return;
    }
    next();
  });
}

/** Admin only — settings & users */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  void requireAuth(req, res, () => {
    if (req.admin?.role !== "admin") {
      res.status(403).json({
        success: false,
        message: "Admin access required",
      });
      return;
    }
    next();
  });
}

export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = getTokenFromRequest(req);
    if (token) {
      const decoded = verifyToken(token);
      const { admin, blocked } = await resolveAdminSession(decoded);
      if (admin && !blocked) {
        req.admin = admin;
        req.adminId = admin.id;
      }
    }
  } catch {
    // ignore invalid optional token
  }
  next();
}
