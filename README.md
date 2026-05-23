# FuelSense

Multi-tenant fuel monitoring platform for Teltonika FMC150 devices. Customers register fleets, link devices by IMEI, and view live telemetry with theft alerts — all isolated per tenant.

## Architecture

```
Customer (browser)          FMC150 device
       │                           │
       │  email/password           │  IMEI + telemetry
       ▼                           ▼
  Next.js frontend            TCP server (Codec 8e)
       │                           │
       └──────── Express API ──────┘
                     │
                 PostgreSQL
         customers · vehicles · devices · telemetry
```

**Two separate auth flows:**

| Flow | Credential | Purpose |
|------|------------|---------|
| Customer login | Email + password → JWT | Dashboard access |
| Device connection | IMEI (automatic) | Telemetry ingestion |

The IMEI is the master key. When a device connects, the TCP server looks up `devices.imei → customer_id` and tags all telemetry with that tenant.

## Project structure

```
FuelSense/
├── backend/
│   ├── src/
│   │   ├── server.js           # Express HTTP API
│   │   ├── tcp-server.js       # Teltonika TCP + IMEI lookup
│   │   ├── mock-device.js      # Simulates FMC150 for local dev
│   │   ├── database.js         # Schema + migrations
│   │   ├── seed.js             # Demo customer + device
│   │   ├── middleware/auth.js  # JWT authentication
│   │   └── routes/             # auth, vehicles, devices, telemetry, alerts
│   └── package.json
├── frontend/
│   └── src/app/                # login, register, dashboard
└── docker-compose.yml
```

Docker setup is documented in **[DOCKER.md](./DOCKER.md)**. Backend startup and Docker details are in **[backend/README.md](./backend/README.md)**.

## Quick start

### 1. Start PostgreSQL

```bash
docker compose up db -d
```

Default connection: `postgresql://user:password@localhost:5434/fuelguard`

### 2. Backend

```bash
cd backend
cp .env.example .env
npm install
npm run seed      # creates demo account + registers mock IMEI
npm run dev
```

### 3. Frontend

```bash
cd frontend
cp .env.local.example .env.local
npm install
npm run dev
```

Open **http://localhost:3000**

### 4. Demo login

| Field | Value |
|-------|-------|
| Email | `demo@fuelsense.local` |
| Password | `demo1234` |

### 5. Simulate a device

```bash
cd backend
npm run mock-device
```

Telemetry appears on the dashboard within seconds.

## Adding vehicles — two entry points

| Entry point | Route | When to use |
|-------------|-------|-------------|
| **Onboarding wizard** | `/onboarding` | First signup — add 1–20 vehicles at once |
| **Add device modal** | Dashboard → **+ Add device** | Adding vehicles over time |

New accounts are sent to the onboarding wizard after registration. Existing customers use the dashboard modal to add one vehicle + IMEI at a time.

## Customer device connection flow

```
Buy trackers → Receive boxes with IMEI stickers → Log into FuelSense
       ↓
Add vehicle + IMEI in one form → devices.imei mapped to customer_id + vehicle_id
       ↓
Device powers on → TCP server receives IMEI → Looks up mapping → Saves telemetry
       ↓
Fleet dashboard shows live fuel, odometer, and online status per vehicle
```

| Step | Customer action | System response |
|------|-----------------|-----------------|
| 1 | Buys 5 trackers | Order in `device_orders`, payment in `payments` |
| 2 | Receives devices | Order marked shipped with IMEI array |
| 3 | Creates account | Row in `customers` |
| 4 | Adds vehicle + IMEI | Rows in `vehicles` + `devices` (linked) |
| 5 | Device connects | `devices.last_seen_at` updated, unknown IMEIs rejected |
| 6 | Device sends data | `telemetry` saved with `customer_id`, `vehicle_id` |
| 7 | Views dashboard | Fleet table filtered by `customer_id` |

## Database schema (ERD)

```
customers ──1:N── vehicles ──1:1── devices ──1:N── telemetry
    │                │              │              │
    │                └──────────────┴──────────────┴── alerts
    │
    ├──1:N── subscriptions ──1:N── payments
    └──1:N── device_orders
```

Core tables:

- **customers** — fleet owners (email/password login)
- **vehicles** — license plate, make, model, tank capacity
- **devices** — IMEI (PK) → vehicle_id + customer_id
- **telemetry** — fuel, GPS, odometer (denormalized customer_id)
- **alerts** — theft and other events (with `is_resolved`)
- **device_orders** — tracker purchases
- **payments** — Paystack-ready payment records
- **subscriptions** — billing plans (Phase 2)

## API reference

### Public

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/auth/register` | Create customer account |
| POST | `/api/auth/login` | Login, returns JWT |

### Protected (Bearer token required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/me` | Current customer profile |
| GET | `/api/vehicles/fleet` | Fleet overview with latest telemetry + online status |
| GET/POST | `/api/vehicles` | List / add vehicles |
| POST | `/api/vehicles/with-device` | Add vehicle + link IMEI in one step |
| POST | `/api/vehicles/bulk` | Onboarding — add multiple vehicles + IMEIs |
| PATCH | `/api/auth/onboarding` | Mark onboarding complete (skip wizard) |
| GET/POST | `/api/devices` | List / register device by IMEI |
| GET/POST | `/api/orders` | List / create tracker orders |
| GET | `/api/telemetry/latest` | Latest reading for your fleet |
| GET | `/api/telemetry/history` | Telemetry history |
| GET | `/api/alerts` | Unresolved fuel theft alerts |

All protected routes filter by `customer_id` from the JWT — tenants never see each other's data.

## Environment variables

### Backend (`backend/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5001` | HTTP API port |
| `TCP_PORT` | `5027` | Teltonika TCP port (5027 avoids macOS AirPlay on 5000) |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `JWT_SECRET` | — | **Required in production** |
| `JWT_EXPIRES_IN` | `7d` | Token lifetime |

### Frontend (`frontend/.env.local`)

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_API_URL` | `http://localhost:5001/api` | Backend API base URL |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | — | Google Maps JavaScript + Geocoding |
| `CACHE_GEOCODE` | — | Set `true` to cache reverse-geocode results in replay (reduces Geocoding API calls) |

## Multi-tenant device flow

1. Customer registers and logs in
2. Customer orders trackers (optional) or receives pre-provisioned devices
3. Customer adds vehicle **and IMEI together** via the dashboard form
4. Device connects to TCP server and sends its IMEI
5. Server looks up IMEI in `devices` table — unknown IMEIs are rejected
6. Telemetry saved with `customer_id`, `vehicle_id`, and `imei`
7. Fleet dashboard shows all vehicles with fuel, odometer, and online/offline status

## Deploying to Render

1. **PostgreSQL** — create database, copy internal URL
2. **Backend Web Service** — root: `backend`, start: `npm start`, set `DATABASE_URL`, `JWT_SECRET`, `TCP_PORT`
3. **Frontend** — root: `frontend`, set `NEXT_PUBLIC_API_URL` to your backend URL

Point FMC150 devices at your backend host on the TCP port.

## Scripts

| Command | Location | Description |
|---------|----------|-------------|
| `npm run dev` | backend / frontend | Development server |
| `npm run seed` | backend | Create demo customer + device |
| `npm run mock-device` | backend | Simulate FMC150 telemetry |
