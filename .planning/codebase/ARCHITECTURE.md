# Architecture
_Last updated: 2026-06-15 | Focus: arch_

## Summary

FuelSense is a two-tier web application: a Next.js 16 frontend (React 19, App Router) and a Node.js/Express 5 backend. The backend simultaneously serves a REST API over HTTP (port 5001) and a raw TCP server (port 5027) that ingests live telemetry from Teltonika FMC150 GPS/fuel trackers. All persistent state lives in PostgreSQL 16 via Drizzle ORM. The system monitors fleet fuel consumption, detects fuel theft and receipt fraud, and surfaces the results to fleet managers and drivers through separate UI portals.

---

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────┐
│                         Next.js 16 Frontend                         │
│  App Router: /  /login  /register  /onboarding  /dashboard  /driver │
│  `frontend/src/`                                                     │
└────────────────────────────┬────────────────────────────────────────┘
                             │  REST (HTTP fetch)
                             │  Bearer JWT in Authorization header
                             │  Base URL: NEXT_PUBLIC_API_URL
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Express 5 REST API (port 5001)                   │
│  Routes: /api/auth  /api/vehicles  /api/devices  /api/telemetry     │
│          /api/alerts  /api/dashboard  /api/drivers  /api/driver      │
│          /api/fuel-events  /api/orders                               │
│  `backend/src/server.js`                                             │
└──────────────┬─────────────────────────────────┬────────────────────┘
               │                                 │
               │  Drizzle ORM (pg pool)          │  in-process
               ▼                                 ▼
┌──────────────────────────┐     ┌───────────────────────────────────┐
│  PostgreSQL 16           │     │  Teltonika TCP Server (port 5027) │
│  database: fuelguard     │     │  @groupe-savoy/teltonika-sdk      │
│  `backend/src/db/`       │◄────│  Codec8e + Codec12 (GPRS)         │
│                          │     │  `backend/src/tcp-server.js`      │
└──────────────────────────┘     └──────────────┬────────────────────┘
                                                │
                                  Real devices or fleet-simulator.js
                                  (TCP clients sending Codec8e packets)
