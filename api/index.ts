require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const calculationsRouter = require("../routes/calculations");
const settingsRouter = require("../routes/settings");
const adminUsersRouter = require("../routes/adminUsers");
const circleLoadRouter = require("../routes/circleLoad");
const authRouter = require("../routes/auth");

const app = express();

/**
 * Allowed browser origins for credentialed requests.
 * Set FRONTEND_URL on Vercel to your real frontend URL(s), comma-separated.
 * Also allows localhost and *.vercel.app so previews work.
 */
function isOriginAllowed(origin) {
  if (!origin) return true; // same-origin / curl / server-to-server

  const defaults = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
  ];

  const fromEnv = (process.env.FRONTEND_URL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowed = new Set([...defaults, ...fromEnv]);
  if (allowed.has(origin)) return true;

  // Vercel production + preview deployments of the frontend
  try {
    const host = new URL(origin).hostname;
    if (host.endsWith(".vercel.app")) return true;
  } catch {
    // ignore
  }

  return false;
}

app.use(
  cors({
    origin(origin, callback) {
      if (isOriginAllowed(origin)) {
        callback(null, true);
      } else {
        console.warn("[CORS] blocked:", origin);
        callback(new Error(`CORS blocked for origin: ${origin}`));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));

let cached = global.mongoose;
if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function connectDB() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not set");
  }
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    cached.promise = mongoose
      .connect(process.env.MONGODB_URI, { bufferCommands: false })
      .then((m) => m);
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

app.use("/api", async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error("DB connection failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Database connection failed",
      error: error.message,
    });
  }
});

app.get("/api/health", async (req, res) => {
  res.json({
    success: true,
    message: "Load Calculator API is running",
    db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    environment: process.env.NODE_ENV || "development",
  });
});

app.use("/api/auth", authRouter);
app.use("/api/calculations", calculationsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/admin/users", adminUsersRouter);
app.use("/api/circle-load", circleLoadRouter);

app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

app.use((err, req, res, next) => {
  // CORS errors
  if (err && String(err.message || "").startsWith("CORS blocked")) {
    return res.status(403).json({
      success: false,
      message: err.message,
    });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({
    success: false,
    message: "Internal server error",
    error: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  connectDB()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`API running on http://localhost:${PORT}`);
      });
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = app;
