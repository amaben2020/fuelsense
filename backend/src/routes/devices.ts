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

const router = express.Router();

router.use(authenticateCustomer);

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
    res.status(500).json({ error: (error as Error).message });
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
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
