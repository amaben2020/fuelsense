# Coding Conventions

_Last updated: 2026-06-15 | Focus: quality_

## Summary

FuelSense is a full-stack project with a JavaScript/CommonJS Express backend and a TypeScript/React (Next.js) frontend. The backend uses no linter or formatter configuration; the frontend uses ESLint with the `eslint-config-next` preset. Naming conventions diverge between layers: the backend uses camelCase internally but returns snake_case from all API endpoints, while the frontend uses camelCase TypeScript throughout.

---

## File and Folder Naming

**Backend (`backend/src/`):**

- Files: `kebab-case.js` — e.g., `anomaly-detector.js`, `fleet-simulator.js`, `daily-activity-sql.js`
- Directories: `kebab-case` — e.g., `backend/src/routes/`, `backend/src/lib/`, `backend/src/middleware/`, `backend/src/db/`
- Route files map 1:1 to resource names: `vehicles.js`, `drivers.js`, `fuel-events.js`
- Seed scripts are prefixed `seed-`: `seed.js`, `seed-fuel-events.js`, `seed-real-device.js`

**Frontend (`frontend/src/`):**

- Files: `PascalCase.tsx` for components, `kebab-case.ts` for libs — e.g., `DashboardKpis.tsx`, `driver-api.ts`, `fleet-map-theme.ts`
- Directories: `kebab-case` — e.g., `components/dashboard/`, `components/driver/`, `components/maps/`
- Pages: `page.tsx` inside Next.js App Router directory tree — e.g., `app/dashboard/page.tsx`, `app/login/page.tsx`
- Shared utilities live in `frontend/src/lib/`

---

## Naming Conventions

**Backend variables and functions:**

- Variables and function parameters: `camelCase` — `vehicleId`, `customerId`, `fuelLevelLiters`
- Module-level Maps and Sets: `camelCase` with suffix describing type — `idleStreakByImei`, `lastFuelByImei`, `fraudSimulatedFor`
- Constants: `SCREAMING_SNAKE_CASE` — `TICK_INTERVAL_SEC`, `IDLE_TICKS_FOR_ALERT`, `REFUEL_THRESHOLD_LITERS`, `DEFAULT_FUEL_PRICE_NGN_LITER`
- Helper functions: `camelCase` verb-noun — `detectAnomalies`, `hasOpenAlert`, `getOrComputeVehicleBaseline`, `recordSiphonEvent`
- Express routers: named `router`, mounted in `server.js`
- Exported modules: `module.exports = { ... }` named object destructuring

**Frontend variables, functions, and types:**

- Components: `PascalCase` function declarations — `export function DashboardKpis(...)`, `export function FuelAnomalies(...)`
- Local state variables: `camelCase` — `isModalOpen`, `refreshing`, `fuelPurchasePage`
- TypeScript interfaces: `PascalCase` prefixed by domain — `FleetVehicle`, `FuelAnomaly`, `DashboardSummary`, `EventReplayResponse`
- Type aliases: `PascalCase` — `DashboardView`, `VehicleDisplayStatus`, `DailyActivityStatus`
- Utility functions exported from `lib/api.ts`: `camelCase` — `fleetMetrics`, `fuelPercent`, `vehicleDisplayStatus`, `computeDashboardStats`, `formatNgn`
- Constants in frontend: `SCREAMING_SNAKE_CASE` — `PRICE_PER_TRACKER_NGN`, `REFRESH_MS`, `LIVE_REFRESH_MS`

---

## API Response Format Conventions

All backend endpoints return JSON. The consistent pattern across all routes:

**Success (resource fetch):**

```json
{ "field_name": "value", "another_field": 123 }
```

**Error:**

```json
{ "error": "Human-readable error message" }
```

**Key rule:** The backend serializes Drizzle ORM's `camelCase` column aliases to `snake_case` when constructing API responses. This is handled either by:

1. Explicit `snake_case` keys in `.select({ license_plate: vehicles.licensePlate })` calls — `backend/src/routes/vehicles.js`
2. The `serializeForApi` utility in `backend/src/lib/serialize.js` which converts camelCase object keys to snake_case recursively

