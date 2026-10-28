/**
 * Local development entrypoint.
 * Production / Vercel uses api/index.js (same app).
 * Keep this file as a thin wrapper so `node server.js` always matches the real API.
 */
module.exports = require("./api/index.js");
