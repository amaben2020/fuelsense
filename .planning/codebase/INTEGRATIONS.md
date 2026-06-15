# External Integrations
_Last updated: 2026-06-15 | Focus: tech_

## Summary

FuelSense integrates with three external services: Teltonika GPS hardware over a raw TCP socket, Google Maps Platform for fleet map display and reverse geocoding, and OCR.space for receipt image parsing. A Paystack payment integration is referenced in the data model but not yet implemented (placeholder only). All configuration is via environment variables.

---

## Hardware Integration — Teltonika GPS Devices

**What it is:** Direct TCP socket connection to Teltonika FMC150 GPS trackers installed in fleet vehicles. This is the core real-time data pipeline.

**SDK:** `@groupe-savoy/teltonika-sdk ^0.3.1`
- Used in: `backend/src/tcp-server.js`
- Classes used: `TeltonikaTCPServer`, `TeltonikaDataCodec`, `TeltonikaGPRSCodec`
- Codec: `Codec8e` (data), `Codec12` (GPRS)

**Connection:**
- TCP port: `5027` (configurable via `TCP_PORT` env var)
- Binds to `0.0.0.0` — accepts connections from any interface
- Production endpoint: `ec2-13-61-2-216.eu-north-1.compute.amazonaws.com:5027`

**Authentication / device registry:**
- On handshake, device IMEI is looked up in the `devices` table
- Unknown IMEIs are rejected (`device.close()`)
- Known device: FMC150 with IMEI `862129084847783` (configured via `REAL_DEVICE_IMEI` env var)

**Data extracted from device packets:**
- AVL ID 390 / 270 / 30 — CAN bus fuel level (raw, divided by 100 for liters)
- AVL ID 89 — OBD fuel level percentage (converted using `REAL_DEVICE_TANK_LITERS`)
- AVL ID 112 — odometer in meters (converted to km)
- AVL ID 239 — ignition state (0/1)
- GPS fields: `latitude`, `longitude`, `speed`

**Flow:**
1. Device connects → `init` event → IMEI lookup → device accepted or rejected
2. Device sends packets → `data` event → `saveTelemetry()` writes to `telemetry` table
3. After each telemetry row, `detectAnomalies()` runs in `backend/src/lib/anomaly-detector.js`

**Dev simulator:**
- `backend/src/lib/simulator.js` and `backend/src/fleet-simulator.js` simulate device behavior locally
- Enabled via `ENABLE_FLEET_SIMULATOR=true` (blocked in `NODE_ENV=production`)

---

## Google Maps Platform

**What it is:** Interactive map rendering for fleet position display and live monitoring.

**SDK / client:** `@vis.gl/react-google-maps ^1.8.3` (React wrapper for Google Maps JS API)

**Used in:**
- `frontend/src/components/FleetMap.tsx` — fleet vehicle position markers
- `frontend/src/components/dashboard/LiveMonitoringMap.tsx` — live monitoring panel
- `frontend/src/components/maps/SharedMapLayers.tsx` — shared map marker components

**Config:**
- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` — Maps JS API key (required for map to load)
- `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` — optional Cloud-based Map ID for Cloud Styling (dark theme)
  - When `Map ID` is present: uses `colorScheme: 'DARK'` and Cloud vector tiles
  - When absent: falls back to inline `styles` array defined in `frontend/src/lib/fleet-map-theme.ts`
- Center defaults to Lagos, Nigeria: `{ lat: 6.5244, lng: 3.3792 }`

**Features used:**
- `APIProvider`, `Map`, `InfoWindow` components from `@vis.gl/react-google-maps`
- Custom SVG car markers with heading rotation (`frontend/src/lib/fleet-map-theme.ts`)
- Custom dark map style (Uber/Bolt-style muted basemap)

**Geocoding:**
- In-memory geocode cache: `frontend/src/lib/geocode-cache.ts`
- Enabled via `CACHE_GEOCODE=true` frontend env var
- Geocoding API calls handled client-side (implementation in map components)

---

## OCR.space — Receipt OCR

**What it is:** Cloud OCR service for parsing driver-uploaded fuel receipt photos into structured data (liters, price, merchant, date).

**API endpoint:** `https://api.ocr.space/parse/image`

