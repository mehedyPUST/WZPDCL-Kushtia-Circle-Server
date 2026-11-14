import "dotenv/config";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cookieParser from "cookie-parser";
import { corsMiddleware } from "../config/cors.js";
import { connectDB, isDbConnected } from "../config/db.js";
import authRouter from "../routes/auth.js";
import calculationsRouter from "../routes/calculations.js";
import settingsRouter from "../routes/settings.js";
import adminUsersRouter from "../routes/adminUsers.js";
import dutyRosterRouter from "../routes/dutyRoster.js";
import circleLoadRouter from "../routes/circleLoad.js";
import stationNotesRouter from "../routes/stationNotes.js";
import monthlyEnergyRouter from "../routes/monthlyEnergy.js";

const app = express();

app.use(corsMiddleware);
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req: Request, res: Response) => {
  res.json({
    success: true,
    message: "Load Calculator API is running",
    health: "/api/health",
    db: isDbConnected() ? "connected" : "disconnected",
  });
});

app.use("/api", async (req: Request, _res: Response, next: NextFunction) => {
  if (
    req.path === "/health" ||
    req.path === "/circle-load/stations" ||
    req.path === "/auth/logout" ||
    req.path === "/auth/check"
  ) {
    next();
    return;
  }

  try {
    await connectDB();
  } catch (err) {
    console.warn(
      "DB connection check failed:",
      err instanceof Error ? err.message : err
    );
  }

  if (!isDbConnected()) {
    const offlineErr = new Error("Database offline");
    offlineErr.name = "MongooseError";
    next(offlineErr);
    return;
  }

  next();
});

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    success: true,
    message: "Load Calculator API is running",
    db: isDbConnected() ? "connected" : "disconnected",
    environment: process.env.NODE_ENV || "development",
  });
});

app.use("/api/auth", authRouter);
app.use("/api/calculations", calculationsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/admin/users", adminUsersRouter);
app.use("/api/admin/duty-roster", dutyRosterRouter);
app.use("/api/circle-load", circleLoadRouter);
app.use("/api/station-notes", stationNotesRouter);
app.use("/api/admin/monthly-energy", monthlyEnergyRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

app.use(
  (err: any, req: Request, res: Response, _next: NextFunction): void => {
    if (err && String(err.message || "").startsWith("CORS blocked")) {
      res.status(403).json({ success: false, message: err.message });
      return;
    }

    if (
      err &&
      (err.name === "MongooseError" ||
        err.name === "MongoNetworkError" ||
        String(err.message || "").includes("buffering timed out"))
    ) {
      console.warn("[AI Studio] Database offline — returning fallback response");
      if (req.method === "GET") {
        res.json(
          req.path.endsWith("s") || req.path.endsWith("s/") ? [] : {}
        );
        return;
      }
      res.status(503).json({
        success: false,
        error: "Service temporarily unavailable (database offline)",
      });
      return;
    }

    console.error("Unhandled error:", err);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: process.env.NODE_ENV === "development" ? err?.message : undefined,
    });
  }
);

export function startServer() {
  const PORT = Number(process.env.PORT) || 3000;
  connectDB().catch(() => {});
  return app.listen(PORT, "0.0.0.0", () => {
    console.log(`API running on http://0.0.0.0:${PORT}`);
  });
}

if (require.main === module) {
  startServer();
}

export default app;
