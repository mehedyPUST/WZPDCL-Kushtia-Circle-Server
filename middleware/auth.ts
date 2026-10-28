const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = process.env.JWT_EXPIRY || "7d";

if (!JWT_SECRET) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET environment variable is required in production");
  }
  console.warn(
    "[auth] JWT_SECRET is not set — using insecure dev fallback. Set JWT_SECRET before deploying."
  );
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || "dev-only-change-me";

/** Normalize legacy roles → viewer | duty | admin */
function normalizeRole(role) {
  const r = String(role || "").toLowerCase().replace(/_/g, "-");
  if (r === "viewer") return "viewer";
  if (r === "circle-load-input" || r === "circleloadinput" || r === "circle-input")
    return "circle-load-input";
  if (r === "duty" || r === "duty-person" || r === "operator") return "duty";
  if (r === "admin" || r === "superadmin") return "admin";
  return "viewer";
}

function generateToken(adminId, username, role) {
  return jwt.sign(
    { id: String(adminId), username, role: normalizeRole(role) },
    EFFECTIVE_JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function getTokenFromRequest(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }
  if (req.cookies && req.cookies.admin_token) {
    return req.cookies.admin_token;
  }
  return null;
}

function attachAdmin(decoded) {
  return {
    id: decoded.id,
    username: decoded.username,
    role: normalizeRole(decoded.role),
  };
}

function requireAuth(req, res, next) {
  try {
    const token = getTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authentication required. Please log in.",
      });
    }
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    req.admin = attachAdmin(decoded);
    req.adminId = req.admin.id;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired session. Please log in again.",
    });
  }
}

/** Duty person or admin — can save / modify operational data */
function requireDuty(req, res, next) {
  requireAuth(req, res, () => {
    if (req.admin.role === "viewer") {
      return res.status(403).json({
        success: false,
        message: "Viewers cannot save or modify data. Duty person or admin required.",
      });
    }
    next();
  });
}

/** Admin only — settings & users */
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.admin.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Admin access required",
      });
    }
    next();
  });
}

function optionalAuth(req, res, next) {
  try {
    const token = getTokenFromRequest(req);
    if (token) {
      const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
      req.admin = attachAdmin(decoded);
      req.adminId = req.admin.id;
    }
  } catch {
    // ignore
  }
  next();
}

module.exports = {
  generateToken,
  requireAuth,
  requireDuty,
  requireAdmin,
  optionalAuth,
  getTokenFromRequest,
  normalizeRole,
};