```

---

## Component Responsibilities

| Component | Responsibility | Key File |
|-----------|----------------|----------|
| Express HTTP server | Route registration, CORS, JSON body parsing, server boot | `backend/src/server.js` |
| TCP server | Accepts Teltonika device connections, decodes Codec8e packets, persists telemetry | `backend/src/tcp-server.js` |
| Anomaly detector | Fuel theft, excessive-idle, and receipt-fraud detection engine (10-rule scoring) | `backend/src/lib/anomaly-detector.js` |
| Database init | Creates/migrates all tables at startup via `ensureColumn` helpers | `backend/src/db/index.js` |
| Drizzle schema | Canonical table definitions and TypeScript types | `backend/src/db/schema.js` |
| Auth middleware | JWT sign/verify, two-role separation (customer vs. driver) | `backend/src/middleware/auth.js` |
| Fleet simulator | Dev-only TCP client that feeds simulated Codec8e packets into the TCP server | `backend/src/fleet-simulator.js` |
| Next.js frontend | React 19 SPA using App Router; all pages are client components (`'use client'`) | `frontend/src/` |
| API client | Typed `fetch` wrapper with auto-JWT injection and `localStorage` token management | `frontend/src/lib/api.ts` |
| Driver API client | Separate token key and typed interfaces for driver portal routes | `frontend/src/lib/driver-api.ts` |

---

## Architectural Pattern

**Overall:** Layered monolith with an event-driven telemetry ingestion side-channel.

**Key Characteristics:**
- REST API follows a flat-router pattern: one Express Router file per resource domain, all mounted directly in `server.js`.
- TCP ingestion is event-driven: the Teltonika SDK emits `init`, `data`, `timeout`, and `error` events; handlers are registered in `tcp-server.js`.
- Anomaly detection runs synchronously in-process after every telemetry row insert. There is no message queue.
- The frontend is a purely client-rendered SPA. All pages carry `'use client'`. No server-side data fetching (no `getServerSideProps`, no RSC data loaders) is in use.
- Multi-tenancy is enforced at the query level: every database query filters by `customerId` derived from the verified JWT.

---

## Layers

**HTTP Routes (`backend/src/routes/`):**
- Purpose: Accept HTTP requests, validate auth, delegate to DB helpers or lib functions, return JSON.
- Depends on: `middleware/auth.js`, `lib/db-helpers.js`, various `lib/*.js` helpers.
- Used by: Next.js frontend via `fetch`.

**Middleware (`backend/src/middleware/auth.js`):**
- Purpose: JWT verification. Provides `authenticateCustomer` and `authenticateDriver` — two separate guards with role-checks that block cross-role access.
- Depends on: `jsonwebtoken`, env vars `JWT_SECRET`, `JWT_EXPIRES_IN`, `DRIVER_JWT_EXPIRES_IN`.

**Library (`backend/src/lib/`):**
- Purpose: Business logic (anomaly detection, fuel metrics, receipt reconciliation, SQL builders, simulator helpers).
- Notable files:
  - `anomaly-detector.js` — in-memory per-IMEI state maps for idling streaks and last-seen fuel; persists alerts and siphon events.
  - `fuel-metrics.js` — efficiency thresholds, NGN price constants, unit converters.
  - `fleet-efficiency-sql.js`, `daily-activity-sql.js`, `telemetry-deltas-sql.js` — complex analytics queries as parameterized SQL builders.
  - `receipt-reconciliation.js` — OBD-vs-declared-liters matching via window SQL.
  - `event-replay.js` — loads a 30-minute telemetry window around an anomaly timestamp.
  - `siphon-recorder.js` — writes confirmed theft events to `siphon_events`.

**Database (`backend/src/db/`):**
- `index.js`: Drizzle client init (`Pool` → `drizzle`), `initDatabase()` called at server start (creates tables idempotently).
- `schema.js`: Drizzle table definitions — single source of truth for column types.
- `queries.js`: Shared query helpers (referenced but not yet reviewed in detail).

**Frontend Library (`frontend/src/lib/`):**
- `api.ts` — all fleet-manager API calls; typed request/response interfaces.
- `driver-api.ts` — driver-portal API calls with separate JWT storage key.
- `driver-offline-queue.ts` — offline receipt queue for drivers (IndexedDB or localStorage).
- `map-utils.ts`, `fleet-map-theme.ts` — Google Maps utilities.
- `receipt-ocr.ts` — client-side OCR for receipt image scanning.
- `replay-intelligence.ts`, `replay-target.ts` — event replay logic for the anomaly panel.
- `trust-language.ts` — human-readable confidence descriptions for anomaly UI.

---

## Data Flow

### Primary Request Path (Fleet Manager → Dashboard)

1. Browser loads `/` (`frontend/src/app/page.tsx`): checks `localStorage` for token, calls `GET /api/auth/me`, redirects to `/dashboard` or `/login`.
2. Dashboard page (`frontend/src/app/dashboard/page.tsx`) polls multiple endpoints every 3 s (general) / 2 s (live view) using the `api<T>()` helper.
3. `api()` (`frontend/src/lib/api.ts`): reads `fuelsense_token` from `localStorage`, sets `Authorization: Bearer <token>`, calls `fetch`.
4. Request hits Express. `authenticateCustomer` middleware verifies JWT, extracts `customerId`, attaches to `req.user`.
5. Route handler queries PostgreSQL via Drizzle, returns JSON.
6. Frontend updates React state, re-renders panel components.

### Telemetry Ingestion Path (Device → Database → Alert)

1. Teltonika FMC150 device (or `fleet-simulator.js`) opens a TCP connection to port 5027.
2. SDK emits `init` event: `tcp-server.js` looks up the IMEI in `devices` table; accepts or rejects.
3. SDK emits `data` event per packet. `saveTelemetry()` decodes IO element IDs (390/270/30 for CAN fuel; 89 for OBD fuel %; 112 for odometer; 239 for ignition), builds a telemetry row, inserts it.
4. `detectAnomalies()` (`lib/anomaly-detector.js`) is called immediately after insert:
   - Checks for excessive idling (in-memory streak counter per IMEI).
   - Checks for refuel events and simulates receipt fraud for demo vehicle `LAG-456-CD`.
   - Runs the 10-rule noise-proof theft detection engine (requires ≥2 history rows, 3-minute validation window, rebound check, speed check, direction-change noise filter, confidence scoring).
5. If anomaly confirmed: inserts an `alerts` row (score ≥ 80) and a `siphon_events` row.
6. Frontend poll picks up new alerts on next refresh cycle.

### Driver Receipt Upload Path

1. Driver logs in at `/driver` with `driver_code` + PIN → `POST /api/driver/login` → receives driver JWT (30-day expiry).
2. Driver uploads receipt photo on the Fuel screen → `POST /api/driver/receipts` with multipart or base64 image.
3. Backend calls `scanReceiptImage()` (OCR) → `parseReceiptText()` → `findObdRefuelMatch()` (cross-reference OBD telemetry) → inserts `fuel_receipts` row.
4. Receipt reconciliation status is set to `pending` until OBD data confirms or disputes the declared liters.

### Event Replay Path

1. Fleet manager clicks an anomaly in the dashboard → frontend calls `GET /api/telemetry/event-replay?...`.
2. `event-replay.js` loads a ±30-minute telemetry window around the anomaly timestamp, downsamples to ≤120 readings.
3. Frontend renders time-series chart with annotated `moments` (drop, rise, idle start, trip start).

---

## Authentication & Authorization

**Two-Role JWT System:**

| Role | Login endpoint | Token key | JWT payload | Guard middleware | Protected routes |
|------|---------------|-----------|-------------|-----------------|-----------------|
| Customer (fleet manager) | `POST /api/auth/login` | `fuelsense_token` | `{ customerId, email, name }` | `authenticateCustomer` | All `/api/*` except `/api/driver/*` |
| Driver | `POST /api/driver/login` | `fuelsense_driver_token` | `{ role: 'driver', driverId, customerId, driverCode, name }` | `authenticateDriver` | `/api/driver/*` |

- Customer tokens are rejected on driver routes (`payload.role === 'driver'` check).
- Driver tokens are rejected on fleet routes (missing `role` field check).
- Both token types share the same `JWT_SECRET`. Separation is purely by role field inspection.
- Passwords are hashed with `bcryptjs` (salt rounds: 12). Driver PINs also use `bcryptjs`.
- Token storage: `localStorage` in the browser (no HttpOnly cookies).

---

## Database Schema

**PostgreSQL 16. Drizzle ORM. Schema defined in `backend/src/db/schema.js`.**

### Core Tables and Key Relationships

```
customers (id UUID PK)
  ├── vehicles (customer_id FK → customers.id CASCADE)
  │     └── devices (vehicle_id FK → vehicles.id SET NULL)
  ├── drivers (customer_id FK → customers.id CASCADE)
  │     └── vehicles.driver_id FK → drivers.id SET NULL
  ├── telemetry (customer_id, vehicle_id, imei)
  ├── alerts (customer_id, vehicle_id, imei)
  ├── siphon_events (customer_id, vehicle_id, driver_id SET NULL, alert_id)
  ├── fuel_receipts (customer_id, vehicle_id, driver_id)
  ├── fuel_purchases (customer_id, vehicle_id)
  ├── subscriptions (customer_id FK CASCADE)
  ├── payments (customer_id FK CASCADE, subscription_id SET NULL)
  └── device_orders (customer_id FK CASCADE)
```

### Table Summary

| Table | PK | Purpose |
|-------|----|---------|
| `customers` | `uuid` | Fleet operator accounts |
| `vehicles` | `uuid` | Fleet vehicles, linked to a customer and optionally a driver |
| `drivers` | `uuid` | Drivers belonging to a customer; have `driver_code` + PIN for portal login |
| `devices` | `imei varchar(20)` | Teltonika trackers; linked to vehicle + customer |
| `telemetry` | `bigserial` | Raw sensor readings: fuel, odometer, GPS, speed, ignition |
| `alerts` | `bigserial` | Fuel theft / idle / receipt fraud alerts generated by anomaly detector |
| `siphon_events` | `uuid` | Confirmed/suspected fuel theft incidents with evidence fields |
| `fuel_receipts` | `uuid` | Driver-uploaded fuel receipts awaiting OBD reconciliation |
| `fuel_purchases` | `uuid` | Aggregated purchase records (from receipts or telemetry) |
| `subscriptions` | `uuid` | Customer subscription plans |
| `payments` | `uuid` | Payment records tied to subscriptions |
| `device_orders` | `uuid` | Orders for physical Teltonika tracker hardware |

### Key Indexes

- `telemetry (customer_id, recorded_at DESC)` — all time-range queries
- `telemetry (vehicle_id, recorded_at DESC)` — per-vehicle history
- `telemetry (imei, recorded_at DESC)` — device-centric queries
- `alerts (customer_id, created_at DESC)` — dashboard alert feeds
- `siphon_events (vehicle_id, occurred_at DESC)` — theft history per vehicle
- `fuel_receipts (vehicle_id, transaction_date DESC)` — receipt reconciliation lookups
- `drivers (driver_code) WHERE driver_code IS NOT NULL` — driver login (unique partial index)

---

## Background Jobs & Async Processing

**Fleet Simulator (dev only):**
- Enabled when `ENABLE_FLEET_SIMULATOR=true` AND `NODE_ENV !== 'production'`.
- Started via `setTimeout(..., 2500)` after HTTP server is listening.
- `fleet-simulator.js` spawns one `VehicleSimulator` per fleet profile, each opening its own TCP socket to `localhost:5027` and sending Codec8e packets every `MOCK_INTERVAL_MS` ms (default 4000).

**Anomaly Detection (synchronous in-process):**
- Not a background job — runs inline in the TCP data-event handler after every telemetry insert.
- Holds per-IMEI in-memory state (`Map` objects for idle streak, last fuel, etc.); state is lost on process restart.
- 24-hour vehicle baseline cache (`baselineCache Map`) reduces DB queries.

**Database Backfill on Startup:**
- `initDatabase()` calls `backfillDriverReceiptPurchases(db)` and `syncDemoVehicleDrivers(db)` at every server start to keep `fuel_purchases` and vehicle-driver assignments consistent.

**Polling (frontend):**
- Dashboard polls REST endpoints every 3000 ms (overview data) and 2000 ms (live vehicle positions/telemetry).
- No WebSocket or SSE — all real-time feel is achieved through polling.

---

## Error Handling

- HTTP routes: `try/catch` around every async operation; uncaught errors return `500 { error: error.message }`.
- TCP server: per-device `try/catch` in `saveTelemetry`; errors are logged, device connection is not dropped.
- Frontend `api()`: throws `Error(data.error || 'Request failed (status)')` on non-2xx responses; callers handle with `.catch()` or try/catch in `useEffect`.

---

## Cross-Cutting Concerns

**Logging:** `console.log` / `console.error` throughout. Real device packets are distinguished by `[REAL DEVICE]` prefix. Anomaly engine uses `[Theft Engine]` prefix.

**Validation:** Input validation is manual in route handlers (presence checks, type coercion). No schema validation library (e.g., Zod) is in use.

**Multi-tenancy:** Enforced via `customerId` extracted from JWT and applied as a WHERE clause filter on every query. No row-level security in PostgreSQL.

**Currency:** All monetary values are in Nigerian Naira (NGN). UI helpers `formatNgn()` and `formatFuelPricePerLiter()` in `frontend/src/lib/api.ts` enforce this.
