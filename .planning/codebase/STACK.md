# Technology Stack
_Last updated: 2026-06-15 | Focus: tech_

## Summary

FuelSense is a full-stack fleet fuel monitoring platform. The frontend is a Next.js 16 / React 19 TypeScript app deployed to Netlify. The backend is a Node.js Express 5 API co-located with a raw TCP server for Teltonika GPS hardware, using PostgreSQL with Drizzle ORM, deployed to AWS EC2.

---

## Languages

**Primary:**
- TypeScript 5 — frontend (`frontend/src/`)
- JavaScript (CommonJS) — backend (`backend/src/`); no TypeScript compilation step

**Secondary:**
- CSS (Tailwind v4 via PostCSS) — frontend styling

## Runtime

**Environment:**
- Node.js — both frontend (Next.js) and backend (Express)
- No `.nvmrc` or `.node-version` detected; version is inferred from Docker base image in `backend/Dockerfile`

**Package Manager:**
- npm (lockfiles: `frontend/package-lock.json`, `backend/package-lock.json`)

---

## Frontend (`frontend/`)

**Framework:**
- Next.js `16.2.6` (App Router) — `frontend/src/app/`
- React `19.2.4` — component layer

**Key pages (App Router):**
- `frontend/src/app/page.tsx` — landing / root redirect
- `frontend/src/app/login/page.tsx` — customer login
- `frontend/src/app/register/page.tsx` — customer registration
- `frontend/src/app/onboarding/page.tsx` — post-registration onboarding flow
- `frontend/src/app/dashboard/page.tsx` — fleet operator dashboard (primary UI)
- `frontend/src/app/driver/page.tsx` — driver mobile portal
- `frontend/src/app/dashboard/orders/new/page.tsx` — device order form

**Styling:**
- Tailwind CSS `^4` via `@tailwindcss/postcss` — config at `frontend/postcss.config.mjs`
- Google Fonts via `next/font/google` (Geist Sans, Geist Mono) — `frontend/src/app/layout.tsx`

**Build / Dev:**
- Next.js dev server: `npm run dev` → `next dev`
- Production build: `npm run build` → `next build`
- Output: `frontend/.next/`

**Key frontend dependencies:**
- `@vis.gl/react-google-maps ^1.8.3` — Google Maps integration for fleet map and live monitoring (`frontend/src/components/FleetMap.tsx`, `frontend/src/components/dashboard/LiveMonitoringMap.tsx`)
- `lucide-react ^1.16.0` — icon library used across all dashboard components
- `lottie-react ^2.4.1` — Lottie animations used in loading states (`frontend/src/components/dashboard/FleetCommandLoader.tsx`)
- `axios ^1.16.1` — listed as dependency but **not used** in source; all HTTP is done via native `fetch` in `frontend/src/lib/api.ts` and `frontend/src/lib/driver-api.ts`

**Dev dependencies:**
- `eslint ^9` + `eslint-config-next 16.2.6` — linting (`frontend/eslint.config.mjs`)
- `@netlify/plugin-nextjs ^5.15.11` — Netlify deployment adapter
- `typescript ^5`, `@types/react ^19`, `@types/react-dom ^19`, `@types/node ^20` — type checking

**Linting / Formatting:**
- ESLint configured via `frontend/eslint.config.mjs`
- No Prettier config detected
- Run: `npm run lint` (runs `eslint`)

**Testing:**
- No test framework configured or test files detected

**API client pattern:**
- Token stored in `localStorage` under key `fuelsense_token`
- All requests use `fetch` with `Authorization: Bearer <token>` header
- Base URL from `NEXT_PUBLIC_API_URL` env var
- Client: `frontend/src/lib/api.ts` (fleet/customer routes), `frontend/src/lib/driver-api.ts` (driver portal routes)

---

## Backend (`backend/`)

**Framework:**
- Express `^5.2.1` — REST API server (`backend/src/server.js`)
- Custom TCP server — Teltonika hardware connection layer (`backend/src/tcp-server.js`)

**Language:**
- JavaScript (CommonJS `require`/`module.exports`); no build step

**Entry point:**
- `backend/src/server.js` — starts Express HTTP server + TCP server, registers all routes

**Dev tooling:**
- nodemon `^3.1.14` — `npm run dev` restarts on file change
- No linter, formatter, or test runner configured

**Key backend dependencies:**
- `express ^5.2.1` — HTTP API
- `@groupe-savoy/teltonika-sdk ^0.3.1` — Teltonika TCP protocol decoder (Codec8e/Codec12); used in `backend/src/tcp-server.js`
- `drizzle-orm ^0.45.2` — ORM/query builder for PostgreSQL
- `pg ^8.21.0` — PostgreSQL client (node-postgres connection pool)
- `jsonwebtoken ^9.0.3` — JWT signing and verification (`backend/src/middleware/auth.js`)
- `bcryptjs ^3.0.3` — password hashing (cost factor 12) (`backend/src/routes/auth.js`)
- `cors ^2.8.6` — CORS middleware (permissive, no origin restriction detected)
- `dotenv ^17.4.2` — environment variable loading

