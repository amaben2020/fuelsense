# FuelSense Backend

Express HTTP API + Teltonika TCP server for FMC150 fuel telemetry. Handles customer auth (JWT), multi-tenant fleet management, and real-time device ingestion.

## What runs on startup

When you run `npm start` or `npm run dev`, `src/server.js` does this in order:

```
1. Load .env (dotenv)
2. initDatabase()     → connect to Postgres, create/migrate tables if missing
3. startTcpServer()   → listen for Teltonika devices on TCP_PORT (default 5027)
4. app.listen()       → HTTP API on PORT (default 5001)
```

Both servers share the same Node process and the same Drizzle/Postgres connection pool.

| Process | Port | Purpose |
|---------|------|---------|
| HTTP API | `5001` | REST API for frontend (`/api/*`) |
| TCP server | `5027` | Teltonika Codec 8e device connections |
| PostgreSQL | `5434` (host) / `5432` (container) | Data store |

Health check: `GET http://localhost:5001/api/health`

---

## Two ways to run the backend

### Option A — Local Node + Docker Postgres (recommended for dev)

Best for day-to-day development: hot reload with nodemon, easy debugging, mock device from your machine.

```bash
# From repo root — start only the database
docker compose up db -d

cd backend
cp .env.example .env
npm install
npm run seed          # optional: demo account + IMEI
npm run dev           # nodemon, auto-restarts on file changes
```

Your `backend/.env` should use the **host** database URL:

```
DATABASE_URL=postgresql://user:password@localhost:5434/fuelguard
```

Why `5434`? Docker maps container port `5432` → host port `5434` so it does not clash with a local Postgres install.

### Option B — Backend + Postgres in Docker

Runs the backend inside a container built from `backend/Dockerfile`. Good for testing the production-like image without installing Node deps on the host.

```bash
# From repo root
docker compose up backend -d
# or rebuild after code changes:
docker compose up backend -d --build
```

Inside Docker, the backend uses a **different** `DATABASE_URL`:

```
postgresql://user:password@db:5432/fuelguard
```

`db` is the Docker Compose service name — containers talk to each other on the internal network, not via `localhost`.

**Note:** The Docker image runs `npm start` (no nodemon). Code changes require a rebuild. JWT auth works with a built-in dev fallback if `JWT_SECRET` is not set in compose.

See the root **[DOCKER.md](../DOCKER.md)** for a full breakdown of `docker-compose.yml`.

---

## Understanding the Docker build

`backend/Dockerfile`:

```
node:20-alpine
  → copy package.json, npm install --omit=dev
  → copy src/
  → expose 5001, 5027
  → CMD npm start
```

| Step | What it means |
|------|----------------|
| `node:20-alpine` | Small Linux image with Node 20 |
| `--omit=dev` | Production install only (no nodemon, drizzle-kit, etc.) |
| `COPY src` | Only application code — no `.env` (env comes from compose or runtime) |
| `EXPOSE` | Documents which ports the container uses |
| `npm start` | Runs `node src/server.js` |

When Compose starts `backend`, it:

1. Waits until `db` passes its healthcheck (`pg_isready`)
2. Injects environment variables (`DATABASE_URL`, `PORT`, etc.)
3. Starts the container → `initDatabase()` → TCP + HTTP servers

---

## Environment variables

Copy `backend/.env.example` to `backend/.env` for local dev.

| Variable | Local default | Docker (compose) |
|----------|---------------|------------------|
| `PORT` | `5001` | `5001` |
| `TCP_PORT` | `5027` | `5027` |
| `DATABASE_URL` | `@localhost:5434` | `@db:5432` |
| `JWT_SECRET` | set in `.env` | optional (dev fallback exists) |
| `JWT_EXPIRES_IN` | `7d` | — |

Production example: `backend/.env.production.example` (Neon Postgres).

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start with nodemon (local dev) |
| `npm start` | Start once (Docker / production) |
| `npm run seed` | Create demo customer, vehicle, and IMEI |
| `npm run mock-device` | Simulate a single FMC150 (one IMEI) |
| `npm run simulate-fleet` | Simulate 5 drivers — movement, fuel burn, theft alert |
| `npm run db:push` | Push Drizzle schema to Postgres (Drizzle Kit) |

### Simulate the full fleet (recommended)

With the backend running:

```bash
cd backend
npm run seed            # ensures 5 demo vehicles + IMEIs exist
npm run simulate-fleet  # 5 virtual drivers → TCP → Postgres → dashboard
```

Each virtual vehicle opens its own Teltonika TCP connection, sends Codec 8e packets every 4 seconds, and behaves differently:

| Plate | Behavior |
|-------|----------|
| ABC-123 | Active driver, Lagos island route |
| LAG-456-CD | Mixed driving + idle |
| LAG-789-EF | Frequent idle stops |
| ABJ-101-GH | Stops sending after ~3 min (goes offline) |
| RIV-202-IJ | Parks ~40s, then fuel theft (−22 L) → alert with GPS |
| LAG-456-CD | Parks ~72s, then fuel theft (−20 L) → alert with GPS |

When a real FMC150 connects with a registered IMEI, it uses the **same TCP pipeline** — no simulator changes needed.

### Simulate a single device

With the backend running (local or Docker):

```bash
cd backend
npm run mock-device
```

The mock device connects to `localhost:5027` by default. Telemetry shows on the dashboard within seconds.

Demo login (after seed):

| Field | Value |
|-------|-------|
| Email | `demo@fuelsense.local` |
| Password | `demo1234` |
| IMEI | `356307042441013` |

---

## Project layout

```
backend/
├── src/
│   ├── server.js          # HTTP entry point
│   ├── tcp-server.js      # Teltonika TCP + IMEI lookup
│   ├── mock-device.js     # Local device simulator
│   ├── seed.js            # Demo data
│   ├── db/
│   │   ├── schema.js      # Drizzle table definitions
│   │   ├── index.js       # DB client + initDatabase()
│   │   └── queries.js     # Raw SQL helpers (fleet query)
│   ├── routes/            # Express routers
│   ├── middleware/        # JWT auth
│   └── lib/               # Shared helpers
├── Dockerfile
├── drizzle.config.js
└── package.json
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `ECONNREFUSED` on DB | Postgres not running | `docker compose up db -d` |
| Wrong port for DB | Using `5432` on host | Use `5434` in local `.env` |
| Backend container exits | DB not healthy yet | `docker compose logs db` — wait for healthcheck |
| TCP connection refused | Backend not listening | Check `5027` is exposed; macOS AirPlay uses 5000, not 5027 |
| Unknown IMEI rejected | Device not registered | Run `npm run seed` or add IMEI via dashboard |
| Auth fails in Docker | Different DB than seeded | Run seed against the DB the container uses, or seed locally first |

Useful commands:

```bash
docker compose ps
docker compose logs -f backend
docker compose logs -f db
curl http://localhost:5001/api/health
```