All frontend TypeScript interfaces in `frontend/src/lib/api.ts` declare fields in `snake_case` to match the wire format:

```typescript
export interface FleetVehicle {
  license_plate: string;
  fuel_level_liters: number | null;
  connection_status: 'online' | 'offline' | 'no_device';
}
```

**Pagination envelope** (used by telemetry, receipts, daily activity endpoints):

```json
{
  "page": 1,
  "limit": 50,
  "total": 200,
  "total_pages": 4,
  "rows": [...]
}
```

**Dashboard summary** uses a flat object with `period_days`, `currency: 'NGN'` and `price_per_liter_ngn` as standard top-level metadata fields.

---

## Import and Export Patterns

**Backend — CommonJS throughout:**

```js
// Destructured require from shared db-helpers barrel
const { db, vehicles, eq, and, sql } = require('../lib/db-helpers');
// Named require
const { authenticateCustomer } = require('../middleware/auth');
// Module export — named object
module.exports = {
  detectAnomalies,
  getOrComputeVehicleBaseline,
  resetEngineState,
};
// Router export
module.exports = router;
```

`backend/src/lib/db-helpers.js` acts as a barrel re-exporting the db client, all schema tables, Drizzle operators, and shared helpers. All routes import from it rather than directly from `db/index.js` or `db/schema.js`.

**Frontend — ES Modules with TypeScript:**

```typescript
// Path alias (@/ maps to src/)
import { api, FleetVehicle, formatNgn } from '@/lib/api';
import { DashboardKpis } from '@/components/dashboard/DashboardKpis';
// Named exports only — no barrel index files
export function fuelPercent(row: FleetVehicle): number | null { ... }
export interface FleetVehicle { ... }
```

No barrel `index.ts` files are used in the frontend. Each file is imported by its full path.

---

## TypeScript Usage (Frontend)

- `tsconfig.json` has `"strict": true` — all strict checks enabled
- Target `ES2017`, module resolution `bundler`
- Interfaces preferred over `type` aliases for object shapes: `interface FleetVehicle`, `interface Alert`
- `type` aliases used for unions: `type DashboardView = 'overview' | 'live' | ...`
- Generics used sparingly — primarily in the `api<T>()` fetch wrapper in `frontend/src/lib/api.ts`
- Props typed inline with object literal in component signatures:
  ```typescript
  export function DashboardKpis({ summary }: { summary: DashboardSummary | null }) { ... }
  ```
- Type guards used via filter callbacks: `.filter((v): v is number => v != null && v > 0)`
- No `any` observed in lib files; frontend avoids explicit `any`

---

## Error Handling Patterns

**Backend routes — try/catch wrapping all async handlers:**

```js
router.get('/', async (req, res) => {
  try {
    const rows = await db.select()...;
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

- All route handlers wrap the entire body in `try/catch`
- Errors always returned as `{ error: string }` — never raw stack traces to the client
- Validation errors: early return with `res.status(400).json({ error: '...' })` before the try block
- Auth errors: `res.status(401)` or `res.status(403)` in middleware (`backend/src/middleware/auth.js`)
- Conflict errors: `res.status(409)` — e.g., "Email already registered"
- Domain errors with status attached to Error object: `throw Object.assign(new Error('...'), { status: 400 })` in `backend/src/lib/db-helpers.js`

**Frontend — try/catch in event handlers:**

```typescript
try {
  const data = await api<AuthResponse>('/auth/login', { ... });
  setToken(data.token);
} catch (err) {
  setError(err instanceof Error ? err.message : 'Login failed');
} finally {
  setLoading(false);
}
```

- The `api()` wrapper in `frontend/src/lib/api.ts` throws on non-2xx responses: `throw new Error(data.error || 'Request failed (${status})')`
- Error state stored in React `useState<string | null>` and rendered inline in UI

---

## Logging Approach

**Backend — `console.*` only, no logging library:**

- `console.log()` for operational events: server startup, device connections, TCP telemetry saves, simulator activity
- `console.error()` for failures: DB errors, telemetry save failures, server startup crash
- `console.warn()` for recoverable issues: fleet simulator startup failure
- Tagged prefixes used in anomaly engine: `[Theft Engine]`, `[REAL DEVICE]`, `[driver-receipt-sync]`, `[sync-vehicle-drivers]`
- Debug console.log present in `backend/src/db/index.js` line 15: `console.log('dotenv 🚀🚀🚀', process.env.DATABASE_URL)` — this is a leaked debug statement that logs the full DATABASE_URL on every startup

**Frontend — no console usage** in source files under `frontend/src/` (confirmed by grep).

---

## Comment Style

- Block comments used for algorithm sections: `// Rule 3: Time validation window (Wait 3–10 minutes...)`
- JSDoc-style multi-line comments (`/** */`) for significant functions:
  ```js
  /**
   * Rule 8: Learn normal behavior per vehicle.
   * Tracks average fuel consumption per km (driving), idle burn per hour (idling),
   * and typical variance of sensor readings.
   */
  async function getOrComputeVehicleBaseline(vehicleId, model, nowTime = new Date()) {
  ```
