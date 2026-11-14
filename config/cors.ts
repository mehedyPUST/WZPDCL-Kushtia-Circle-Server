import cors from "cors";

const DEFAULT_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
];

export function isOriginAllowed(origin?: string): boolean {
  if (!origin) return true;

  const fromEnv = (process.env.FRONTEND_URL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowed = new Set([...DEFAULT_ORIGINS, ...fromEnv]);
  if (allowed.has(origin)) return true;

  try {
    const host = new URL(origin).hostname;
    if (host.endsWith(".vercel.app") || host.endsWith(".run.app")) {
      return true;
    }
  } catch {
    // ignore malformed origin
  }

  return false;
}

export const corsMiddleware = cors({
  origin(origin, callback) {
    if (isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      console.warn("[CORS] blocked:", origin);
      callback(new Error(`CORS blocked for origin: ${origin}`));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
});
