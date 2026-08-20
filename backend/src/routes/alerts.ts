import express, { Request, Response } from 'express';
import { authenticateCustomer } from '../middleware/auth';
import { db, alerts, vehicles, eq, and, desc } from '../lib/db-helpers';
import { inArray } from 'drizzle-orm';
import { withCache, invalidate, cacheKey } from '../lib/redis';
import { logAndRespond } from '../lib/errors';

const router = express.Router();

router.use(authenticateCustomer);

const ANOMALY_META: Record<string, { type: string; severity: string; title: string }> = {
  fuel_theft: {
    type: 'theft',
    severity: 'critical',
    title: 'Fuel theft detected',
  },
  receipt_fraud: {
    type: 'fraud',
    severity: 'critical',
    title: 'Receipt mismatch detected',
  },
  excessive_idle: {
    type: 'idle',
    severity: 'warning',
    title: 'Excessive idling',
  },
  unlogged_fill: {
    type: 'fraud',
    severity: 'warning',
    title: 'Fill with no receipt',
  },
  route_deviation: {
    type: 'route',
    severity: 'warning',
    title: 'Off expected route',
  },
  poor_efficiency: {
    type: 'efficiency',
    severity: 'warning',
    title: 'Poor fuel efficiency',
  },
};

interface AlertRow {
  id: unknown;
  alert_type: string | null;
  vehicle_id: unknown;
  license_plate: string | null;
  message: unknown;
  fuel_drop_liters: unknown;
  estimated_loss_ngn: unknown;
  created_at: unknown;
  latitude: unknown;
  longitude: unknown;
  is_resolved: unknown;
}

function mapAlertToAnomaly(row: AlertRow): Record<string, unknown> {
  const meta = ANOMALY_META[row.alert_type ?? ''] ?? {
    type: 'theft',
    severity: 'warning',
    title: row.alert_type,
  };

  return {
    id: String(row.id),
    vehicle_id: row.vehicle_id,
    vehicle_plate: row.license_plate,
    type: meta.type,
    severity: meta.severity,
    message: meta.title,
    details: row.message,
    liters_lost:
      row.fuel_drop_liters != null ? Number(row.fuel_drop_liters) : undefined,
    amount_lost_ngn:
      row.estimated_loss_ngn != null ? Number(row.estimated_loss_ngn) : undefined,
    timestamp: row.created_at,
    latitude: row.latitude,
    longitude: row.longitude,
    acknowledged: !!row.is_resolved,
  };
}

/**
 * Alert types that genuinely want investigating.
 *
 * Everything used to arrive here, which is how a driver correctly filing a
 * receipt ended up in "What needs attention?" as a "Possible fuel anomaly" at
 * 68% confidence, alongside a low-fuel notice whose only action is "plan a
 * refuel". A list that reports good behaviour as suspicious teaches a manager
 * to stop reading it.
 */
const INVESTIGATION_ALERT_TYPES = [
  'fuel_theft',
  'receipt_fraud',
  'unlogged_fill',
  'route_deviation',
  'excessive_idle',
  'idle_fuel_waste',
  'poor_efficiency',
];

