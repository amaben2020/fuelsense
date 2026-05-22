# Docker Compose Guide

This document explains [`docker-compose.yml`](./docker-compose.yml) — what each service does, how they connect, and how to run them.

## Overview

FuelSense Compose defines **two services**:

```
┌─────────────────────────────────────────────────────────┐
│  Docker network (default bridge)                        │
│                                                         │
│   ┌──────────────┐         ┌──────────────────────┐   │
│   │     db       │◄────────│      backend         │   │
│   │  Postgres 16 │  TCP    │  Node.js API + TCP   │   │
│   │  :5432       │  5432   │  :5001 HTTP          │   │
│   └──────┬───────┘         │  :5027 Teltonika     │   │
│          │                  └──────────┬───────────┘   │
└──────────┼─────────────────────────────┼───────────────┘
           │                             │
    host :5434                    host :5001, :5027
```

The **frontend is not in Compose** — run it separately with `cd frontend && npm run dev`.

---

## Services

### `db` — PostgreSQL

| Setting | Value |
|---------|-------|
| Image | `postgres:16-alpine` |
| Container port | `5432` |
| Host port | `5434` |
| Database | `fuelguard` |
| User / password | `user` / `password` |
| Volume | `postgres_data` (persists data across restarts) |

**Healthcheck:** runs `pg_isready` every 5 seconds. The backend service waits until this passes before starting.

**Connection strings:**

| From | URL |
|------|-----|
| Your machine (local Node, psql, seed) | `postgresql://user:password@localhost:5434/fuelguard` |
| Another container (`backend`) | `postgresql://user:password@db:5432/fuelguard` |

The hostname `db` only works **inside** the Docker network. From your Mac/Windows/Linux host, always use `localhost:5434`.

### `backend` — API + TCP server

| Setting | Value |
|---------|-------|
| Build | `./backend` (see `backend/Dockerfile`) |
| HTTP port | `5001:5001` |
| TCP port | `5027:5027` |
| Depends on | `db` (must be healthy) |

Environment injected by Compose:

```yaml
PORT: 5001
TCP_PORT: 5027
DATABASE_URL: postgresql://user:password@db:5432/fuelguard
NODE_ENV: development
```

On start, the backend runs `npm start` → `initDatabase()` creates tables if needed → HTTP + TCP servers listen.

---

## Volumes

```yaml
volumes:
  postgres_data:
```

`postgres_data` stores Postgres files on your machine. Data survives `docker compose down`. To wipe the database completely:

```bash
docker compose down -v   # ⚠️ deletes all DB data
```

---

## Common workflows

### Database only (typical local dev)

Run Postgres in Docker; run backend and frontend on the host with hot reload.

```bash
docker compose up db -d
cd backend && npm run dev
cd frontend && npm run dev
```

### Full stack in Docker

```bash
docker compose up -d
# or with logs in foreground:
docker compose up
```

Rebuild after backend code changes:

```bash
docker compose up backend -d --build
```

### Check status

```bash
docker compose ps
docker compose logs -f
docker compose logs -f backend
curl http://localhost:5001/api/health
```

### Stop

```bash
docker compose down          # stop containers, keep volume
docker compose down -v       # stop + delete postgres volume
```

---

## Startup order (what happens when you `docker compose up`)

1. **Docker** creates the network and volume (if missing).
2. **`db`** starts Postgres and begins healthchecks.
3. **`backend`** waits — `depends_on: condition: service_healthy` blocks until `db` responds to `pg_isready`.
4. **`backend`** container starts → `initDatabase()` → tables created/migrated → TCP on 5027, HTTP on 5001.
5. You can hit `http://localhost:5001/api/health` from the host.

If `backend` exits immediately, check DB logs:

```bash
docker compose logs db
docker compose logs backend
```

---

## Port reference

| Port (host) | Service | Used by |
|-------------|---------|---------|
| `5434` | Postgres | `backend/.env` when running Node locally |
| `5001` | HTTP API | Frontend (`NEXT_PUBLIC_API_URL`) |
| `5027` | Teltonika TCP | FMC150 devices, `npm run mock-device` |
| `3000` | Next.js dev | Frontend (not in Compose) |

Port `5434` on the host avoids conflicting with a Postgres instance already on `5432`. Port `5027` avoids macOS AirPlay on `5000`.

---

## Seeding and mock devices with Docker

**Seed** runs on the host and must target the host DB port:

```bash
docker compose up db -d
cd backend
npm run seed
```

If the backend runs **inside** Docker, seed the same database (still via `localhost:5434` from your machine — it's the same Postgres volume).

**Mock device** always connects from the host to `localhost:5027`, whether the backend runs in Docker or locally.

---

## What Compose does not include

| Component | How to run |
|-----------|------------|
| Frontend | `cd frontend && npm run dev` |
| Production Neon DB | Set `DATABASE_URL` in deployment env (see `backend/.env.production.example`) |
| JWT secret (production) | Add `JWT_SECRET` to compose env or deployment platform |
| SSL / reverse proxy | Configure on Render, Railway, etc. |

For production, you will typically deploy backend and frontend separately and point `DATABASE_URL` at a managed Postgres (e.g. Neon) instead of the local `db` service.

---

## Quick reference

```bash
# Start DB only
docker compose up db -d

# Start everything defined in compose
docker compose up -d

# Rebuild backend image
docker compose build backend
docker compose up backend -d

# Follow logs
docker compose logs -f backend db

# Reset database
docker compose down -v && docker compose up db -d
```

More backend details: [backend/README.md](./backend/README.md)
