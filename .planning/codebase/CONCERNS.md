# CONCERNS
_Last updated: 2026-06-15 | Focus: concerns_

## Summary
FuelSense has significant security, operational, and scalability concerns that need addressing before production use. The most critical issues are hardcoded credentials, DATABASE_URL logged to stdout, DROP TABLE on every startup, and zero automated tests. The codebase shows signs of rapid prototyping without hardening.

---

## Security

### DATABASE_URL logged to stdout — HIGH
Full database connection string (including credentials) is logged at startup via `console.log`. Any log aggregation system will capture and store the secret.
- **File:** `backend/src/db/index.js`

### Open CORS — HIGH
CORS is configured to allow all origins (`*`). In production this exposes the API to cross-origin requests from any domain.
- **File:** `backend/src/server.js`

### No rate limiting — HIGH
The HTTP API and TCP server accept unlimited requests with no throttling. Trivial to brute-force auth or flood the telemetry endpoint.
- **Files:** `backend/src/server.js`, `backend/src/tcp-server.js`

### Weak JWT fallback — HIGH
A hardcoded fallback JWT secret is used when `JWT_SECRET` env var is not set, meaning the app will silently run with a known-weak secret in misconfigured environments.
- **File:** `backend/src/server.js`

### Hardcoded demo credentials in production logic — HIGH
Demo license plates and vehicle IDs are hardcoded directly in production source files rather than seeded via migration or test fixtures.
- **Files:** `backend/src/seed.js`, `backend/src/tcp-server.js`

### Missing Helmet headers — MEDIUM
No HTTP security headers (X-Frame-Options, CSP, HSTS, etc.) are applied. Helmet or equivalent is absent.
- **File:** `backend/src/server.js`

---

## Performance

### Unbounded telemetry scans per packet — HIGH
Anomaly detection performs a full in-memory scan on every incoming telemetry packet with no indexing or caching, which degrades linearly as vehicle/event history grows.
- **File:** `backend/src/lib/anomaly-detector.js`

### Sequential bulk inserts — MEDIUM
Seed and simulation scripts insert records sequentially in loops rather than using bulk insert (`INSERT ... VALUES (...),(...),...`), causing unnecessary round-trips.
- **Files:** `backend/src/seed.js`, `backend/src/fleet-simulator.js`

### Per-packet N+1 vehicle lookups — MEDIUM
Each incoming TCP telemetry packet triggers an individual `SELECT` for vehicle metadata rather than batching or caching lookups.
- **File:** `backend/src/tcp-server.js`

---

## Code Quality

### DROP TABLE in startup path — HIGH
Schema initialization drops and recreates tables on every server start, destroying all data. This is not guarded by any environment check.
- **File:** `backend/src/db/index.js`

### Raw DDL schema management (no migrations) — HIGH
All schema is managed as raw SQL strings in application code with no migration framework (Flyway, Knex migrations, etc.). Schema changes are destructive and cannot be rolled back.
- **File:** `backend/src/db/index.js`

### Module-level in-process state in anomaly detector — MEDIUM
The anomaly detector stores state in module-level variables, making it incompatible with stateless/multi-process deployments and untestable in isolation.
- **File:** `backend/src/lib/anomaly-detector.js`

### Hardcoded demo license plate in production logic — MEDIUM
A specific license plate ("ABC123" or similar) is referenced directly in siphon detection logic, conflating demo data with production rules.
- **File:** `backend/src/lib/siphon-recorder.js`

### TODOs / unfinished logic — LOW
Several files contain TODO comments or stub implementations that indicate incomplete features shipped to the repo.

---

## Dependencies

### No backend lockfile — HIGH
`backend/package.json` exists but no `package-lock.json` or `yarn.lock` is committed. This means `npm install` in CI/production may resolve different (potentially breaking or vulnerable) versions.

### Express 5 pre-release — MEDIUM
The backend uses Express 5 which was pre-release at time of writing. API surface is not fully stable and some middleware may behave differently than Express 4 docs describe.

### Unvetted low-visibility TCP SDK — MEDIUM
A third-party TCP/serial communication library is used for OBD-II device communication. The package has low download counts and limited community vetting for production use.

---

## Operations

### No env validation at startup — HIGH
Environment variables are consumed ad-hoc throughout the codebase with no validation schema (e.g., Zod, `envalid`). Missing or malformed env vars produce silent failures or misleading errors.

### No structured logging — HIGH
All logging uses bare `console.log` / `console.error`. No log levels, no JSON output, no correlation IDs — makes production debugging and log aggregation difficult.

### Health check doesn't verify DB — MEDIUM
The `/health` endpoint returns 200 without verifying the database connection is alive, so load balancers and orchestrators will route traffic to a broken instance.
- **File:** `backend/src/server.js`

### No CI/CD pipeline — MEDIUM
No `.github/workflows/`, `.gitlab-ci.yml`, or equivalent CI configuration exists. Deployments are manual and there are no automated quality gates.

### TCP server on 0.0.0.0 with no auth — MEDIUM
The TCP server binds to all interfaces with no authentication or IP allowlist. Any device on the network can send telemetry packets.
- **File:** `backend/src/tcp-server.js`

---

## Scalability

### Single-process in-memory anomaly state — HIGH
Anomaly detection state lives in module-level memory. Horizontal scaling (multiple Node processes or containers) will result in split-brain detection with inconsistent alerts.
- **File:** `backend/src/lib/anomaly-detector.js`

### No DB connection pool limits — MEDIUM
The database pool is created without explicit `min`/`max` connection limits, risking connection exhaustion under load.
- **File:** `backend/src/db/index.js`

---

## Missing Infrastructure

### Zero automated tests — HIGH
No test files exist in the backend (other than `test-noise-proof-rules.js` which is a manual script, not a test suite). There is no test runner configured in `package.json`.

### No error monitoring — HIGH
No Sentry, Datadog, or equivalent error tracking is integrated. Unhandled exceptions and rejected promises in production are invisible.

### No DB backup strategy — MEDIUM
No documented or scripted database backup/restore process exists. A DROP TABLE accident or hardware failure would be unrecoverable.