- Inline comments used freely in the anomaly detector and tcp-server to explain business rules
- No comments in frontend TSX components or lib files — code is self-documenting
- Seed and test scripts use section markers: `// Test Case 1:`, `// t0: base fuel 45L`

---

## Environment Variable Naming Conventions

All environment variables use `SCREAMING_SNAKE_CASE`:

| Variable                 | Location                              | Default                           |
| ------------------------ | ------------------------------------- | --------------------------------- |
| `DATABASE_URL`           | `backend/src/db/index.js`             | required                          |
| `PORT`                   | `backend/src/server.js`               | `5001`                            |
| `TCP_PORT`               | `backend/src/tcp-server.js`           | `5027`                            |
| `JWT_SECRET`             | `backend/src/middleware/auth.js`      | `dev-secret-change-in-production` |
| `JWT_EXPIRES_IN`         | `backend/src/middleware/auth.js`      | `7d`                              |
| `DRIVER_JWT_EXPIRES_IN`  | `backend/src/middleware/auth.js`      | `30d`                             |
| `FUEL_PRICE_NGN_LITER`   | `backend/src/lib/anomaly-detector.js` | `1340`                            |
| `MOCK_INTERVAL_MS`       | `backend/src/lib/anomaly-detector.js` | `4000`                            |
| `ENABLE_FLEET_SIMULATOR` | `backend/src/server.js`               | `false`                           |
| `NODE_ENV`               | `backend/src/server.js`               | —                                 |
| `REAL_DEVICE_IMEI`       | `backend/src/tcp-server.js`           | —                                 |
| `NEXT_PUBLIC_API_URL`    | `frontend/src/lib/api.ts`             | `http://localhost:5001/api`       |
| `GOOGLE_MAPS_API_KEY`    | frontend config                       | —                                 |

Frontend public vars are prefixed `NEXT_PUBLIC_` per Next.js convention. Backend vars have no prefix.

---

## Linting Configuration

**Frontend:** ESLint via `frontend/eslint.config.mjs` using `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript`. Run with `npm run lint` (calls `eslint` with no args).

**Backend:** No ESLint or Prettier configuration. No `scripts.lint` entry in `backend/package.json`. Code formatting is manual/inconsistent.

---

## Component Patterns (Frontend)

- All interactive dashboard pages are Client Components: `'use client'` directive at top of file
- Server Components used only for static layout: `frontend/src/app/layout.tsx`
- Component props typed inline, not with separate interface declarations
- Tailwind CSS for all styling — inline `className` strings with hardcoded hex colors for the dark theme palette (e.g., `text-[#dae2fd]`, `bg-[#171f33]`, `border-[#434656]`)
- No CSS modules or styled-components
- Local sub-components defined in the same file as the parent (e.g., `KpiCard` inside `DashboardKpis.tsx`)
