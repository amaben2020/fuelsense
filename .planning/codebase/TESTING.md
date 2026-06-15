# Testing Patterns
_Last updated: 2026-06-15 | Focus: quality_

## Summary
FuelSense has no formal test framework installed. There is a single manual verification script (`backend/src/test-noise-proof-rules.js`) that tests the anomaly detection engine against a live PostgreSQL database. No unit tests, integration tests with mocking, or end-to-end tests exist in the project. There is no CI configuration for automated testing.

---

## Test Framework

**Runner:** None. No Jest, Vitest, Mocha, or any other test runner is installed.

- `backend/package.json`: No `test` script defined, no test framework in `dependencies` or `devDependencies`
- `frontend/package.json`: No `test` script defined, no Jest or Vitest installed
- No `jest.config.*`, `vitest.config.*`, or `.mocharc.*` files exist anywhere in the project

---

## What Exists: Manual Database Integration Script

**File:** `backend/src/test-noise-proof-rules.js`

This is the only test-like artifact in the codebase. It is not a unit test — it requires a live connected database with seed data, exercises 8 scenarios against the real `detectAnomalies()` function, and prints pass/fail to stdout.

**Run command:**
```bash
cd backend && node src/test-noise-proof-rules.js
```

**Prerequisites before running:**
1. `DATABASE_URL` must be set in `.env`
2. Seed data must exist: `npm run seed` (inserts vehicle `LAG-456-CD` that the test targets)
3. Test cleans up its own data via `cleanTestData()` at the end

**Test cases covered:**
| # | Scenario | Expected outcome |
|---|----------|-----------------|
| 1 | Drop below 5L threshold | No alert (noise) |
| 2 | Drop with fuel rebound (+8L) | No alert (sensor slosh) |
| 3 | Drop while driving at speed | No alert (physical impossibility) |
| 4 | Repeated rapid toggling | No alert (oscillation noise) |
| 5 | 15L drop, parked, ignition OFF | Critical alert + active siphon event |
| 6 | 15L drop, parked, ignition ON | Review-only siphon event, no alert |
| 7 | Multiple drops within 30 min | Events merged into cluster (20L total) |
| 8 | New drop after 2-hour cooldown | Alert suppressed by cooldown |

**Pass/fail output format:**
```
✅ PASS: Drop below threshold ignored.
❌ FAIL: Small drop triggered alarm/event.
```

---

## Test Directory Structure

```
backend/
└── src/
    └── test-noise-proof-rules.js    # Only test file — ad-hoc integration script
```

No `__tests__/`, `test/`, or `spec/` directories exist in either `backend/` or `frontend/`.

---

## Types of Tests Present

| Type | Present | Notes |
|------|---------|-------|
| Unit tests | No | None |
| Integration tests (mocked) | No | None |
| Integration tests (live DB) | Partial | `test-noise-proof-rules.js` only |
| End-to-end (browser) | No | No Playwright, Cypress, etc. |
| API contract tests | No | None |
| Component tests | No | No React Testing Library |

---

## Mocking Patterns

No mocking infrastructure exists. The single test script uses real database calls via Drizzle ORM. There is no use of `jest.mock()`, `vi.fn()`, `sinon`, `nock`, or any HTTP interception library.

---

## CI Test Configuration

No CI configuration for tests exists. The repository contains no `.github/workflows/`, no `netlify.toml` test commands, and no `Dockerfile` test stage.

---

## How to Run Existing Verification

```bash
# 1. Set up environment
cp backend/.env.example backend/.env
# (edit backend/.env to set DATABASE_URL)

# 2. Seed the database with required test data
cd backend && npm run seed

# 3. Run the anomaly detector verification
node src/test-noise-proof-rules.js
```

Expected terminal output ends with:
```
--- VERIFICATION TESTS COMPLETED ---
```

The script calls `process.exit(0)` on completion or `process.exit(1)` on crash.

---

## Test Coverage Gaps

**Critical — nothing tested:**

**API Routes:**
- All 10 Express route modules (`auth.js`, `vehicles.js`, `devices.js`, `telemetry.js`, `alerts.js`, `dashboard.js`, `drivers.js`, `driver.js`, `fuel-events.js`, `orders.js`) have zero test coverage
- Auth middleware (`backend/src/middleware/auth.js`) — JWT validation, role enforcement — untested
- IMEI validation in `backend/src/lib/db-helpers.js` — untested

**Business Logic:**
- `backend/src/lib/fuel-metrics.js` — efficiency calculations, consumption logic — untested
- `backend/src/lib/serialize.js` — camelCase-to-snake_case serializer — untested
- `backend/src/lib/receipt-reconciliation.js` — receipt vs OBD matching — untested
- `backend/src/lib/event-replay.js` — event replay intelligence — untested
- `frontend/src/lib/api.ts` — `fleetMetrics()`, `fuelPercent()`, `vehicleDisplayStatus()`, `computeDashboardStats()` — untested

**TCP Server:**
- `backend/src/tcp-server.js` — Teltonika device packet parsing, CODEC 8E decoding — untested
- `backend/src/codec8e-encoder.js` — binary encoding — untested

**Frontend Components:**
- All 40+ React components have zero test coverage
- No snapshot tests, no interaction tests

**Database:**
- `backend/src/db/index.js` `initDatabase()` — schema migration function — untested
- `ensureColumn()` migration helper — untested

**Priority assessment:**
- **High:** `anomaly-detector.js` (has partial coverage via the manual script), `auth.js` middleware (security-critical), `fuel-metrics.js` (core calculation logic)
- **Medium:** `serialize.js`, route-level input validation, `receipt-reconciliation.js`
- **Low:** Seed scripts, simulator scripts, frontend components

---

## Recommended Test Setup (Not Yet Implemented)

To establish a baseline test suite, the minimum additions would be:

**Backend:**
```bash
npm install --save-dev jest supertest
```
- Jest for unit tests of `fuel-metrics.js`, `serialize.js`, `anomaly-detector.js` (with mocked DB)
- Supertest for route integration tests against an in-memory or test-database Express app

**Frontend:**
```bash
npm install --save-dev @testing-library/react @testing-library/user-event vitest @vitejs/plugin-react jsdom
```
- Vitest + React Testing Library for component and lib utility tests
- `frontend/src/lib/api.ts` utility functions are pure and immediately unit-testable with no mocks required

**Test script additions to `package.json`:**
```json
{
  "scripts": {
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage"
  }
}
```
