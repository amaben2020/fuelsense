# STRUCTURE
_Last updated: 2026-06-15 | Focus: arch_

## Summary
FuelSense is a monorepo with a clear frontend/backend split. The backend is a Node.js/Express app in `backend/src/` organized by concern (routes, lib, db, middleware). The frontend is a Next.js 14 App Router app in `frontend/src/` organized by feature (app routes, components, lib utilities).

---

## Directory Tree

```
FuelSense/
├── backend/                        # Node.js Express API + TCP server
│   ├── src/
│   │   ├── server.js               # HTTP server entry point
│   │   ├── tcp-server.js           # TCP/OBD-II telemetry ingestion server
│   │   ├── database.js             # Legacy DB connection (superseded by db/)
│   │   ├── codec8e-encoder.js      # Teltonika CODEC8E packet encoder
│   │   ├── mock-device.js          # Simulates a real OBD device over TCP
│   │   ├── fleet-simulator.js      # Sends simulated telemetry for a whole fleet
│   │   ├── db/
│   │   │   ├── index.js            # DB pool init + schema bootstrap (DROP+CREATE)
│   │   │   ├── schema.js           # Drizzle ORM schema definitions (all 11 tables)
│   │   │   └── queries.js          # Shared reusable query functions
│   │   ├── routes/
│   │   │   ├── auth.js             # Login / register / token refresh
│   │   │   ├── dashboard.js        # Aggregated fleet KPI endpoints
│   │   │   ├── vehicles.js         # Vehicle CRUD + telemetry history
│   │   │   ├── drivers.js          # Driver management (fleet manager view)
│   │   │   ├── driver.js           # Driver self-service endpoints
│   │   │   ├── devices.js          # OBD device pairing/status
│   │   │   ├── telemetry.js        # Raw telemetry read endpoints
│   │   │   ├── fuel-events.js      # Fuel fill/siphon event CRUD
│   │   │   ├── alerts.js           # Alert query/dismiss endpoints
│   │   │   └── orders.js           # Fuel order management
│   │   ├── lib/
│   │   │   ├── anomaly-detector.js # Siphon/fill anomaly detection engine
│   │   │   ├── siphon-recorder.js  # Persists confirmed siphon events
│   │   │   ├── simulator.js        # Core telemetry simulation logic
│   │   │   ├── fuel-metrics.js     # Fuel efficiency calculations
│   │   │   ├── receipt-ocr.js      # Cloud Vision OCR for fuel receipts
│   │   │   ├── receipt-parser.js   # Parses OCR text into structured data
│   │   │   ├── receipt-reconciliation.js  # Matches receipts to telemetry events
│   │   │   ├── driver-receipt-sync.js     # Syncs driver-uploaded receipts
│   │   │   ├── event-replay.js     # Replays historical telemetry sequences
│   │   │   ├── sync-vehicle-drivers.js    # Keeps vehicle↔driver assignments consistent
│   │   │   ├── db-helpers.js       # Low-level DB utility functions
│   │   │   ├── serialize.js        # JSON serialization helpers
│   │   │   ├── activity-thresholds.js     # Configurable anomaly thresholds
│   │   │   ├── daily-activity-sql.js      # SQL builder: daily activity aggregates
│   │   │   ├── fleet-efficiency-sql.js    # SQL builder: fleet efficiency report
│   │   │   ├── telemetry-deltas-sql.js    # SQL builder: telemetry delta queries
│   │   │   ├── demo-tracks.js      # Hardcoded GPS demo route coordinates
│   │   │   └── lagos-routes.js     # Lagos-specific route simulation data
│   │   ├── middleware/
│   │   │   └── auth.js             # JWT verification middleware
│   │   └── seed*.js                # One-off data seeding scripts (multiple)
│   ├── package.json
│   ├── drizzle.config.js           # Drizzle ORM config (points to schema.js)
│   ├── Dockerfile
│   └── .env.example
│
├── frontend/                       # Next.js 14 App Router (TypeScript)
│   ├── src/
│   │   ├── app/                    # Next.js App Router pages
│   │   │   ├── layout.tsx          # Root layout (fonts, providers)
│   │   │   ├── page.tsx            # Landing/root redirect
│   │   │   ├── globals.css         # Global Tailwind CSS
│   │   │   ├── login/page.tsx      # Login screen
│   │   │   ├── register/page.tsx   # Registration screen
│   │   │   ├── onboarding/page.tsx # Post-registration onboarding flow
│   │   │   ├── dashboard/
│   │   │   │   ├── page.tsx        # Fleet manager dashboard
│   │   │   │   └── orders/new/     # New fuel order flow
│   │   │   └── driver/page.tsx     # Driver mobile app view
│   │   ├── components/
│   │   │   ├── dashboard/          # Dashboard-specific panels and widgets
│   │   │   │   ├── AlertsList.tsx
│   │   │   │   ├── DailyActivityTable.tsx
│   │   │   │   ├── DashboardKpis.tsx
│   │   │   │   ├── EventReplayPanel.tsx
│   │   │   │   ├── FleetEfficiencyReport.tsx
│   │   │   │   ├── FleetListPanel.tsx
│   │   │   │   ├── FleetOperationsOverview.tsx
│   │   │   │   ├── FuelAnalyticsPanel.tsx
│   │   │   │   ├── FuelAnomaliesPanel.tsx
│   │   │   │   ├── FuelAnomalyModal.tsx
│   │   │   │   ├── LiveMonitoringMap.tsx
│   │   │   │   ├── ReceiptsPanel.tsx
│   │   │   │   ├── SavingsDashboard.tsx
│   │   │   │   ├── SiphonEventsSidebar.tsx
│   │   │   │   ├── TelemetryHistoryTable.tsx
│   │   │   │   ├── VehicleDetailPanel.tsx
│   │   │   │   └── ...
│   │   │   ├── driver/             # Driver PWA view components
│   │   │   │   ├── DriverFuelScreen.tsx
│   │   │   │   ├── DriverTabBar.tsx
│   │   │   │   ├── DriverTripsScreen.tsx
│   │   │   │   └── DriverVehicleScreen.tsx
│   │   │   ├── maps/
│   │   │   │   └── SharedMapLayers.tsx   # Reusable Mapbox layer config
│   │   │   ├── AddDeviceModal.tsx
│   │   │   ├── AuthLayout.tsx
│   │   │   ├── DashboardMetrics.tsx
│   │   │   ├── FleetMap.tsx
│   │   │   ├── FleetTable.tsx
│   │   │   └── VehicleDeviceFields.tsx
│   │   ├── lib/                    # Frontend utilities and API clients
│   │   │   ├── api.ts              # Axios/fetch wrapper for backend REST API
│   │   │   ├── driver-api.ts       # Driver-specific API calls
│   │   │   ├── driver-offline-queue.ts   # IndexedDB queue for offline receipt uploads
│   │   │   ├── fleet-map-theme.ts  # Mapbox style config
│   │   │   ├── geocode-cache.ts    # Client-side geocoding result cache
│   │   │   ├── map-utils.ts        # Mapbox helper functions
│   │   │   ├── receipt-ocr.ts      # Client-side OCR trigger
│   │   │   ├── replay-intelligence.ts    # Event replay state management
│   │   │   ├── replay-target.ts    # Replay target configuration
│   │   │   └── trust-language.ts   # Human-readable anomaly trust scores
│   │   └── assets/animations/      # Lottie / SVG animation files
│   ├── next.config.ts              # Next.js config (image domains, env passthrough)
│   ├── tsconfig.json               # TypeScript strict config
│   ├── eslint.config.mjs           # ESLint flat config
│   ├── postcss.config.mjs          # PostCSS (Tailwind pipeline)
│   ├── netlify.toml                # Netlify deployment config
│   └── .env.local.example
│
├── docker-compose.yml              # Orchestrates backend + PostgreSQL
├── README.md
└── DOCKER.md
```

