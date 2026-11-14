# WZPDCL Kushtia Circle — Express API

All application APIs, authentication, authorization, database access, and AI-provider calls live in this project. The Next.js client is UI-only and calls this API using `NEXT_PUBLIC_API_URL`.

## Local setup

```bash
cp .env.example .env
npm install
npm run dev
```

The API listens on `http://localhost:5000` by default. Configure MongoDB and secrets in this project's `.env`.

## Deploy

Deploy this folder as a Node/Express service (or the included Vercel function entrypoint). Set `MONGODB_URI`, `JWT_SECRET`, `JWT_EXPIRY`, `ADMIN_REGISTRATION_SECRET`, `FRONTEND_URL`, and optional `GROQ_API_KEY` / `GROQ_MODEL` in the backend environment. `FRONTEND_URL` must contain the exact production frontend origin(s), comma-separated.

## Frontend configuration

In the client project set `NEXT_PUBLIC_API_URL` to the public base URL of this API, without a trailing slash, for example `https://your-api.example.com`. Do not put MongoDB credentials, JWT secrets, registration secrets, or Groq keys in the frontend environment.

## API groups

- `/api/auth` — login, logout, session, profile, password, registration
- `/api/calculations` — calculation CRUD, history/trash, max-load, slot conflict
- `/api/settings` — application settings
- `/api/admin/users` and `/api/admin/duty-roster` — administration
- `/api/circle-load` — circle sheet, entries, district-day, stations
- `/api/station-notes` and `/api/shift-messages` — operational messages
- `/api/admin/monthly-energy` — monthly energy sheets
- `/api/night-log/generate` — local-seed + optional Groq refinement
- `/api/health` — API/database health
