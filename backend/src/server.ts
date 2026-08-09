import 'dotenv/config';
import './lib/timezone';
import './config/env';

import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { initDatabase } from './db';
import { startTcpServer } from './tcp-server';

import authRoutes from './routes/auth';
import vehicleRoutes from './routes/vehicles';
import deviceRoutes from './routes/devices';
import telemetryRoutes from './routes/telemetry';
import alertRoutes from './routes/alerts';
import orderRoutes from './routes/orders';
import dashboardRoutes from './routes/dashboard';
import driverRoutes from './routes/drivers';
import intelligenceRoutes from './routes/intelligence';
import maintenanceRoutes from './routes/maintenance';
import geofenceRoutes from './routes/geofences';
import driverPortalRoutes from './routes/driver';
import fuelEventsRoutes from './routes/fuel-events';
import deviceEventsRoutes from './routes/device-events';
import placesRoutes from './routes/places';
import featureRoutes from './routes/features';
import fuelPriceRoutes from './routes/fuel-price';
import contactRoutes from './routes/contact';
import { startReceiptSweep } from './lib/receipt-sweep';
import { startRouteSweep } from './lib/route-sweep';
import { startDrivingEventSweep } from './lib/driving-events-sweep';
import { startDailyReportScheduler } from './lib/daily-report-mailer';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (ALLOWED_ORIGINS.length === 0) {
  ALLOWED_ORIGINS.push(
    'http://localhost:3000',
    'https://fuelsense.ng',
    'https://www.fuelsense.ng',
    'http://localhost:3001',
  );
}

// Opening CORS to everything is opt-in per machine, and deliberately NOT tied
// to NODE_ENV: the EC2 box runs with NODE_ENV=development, so keying off that
// would have silently opened the internet-facing API to any origin with
// credentials. A laptop sets CORS_ALLOW_ALL=true in its own .env — which never
// deploys, since rsync excludes it — and every other host stays on the
// allowlist by default.
const ALLOW_ALL_ORIGINS = process.env.CORS_ALLOW_ALL === 'true';

const app = express();
// EC2 sits behind Caddy (:80 → 127.0.0.1:5001); trust its X-Forwarded-For so
// express-rate-limit keys on the real client IP instead of throwing.
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));

app.use(
  ALLOW_ALL_ORIGINS
    ? // Reflect whatever asked, rather than `*`: a wildcard is invalid
      // alongside credentials, so cookie-authenticated calls would fail even
      // though the intent here is to allow everything.
      cors({ origin: (origin, cb) => cb(null, origin ?? true), credentials: true })
    : cors({
        origin: (origin, cb) => {
          if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
          cb(new Error(`CORS: origin ${origin} not allowed`));
        },
        credentials: true,
      }),
);

// Generous global cap — the dashboard legitimately polls many endpoints, so this
// only guards against runaway abuse. Brute-force protection lives on /api/auth.
const globalLimiter = rateLimit({
  windowMs: 60_000,
  max: 900,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
});

app.use(globalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use(express.json({ limit: '10mb' }));

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/telemetry', telemetryRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/intelligence', intelligenceRoutes);
app.use('/api/maintenance', maintenanceRoutes);
app.use('/api/geofences', geofenceRoutes);
app.use('/api/driver', driverPortalRoutes);
app.use('/api/fuel-events', fuelEventsRoutes);
app.use('/api/device-events', deviceEventsRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/places', placesRoutes);
app.use('/api/features', featureRoutes);
app.use('/api/fuel-price', fuelPriceRoutes);
app.use('/api/contact', contactRoutes);

const start = async () => {
  await initDatabase();
  await startTcpServer();

  // Receipts whose evidence arrived after they were submitted, and forecourt
  // stops nobody logged a receipt for.
  startReceiptSweep();

  // Trips against the route they were expected to take. Runs behind the
  // telemetry pipeline so a slow Directions lookup can never delay a frame.
  startRouteSweep();

  // Harsh acceleration, braking and cornering, derived from the speed and
  // heading series the tracker already sends.
  startDrivingEventSweep();

  // Yesterday's driving, per driver, emailed as a PDF each morning.
  startDailyReportScheduler();

  const port = Number(process.env.PORT ?? 5001);
  app.listen(port, () => {
    console.log(`Express server running on port ${port}`);
    console.log(`Health check: http://localhost:${port}/api/health`);

    const simulatorEnabled =
      process.env.ENABLE_FLEET_SIMULATOR === 'true' &&
      process.env.NODE_ENV !== 'production';

    if (simulatorEnabled) {
      setTimeout(async () => {
        try {
          const { runFleetSimulator } = await import('./fleet-simulator');
          runFleetSimulator();
          console.log('Fleet simulator started (dev only)');
        } catch (err) {
          console.warn(
            'Fleet simulator failed to start:',
            (err as Error).message,
          );
        }
      }, 2500);
    } else {
      console.log(
        `Fleet simulator disabled — expecting real Teltonika devices on TCP port ${process.env.TCP_PORT ?? 5027}`,
      );
    }
  });
};

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