**Authentication:**
- API key: `OCR_SPACE_API_KEY` env var (backend)
- Falls back to public demo key `helloworld` if env var is blank (rate-limited, dev only)
- Free tier: 25,000 requests/month (registration at `https://ocr.space/ocrapi`)

**Implementation:**
- Backend: `backend/src/lib/receipt-ocr.js` — sends base64-encoded image to OCR.space
- Backend: `backend/src/lib/receipt-parser.js` — parses OCR text into structured fields
- Frontend: `frontend/src/lib/receipt-ocr.ts` — thin wrapper that calls the backend OCR endpoint via `parseDriverReceipt()`

**Request parameters:**
- `OCREngine: '2'` (more accurate engine)
- `language: 'eng'`
- `detectOrientation: 'true'`
- `scale: 'true'`
- Image size limit: 1MB (enforced before API call)

**Flow:**
1. Driver captures receipt photo in `frontend/src/components/driver/DriverFuelScreen.tsx`
2. Image sent as base64 data URL to backend
3. Backend calls OCR.space → gets raw text
4. Raw text parsed by `receipt-parser.js` → structured fields extracted
5. Structured data returned to driver app for confirmation before saving

---

## Paystack — Payment Processing (Placeholder)

**Status:** Referenced in data model and order creation flow, but **not yet integrated**. Payment method field is hardcoded to `'paystack'` in `backend/src/routes/orders.js`. No Paystack SDK installed. No API calls made.

**What exists:**
- `payments` table in DB schema (`backend/src/db/schema.js`) stores `reference`, `status`, `payment_method`
- Order creation generates a local reference (`fs_<timestamp>_<customerId>`)
- Response includes a `message` field: `"Paystack integration is Phase 2 — mark as paid manually for now"`
- No webhook endpoint exists

**Intended scope (Phase 2):** Paystack payment initiation and webhook confirmation for device orders (`backend/src/routes/orders.js`)

---

## Neon PostgreSQL (Production Database)

**What it is:** Serverless PostgreSQL provider used in the production environment on AWS EC2.

**Connection:**
- `DATABASE_URL` format: `postgresql://USER:PASSWORD@HOST/neondb?sslmode=require`
- SSL required in production (`backend/src/db/index.js` has `ssl: { rejectUnauthorized: false }` applied unconditionally)
- Commented-out Neon connection string visible in `backend/src/db/index.js` (line 8)

**Local dev:** Docker container (`postgres:16-alpine`) on port `5434` via `docker-compose.yml`

---

## Next.js API Rewrite (Frontend Proxy)

**What it is:** Next.js rewrites in `frontend/next.config.ts` proxy `/api/*` requests to the backend URL. This avoids CORS issues in some deployment configurations.

**Config:**
```ts
// frontend/next.config.ts
rewrites() {
  return [{ source: '/api/:path*', destination: `${NEXT_PUBLIC_API_URL}/api/:path*` }]
}
```

Note: The frontend `api()` client in `frontend/src/lib/api.ts` calls `NEXT_PUBLIC_API_URL` directly, so the rewrite is only active for requests routed through `/api/` path on the Next.js server itself.

---

## Environment Variable Summary

| Variable | Service | Location |
|---|---|---|
| `DATABASE_URL` | PostgreSQL / Neon | Backend |
| `JWT_SECRET` | Auth (JWT) | Backend |
| `OCR_SPACE_API_KEY` | OCR.space | Backend |
| `REAL_DEVICE_IMEI` | Teltonika FMC150 | Backend |
| `REAL_DEVICE_CCID` | Teltonika SIM | Backend |
| `REAL_DEVICE_TANK_LITERS` | Teltonika fuel calc | Backend |
| `TCP_PORT` | Teltonika TCP server | Backend |
| `FUEL_PRICE_NGN_LITER` | Anomaly loss calc | Backend |
| `NEXT_PUBLIC_API_URL` | Backend API base URL | Frontend |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Google Maps | Frontend |
| `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` | Google Maps (Cloud Styling) | Frontend |
| `CACHE_GEOCODE` | In-memory geocode cache | Frontend |

---

## Webhooks & Real-Time Connections

**Incoming webhooks:** None configured (Paystack webhook endpoint planned for Phase 2)

**Outgoing webhooks:** None

**Real-time connections:**
- Teltonika devices maintain persistent TCP connections to port `5027`
- No WebSocket or SSE connections to the frontend — dashboard polls the REST API

---

*Integration audit: 2026-06-15*
