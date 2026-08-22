import express, { Request, Response } from 'express';
import { authenticateCustomer } from '../middleware/auth';
import {
  db,
  devices,
  vehicles,
  IMEI_PATTERN,
  eq,
  and,
  desc,
  sql,
} from '../lib/db-helpers';
import { logAndRespond } from '../lib/errors';

const router = express.Router();

router.use(authenticateCustomer);

/**
 * Whether the trackers are reporting Green Driving themselves.
 *
 * The FMC150 can judge harsh acceleration, braking and cornering with its own
 * accelerometer and report them as AVL element 253. FuelSense *also* derives
 * the same three from the GPS speed and heading series, because for a long
 * time no device here had the scenario switched on. When it is on, both run,
 * and both feed the safety score — so the score is stricter than either source
 * alone, and a manager reading it deserves to know that rather than wonder why
 * their fleet grades badly.
 *
 * Deliberately measured from frames actually received rather than from a
 * configuration flag: what matters is whether the events are arriving, not
 * what the Configurator was once set to.
 */
router.get('/green-driving', async (req: Request, res: Response) => {
  try {
    const customerId = req.user.customerId;
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);

    const result = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE f.event_id = 253)                      AS device_events,
        MAX(f.received_at) FILTER (WHERE f.event_id = 253)            AS last_device_event,
        COUNT(DISTINCT f.imei) FILTER (WHERE f.event_id = 253)        AS devices_reporting
      FROM device_frames f
      JOIN devices d ON d.imei = f.imei
      WHERE d.customer_id = ${customerId}
        AND f.received_at > NOW() - (${days} || ' days')::INTERVAL
    `);

    const derived = await db.execute(sql`
      SELECT COUNT(*) AS n
      FROM device_events
      WHERE customer_id = ${customerId}
        AND event_type IN ('harsh_acceleration', 'harsh_braking', 'harsh_cornering')
        AND unit = 'm/s2'
        AND occurred_at > NOW() - (${days} || ' days')::INTERVAL
    `);

    const row = (result.rows[0] ?? {}) as Record<string, unknown>;
    const deviceEvents = Number(row.device_events) || 0;

    res.json({
      period_days: days,
      // "Active" means the device is speaking, not that a checkbox is ticked.
      active: deviceEvents > 0,
      device_events: deviceEvents,
      devices_reporting: Number(row.devices_reporting) || 0,
      last_device_event_at: row.last_device_event ?? null,
      // The GPS-derived count, so the modal can show both contributions side
      // by side instead of asserting that double counting happens.
      derived_events:
        Number((derived.rows[0] as Record<string, unknown> | undefined)?.n ?? 0) || 0,
    });
  } catch (error) {
    logAndRespond(res, req.path, error, 'Could not check your tracker settings.');
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    const rows = await db
      .select({
        imei: devices.imei,
        vehicle_id: devices.vehicleId,
        customer_id: devices.customerId,
        device_model: devices.deviceModel,
        firmware_version: devices.firmwareVersion,
        is_active: devices.isActive,
        installed_at: devices.installedAt,
        last_seen_at: devices.lastSeenAt,
        created_at: devices.createdAt,
        license_plate: vehicles.licensePlate,
        make: vehicles.make,
        model: vehicles.model,
      })
      .from(devices)
      .innerJoin(vehicles, eq(devices.vehicleId, vehicles.id))
      .where(eq(devices.customerId, req.user.customerId))
      .orderBy(desc(devices.installedAt));

    res.json(rows);
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

router.post('/', async (req: Request, res: Response) => {
  const { imei, vehicleId, deviceModel } = req.body as {
    imei?: string;
    vehicleId?: string;
    deviceModel?: string;
  };

  if (!IMEI_PATTERN.test(imei || '')) {
    res.status(400).json({ error: 'IMEI must be exactly 15 digits' });
    return;
  }

  if (!vehicleId) {
    res.status(400).json({ error: 'Vehicle is required' });
    return;
  }

  try {
    const [vehicle] = await db
      .select({ id: vehicles.id })
      .from(vehicles)
      .where(and(eq(vehicles.id, vehicleId), eq(vehicles.customerId, req.user.customerId)));

    if (!vehicle) {
      res.status(403).json({ error: 'Vehicle not found' });
      return;
    }

    const [existing] = await db
      .select({ customerId: devices.customerId })
      .from(devices)
      .where(eq(devices.imei, imei!));

    if (existing && existing.customerId !== req.user.customerId) {
      res.status(409).json({ error: 'Device is registered to another account' });
      return;
    }

    const [device] = await db
      .insert(devices)
      .values({
        imei: imei!,
        vehicleId,
        customerId: req.user.customerId,
        deviceModel: deviceModel || 'FMC150',
        isActive: true,
      })
      .onConflictDoUpdate({
        target: devices.imei,
        set: {
          vehicleId,
          customerId: req.user.customerId,
          deviceModel: deviceModel || 'FMC150',
          isActive: true,
          updatedAt: sql`NOW()`,
        },
      })
      .returning({
        imei: devices.imei,
        vehicle_id: devices.vehicleId,
        customer_id: devices.customerId,
        device_model: devices.deviceModel,
        is_active: devices.isActive,
        installed_at: devices.installedAt,
        last_seen_at: devices.lastSeenAt,
      });

    res.status(201).json({
      success: true,
      message: 'Device added successfully',
      device,
    });
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

export default router;
