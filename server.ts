/**
 * Local development entrypoint.
 * Production / Vercel uses api/index.ts (same app).
 */
import app, { startServer } from "./api/index.js";

if (require.main === module) {
  startServer();
}

export default app;