**Dev dependencies:**
- `drizzle-kit ^0.31.10` — schema migrations and push (`backend/drizzle.config.js`)
- `nodemon ^3.1.14` — dev server restart

---

## Database

**Engine:** PostgreSQL 16 (Docker image `postgres:16-alpine` for local dev)

**ORM / Query layer:** Drizzle ORM `^0.45.2`
- Schema definition: `backend/src/db/schema.js`
- DB client factory: `backend/src/db/index.js`
- Migration config: `backend/drizzle.config.js`
- Commands: `npm run db:generate` (generate migrations), `npm run db:push` (push to DB)

**Schema tables:**
- `customers` — fleet operator accounts
- `drivers` — drivers linked to a customer fleet
- `vehicles` — fleet vehicles with tank capacity
- `devices` — Teltonika hardware (IMEI-keyed), linked to vehicles
- `telemetry` — raw GPS/fuel/odometer records from devices (bigserial PK, high-volume)
- `alerts` — anomaly alerts generated by the anomaly detector
- `siphon_events` — confirmed fuel theft/siphoning events
- `fuel_receipts` — driver-uploaded fuel receipts with OCR-parsed fields
- `fuel_purchases` — reconciled fuel purchase records
- `subscriptions` — customer subscription plans
- `payments` — payment records (Paystack reference field, manual for now)
- `device_orders` — device hardware orders

**Connection:**
- `pg.Pool` with `DATABASE_URL` env var
- SSL enabled (`rejectUnauthorized: false`) — supports both local Docker and Neon PostgreSQL (production)
- Local dev: Docker on port `5434` (maps to container `5432`)
- Production: Neon PostgreSQL (serverless PostgreSQL, connection via `DATABASE_URL` with `sslmode=require`)

---

## Auth

**Approach:** Custom JWT (stateless, no session store)

**Implementation:** `backend/src/middleware/auth.js`
- Two token types: customer (fleet operator) and driver
- JWT signed with `JWT_SECRET` env var
- Customer tokens expire in `JWT_EXPIRES_IN` (default `7d`)
- Driver tokens expire in `DRIVER_JWT_EXPIRES_IN` (default `30d`)
- Roles enforced: `authenticateCustomer` rejects driver tokens; `authenticateDriver` rejects customer tokens

**Password hashing:** bcryptjs, cost factor 12

**Frontend token storage:** `localStorage` (key: `fuelsense_token`)

---

## Infrastructure / Deployment

**Backend:**
- **Dev:** Docker Compose (`docker-compose.yml`) — runs PostgreSQL + backend container
  - HTTP port: `5001`
  - TCP port: `5027` (Teltonika hardware)
- **Production:** AWS EC2 (eu-north-1 region)
  - Instance: `ec2-13-61-2-216.eu-north-1.compute.amazonaws.com`
  - Deploy via `rsync` from local Mac (no CI pipeline)
  - Backend runs as Node.js process on EC2; `backend/Dockerfile` available but optional
  - TCP port `5027` must be open in EC2 Security Group

**Frontend:**
- **Dev:** `next dev` (Turbopack)
- **Production:** Netlify
  - Config: `frontend/netlify.toml` (base: `frontend`, build: `npm run build`, publish: `.next`)
  - Plugin: `@netlify/plugin-nextjs ^5.15.11`

**CI/CD:**
- No automated CI pipeline detected
- Backend: manual rsync + SSH deploy
- Frontend: Netlify auto-deploy on git push (inferred from Netlify config)

---

## Environment Variables

**Backend (`.env` / `backend/.env.example`):**
- `PORT` — HTTP server port (default `5001`)
- `TCP_PORT` — Teltonika TCP port (default `5027`)
- `DATABASE_URL` — PostgreSQL connection string
- `NODE_ENV` — `development` | `production`
- `JWT_SECRET` — JWT signing secret
- `JWT_EXPIRES_IN` — customer token TTL (default `7d`)
- `FUEL_PRICE_NGN_LITER` — fuel price used for loss calculations (default `1340`)
- `OCR_SPACE_API_KEY` — OCR.space API key (falls back to public demo key)
- `REAL_DEVICE_IMEI` — IMEI of the physical Teltonika FMC150 device
- `REAL_DEVICE_CCID` — SIM card CCID of the physical device
- `REAL_DEVICE_TANK_LITERS` — tank capacity for the real device (default `60`)
- `ENABLE_FLEET_SIMULATOR` — `true` enables the demo simulator (dev only)
- `PRICE_PER_TRACKER_NGN` — device order price (default `120000`)

**Frontend env vars:**
- `NEXT_PUBLIC_API_URL` — backend API base URL
- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` — Google Maps JS API key
- `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` — Google Maps Map ID (optional, enables Cloud-based styling)
- `CACHE_GEOCODE` — `true` enables in-memory geocode result caching (`frontend/src/lib/geocode-cache.ts`)

---

*Stack analysis: 2026-06-15*
