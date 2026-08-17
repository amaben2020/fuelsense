import express, { Request, Response } from 'express';
import { authenticateCustomer } from '../middleware/auth';
import { db, sql, eq, and } from '../lib/db-helpers';
import { maintenanceSchedules } from '../db/schema';
import { round1 } from '../lib/fuel-metrics';
import { logAndRespond } from '../lib/errors';

const router = express.Router();
router.use(authenticateCustomer);

/** Within this much of the interval, a service is "due soon" rather than fine. */
const DUE_SOON_KM = 500;
const DUE_SOON_DAYS = 14;

/**
 * Service schedules measured against the tracker's own odometer.
 *
 * The competing products anchor this to a mileage a driver types in, which
 * drifts the moment somebody forgets and makes every subsequent "overdue"
 * figure fiction. Here `current_km` is the vehicle's real total: the manager's
 * anchored baseline plus everything AVL 16 has counted since.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const customerId = req.user.customerId;

    const rows = await db.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (t.vehicle_id)
          t.vehicle_id,
          COALESCE(t.odometer_m::double precision / 1000.0, t.odometer_km::double precision)
            AS device_km,
          t.recorded_at
        FROM telemetry t
        WHERE t.customer_id = ${customerId}
        ORDER BY t.vehicle_id, t.recorded_at DESC
      )
      SELECT
        m.id,
        m.vehicle_id,
        v.license_plate,
        v.make,
        v.model,
        m.kind,
        m.interval_km,
        m.interval_days,
        m.last_service_km,
        m.last_service_at,
        m.notes,
        -- True mileage: the anchored dashboard reading plus whatever the device
        -- has counted since that anchor. Falls back to the raw device total
        -- when no baseline has been set, which is honest but not the odometer
        -- on the dash.
        CASE
          WHEN v.odometer_baseline_km IS NOT NULL
            AND v.odometer_baseline_device_km IS NOT NULL
            THEN v.odometer_baseline_km + GREATEST(0, latest.device_km - v.odometer_baseline_device_km)
          ELSE latest.device_km
        END AS current_km,
        v.odometer_baseline_km IS NOT NULL AS odometer_anchored,
        latest.recorded_at AS odometer_at
      FROM maintenance_schedules m
      JOIN vehicles v ON v.id = m.vehicle_id
      LEFT JOIN latest ON latest.vehicle_id = m.vehicle_id
      WHERE m.customer_id = ${customerId}
      ORDER BY v.license_plate, m.kind
    `);

    const now = Date.now();
    const items = rows.rows.map((r) => {
      const row = r as Record<string, unknown>;
      const currentKm = row.current_km == null ? null : Number(row.current_km);
      const intervalKm = row.interval_km == null ? null : Number(row.interval_km);
      const lastKm = row.last_service_km == null ? null : Number(row.last_service_km);
      const intervalDays = row.interval_days == null ? null : Number(row.interval_days);
      const lastAt = row.last_service_at ? new Date(String(row.last_service_at)) : null;

      // Distance remaining until the next service falls due.
      const dueAtKm = intervalKm != null && lastKm != null ? lastKm + intervalKm : null;
      const kmRemaining =
        dueAtKm != null && currentKm != null ? round1(dueAtKm - currentKm) : null;

      const dueAtDate =
        intervalDays != null && lastAt
          ? new Date(lastAt.getTime() + intervalDays * 86_400_000)
          : null;
      const daysRemaining =
        dueAtDate != null ? Math.round((dueAtDate.getTime() - now) / 86_400_000) : null;

      // Whichever limit bites first decides the status — a van can hit its
      // distance interval long before its time one, or the reverse.
      const overdue =
        (kmRemaining != null && kmRemaining < 0) || (daysRemaining != null && daysRemaining < 0);
      const dueSoon =
        !overdue &&
        ((kmRemaining != null && kmRemaining <= DUE_SOON_KM) ||
          (daysRemaining != null && daysRemaining <= DUE_SOON_DAYS));

      return {
        id: row.id,
        vehicle_id: row.vehicle_id,
        license_plate: row.license_plate,
        make: row.make,
        model: row.model,
        kind: row.kind,
        interval_km: intervalKm,
        interval_days: intervalDays,
        last_service_km: lastKm,
        last_service_at: row.last_service_at,
        notes: row.notes,
        current_km: currentKm == null ? null : round1(currentKm),
        /** False = mileage is device-since-fitting, not the dashboard reading. */
        odometer_anchored: Boolean(row.odometer_anchored),
        odometer_at: row.odometer_at,
        due_at_km: dueAtKm,
        km_remaining: kmRemaining,
        due_at: dueAtDate ? dueAtDate.toISOString() : null,
        days_remaining: daysRemaining,
        status: overdue ? 'overdue' : dueSoon ? 'due_soon' : 'ok',
      };
    });

    res.json({
      thresholds: { due_soon_km: DUE_SOON_KM, due_soon_days: DUE_SOON_DAYS },
      overdue: items.filter((i) => i.status === 'overdue').length,
      due_soon: items.filter((i) => i.status === 'due_soon').length,
      items,
    });
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

router.post('/', async (req: Request, res: Response) => {
  const {
    vehicle_id: vehicleId,
    kind,
    interval_km: intervalKm,
    interval_days: intervalDays,
    last_service_km: lastServiceKm,
    last_service_at: lastServiceAt,
    notes,
  } = req.body ?? {};

  if (!vehicleId || !kind?.trim()) {
    res.status(400).json({ error: 'vehicle_id and kind are required' });
    return;
  }
  if (intervalKm == null && intervalDays == null) {
    res.status(400).json({ error: 'one of interval_km or interval_days is required' });
    return;
  }

  try {
    const [row] = await db
      .insert(maintenanceSchedules)
      .values({
        customerId: req.user.customerId,
        vehicleId,
        kind: String(kind).trim(),
        intervalKm: intervalKm == null ? null : Number(intervalKm),
        intervalDays: intervalDays == null ? null : Number(intervalDays),
        lastServiceKm: lastServiceKm == null ? null : Number(lastServiceKm),
        lastServiceAt: lastServiceAt ? new Date(lastServiceAt) : null,
        notes: notes ?? null,
      })
      .returning();
    res.status(201).json(row);
  } catch (error) {
    const message = (error as Error).message;
    // One schedule per kind per vehicle — two "oil_change" rows would race.
    if (message.includes('duplicate key')) {
      res.status(409).json({ error: `A "${kind}" schedule already exists for this vehicle` });
      return;
    }
    res.status(500).json({ error: message });
  }
});

/** Log a completed service — resets the interval from the current odometer. */
router.patch('/:id/complete', async (req: Request, res: Response) => {
  const { at_km: atKm } = req.body ?? {};
  try {
    const [row] = await db
      .update(maintenanceSchedules)
      .set({
        lastServiceKm: atKm == null ? null : Number(atKm),
        lastServiceAt: new Date(),
        updatedAt: sql`NOW()`,
      })
      .where(
        and(
          eq(maintenanceSchedules.id, String(req.params.id)),
          eq(maintenanceSchedules.customerId, req.user.customerId)
        )
      )
      .returning();

    if (!row) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    res.json(row);
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const [row] = await db
      .delete(maintenanceSchedules)
      .where(
        and(
          eq(maintenanceSchedules.id, String(req.params.id)),
          eq(maintenanceSchedules.customerId, req.user.customerId)
        )
      )
      .returning({ id: maintenanceSchedules.id });

    if (!row) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

export default router;