router.get('/anomalies', async (req: Request, res: Response) => {
  try {
    const key = cacheKey(req.user.customerId, 'anomalies');
    const result = await withCache(key, 8, async () => {
      const rows = await db
        .select({
          id: alerts.id,
          imei: alerts.imei,
          customer_id: alerts.customerId,
          vehicle_id: alerts.vehicleId,
          alert_type: alerts.alertType,
          message: alerts.message,
          fuel_level_liters: alerts.fuelLevelLiters,
          fuel_drop_liters: alerts.fuelDropLiters,
          estimated_loss_ngn: alerts.estimatedLossNgn,
          latitude: alerts.latitude,
          longitude: alerts.longitude,
          is_resolved: alerts.isResolved,
          created_at: alerts.createdAt,
          license_plate: vehicles.licensePlate,
        })
        .from(alerts)
        .leftJoin(vehicles, eq(alerts.vehicleId, vehicles.id))
        .where(
          and(
            eq(alerts.customerId, req.user.customerId),
            inArray(alerts.alertType, INVESTIGATION_ALERT_TYPES)
          )
        )
        .orderBy(desc(alerts.createdAt))
        .limit(30);
      return rows.map((row) => mapAlertToAnomaly(row as unknown as AlertRow));
    });
    res.json(result);
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    // The cap used to be a hardcoded 20 while /dashboard/summary counted every
    // unresolved row, so a fleet with more than 20 open alerts showed a
    // headline count its own detail view could not account for — 22 counted,
    // 20 listed, with nothing to explain the difference. Callers that need to
    // enumerate the count can now ask for enough rows to do it.
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
    const key = cacheKey(req.user.customerId, 'alerts', String(limit));
    const rows = await withCache(key, 8, () =>
      db
        .select({
          id: alerts.id,
          imei: alerts.imei,
          customer_id: alerts.customerId,
          vehicle_id: alerts.vehicleId,
          alert_type: alerts.alertType,
          message: alerts.message,
          fuel_level_liters: alerts.fuelLevelLiters,
          fuel_drop_liters: alerts.fuelDropLiters,
          estimated_loss_ngn: alerts.estimatedLossNgn,
          latitude: alerts.latitude,
          longitude: alerts.longitude,
          is_resolved: alerts.isResolved,
          resolved_at: alerts.resolvedAt,
          created_at: alerts.createdAt,
          license_plate: vehicles.licensePlate,
        })
        .from(alerts)
        .leftJoin(vehicles, eq(alerts.vehicleId, vehicles.id))
        .where(
          and(eq(alerts.customerId, req.user.customerId), eq(alerts.isResolved, false))
        )
        .orderBy(desc(alerts.createdAt))
        .limit(limit)
    );
    res.json(rows);
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

router.patch('/:id/acknowledge', async (req: Request, res: Response) => {
  try {
    const alertId = Number(req.params.id);
    if (!Number.isFinite(alertId)) {
      res.status(400).json({ error: 'Invalid alert id' });
      return;
    }

    const [updated] = await db
      .update(alerts)
      .set({ isResolved: true, resolvedAt: new Date() })
      .where(
        and(eq(alerts.id, alertId), eq(alerts.customerId, req.user.customerId))
      )
      .returning({ id: alerts.id });

    if (!updated) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }

    await invalidate(req.user.customerId, 'alerts', 'anomalies');
    res.json({ ok: true, id: updated.id });
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

/**
 * Resolve many alerts at once.
 *
 * A manager clearing a morning's queue would otherwise fire one request per
 * row — twenty round trips, twenty cache invalidations, and a list that
 * repaints under them as each lands. Ids are filtered to the caller's own
 * customer in the same statement, so a guessed id from another fleet updates
 * nothing rather than 404ing informatively.
 */
router.post('/resolve', async (req: Request, res: Response) => {
  try {
    const raw = (req.body ?? {}).ids;
    const ids = Array.isArray(raw)
      ? raw.map(Number).filter((n) => Number.isFinite(n)).slice(0, 500)
      : [];

    if (!ids.length) {
      res.status(400).json({ error: 'ids must be a non-empty array of alert ids' });
      return;
    }

    const updated = await db
      .update(alerts)
      .set({ isResolved: true, resolvedAt: new Date() })
      .where(
        and(
          inArray(alerts.id, ids),
          eq(alerts.customerId, req.user.customerId),
          eq(alerts.isResolved, false)
        )
      )
      .returning({ id: alerts.id });

    await invalidate(req.user.customerId, 'alerts', 'anomalies');
    res.json({ ok: true, resolved: updated.length, ids: updated.map((r) => r.id) });
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

export default router;
