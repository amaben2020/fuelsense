import 'dotenv/config';
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
import driverPortalRoutes from './routes/driver';
import fuelEventsRoutes from './routes/fuel-events';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (ALLOWED_ORIGINS.length === 0) {
  ALLOWED_ORIGINS.push(
    'http://localhost:3000',
    'https://fuelsense.ng',
    'https://www.fuelsense.ng'
  );
}

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  })
);

const globalLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

app.use(globalLimiter);
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
app.use('/api/driver', driverPortalRoutes);
app.use('/api/fuel-events', fuelEventsRoutes);
app.use('/api/orders', orderRoutes);

const start = async () => {
  await initDatabase();
  await startTcpServer();

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
          console.warn('Fleet simulator failed to start:', (err as Error).message);
        }
      }, 2500);
    } else {
      console.log(
        `Fleet simulator disabled — expecting real Teltonika devices on TCP port ${process.env.TCP_PORT ?? 5027}`
      );
    }
  });
};

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