---

## Frontend Organization

**App Router convention:** Each route is a folder under `src/app/` with a `page.tsx`. Layouts wrap child routes via `layout.tsx`.

**Component co-location:** Feature-specific components live in `src/components/<feature>/` (e.g., `dashboard/`, `driver/`). Shared/generic components sit directly in `src/components/`.

**Lib utilities:** `src/lib/` contains non-component logic — API clients, client-side caching, state helpers, OCR triggers. Files are named by domain (`api.ts`, `map-utils.ts`, not by type.

**Naming conventions:**
- Pages: `page.tsx` (Next.js convention)
- Components: `PascalCase.tsx` (e.g., `FleetMap.tsx`)
- Lib utilities: `kebab-case.ts` (e.g., `fleet-map-theme.ts`)
- Types: inline in the file that uses them (no separate `types/` directory)

---

## Backend Organization

**Routes layer:** `src/routes/` — one file per resource domain. Each file exports an Express Router and is mounted in `server.js`.

**Lib layer:** `src/lib/` — business logic that is not tied to HTTP. Includes domain algorithms (anomaly detection, fuel metrics), SQL builders (separate files per query type), and integrations (OCR, receipt parsing).

**DB layer:** `src/db/` — pool init, Drizzle schema, and shared query helpers. Routes and lib modules import from here.

**Naming conventions:**
- Route files: `kebab-case.js` matching the resource name (e.g., `fuel-events.js`)
- Lib files: `kebab-case.js` describing the concern (e.g., `anomaly-detector.js`)
- SQL builder files: suffix `-sql.js` (e.g., `daily-activity-sql.js`)
- Seed scripts: prefix `seed-` (e.g., `seed-fuel-purchases.js`)

---

## Entry Points

| Purpose | Command | File |
|---|---|---|
| HTTP API server | `npm run dev` / `npm start` | `backend/src/server.js` |
| TCP telemetry server | started inside `server.js` | `backend/src/tcp-server.js` |
| Mock OBD device | `npm run mock-device` | `backend/src/mock-device.js` |
| Fleet simulation | `npm run simulate-fleet` | `backend/src/fleet-simulator.js` |
| Seed all demo data | `npm run seed` | `backend/src/seed.js` |
| Frontend dev server | `npm run dev` (in frontend/) | Next.js default |
| Frontend production | `npm run build` (in frontend/) | Next.js default |

---

## Config Files

| File | Purpose |
|---|---|
| `backend/drizzle.config.js` | Points Drizzle Kit at `src/db/schema.js` and the DB URL |
| `backend/.env.example` | Documents all required backend env vars |
| `backend/.env.production.example` | Production-specific env var template |
| `frontend/next.config.ts` | Next.js config: allowed image domains, Google Maps API key passthrough |
| `frontend/tsconfig.json` | TypeScript strict mode, path aliases |
| `frontend/eslint.config.mjs` | ESLint flat config (Next.js recommended rules) |
| `frontend/postcss.config.mjs` | Tailwind CSS PostCSS pipeline |
| `frontend/netlify.toml` | Netlify build settings + redirect rules for SPA routing |
| `docker-compose.yml` | PostgreSQL + backend container orchestration |

---

## Where to Add New Code

| Task | Location |
|---|---|
| New API endpoint | Create `backend/src/routes/<resource>.js`, mount in `server.js` |
| New DB table | Add to `backend/src/db/schema.js`, run `npm run db:push` |
| New dashboard panel | Add component to `frontend/src/components/dashboard/`, import in `dashboard/page.tsx` |
| New driver screen | Add component to `frontend/src/components/driver/`, wire into `DriverTabBar.tsx` |
| New SQL aggregate | Create `backend/src/lib/<name>-sql.js` following existing SQL builder pattern |
| New anomaly rule | Add to `backend/src/lib/anomaly-detector.js` and `activity-thresholds.js` |
