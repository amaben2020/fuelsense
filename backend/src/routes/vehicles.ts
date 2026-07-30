import express, { Request, Response } from 'express';
import { authenticateCustomer } from '../middleware/auth';
import { getFleetByCustomerId } from '../db/queries';
import {
  db,
  customers,
  vehicles,
  telemetry,
  IMEI_PATTERN,
  linkDevice,
  createVehicle,
  customerPublicSelect,
  eq,
  and,
  desc,
  sql,
} from '../lib/db-helpers';
import { withCache, invalidate, cacheKey } from '../lib/redis';
import { getVirtualTank, calibrateTank } from '../lib/virtual-tank';

const router = express.Router();

router.use(authenticateCustomer);

router.get('/fleet', async (req: Request, res: Response) => {
  try {
    const key = cacheKey(req.user.customerId, 'fleet');
    const rows = await withCache(key, 5, () => getFleetByCustomerId(db, req.user.customerId));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    const rows = await db
      .select({
        id: vehicles.id,
        customer_id: vehicles.customerId,
        license_plate: vehicles.licensePlate,
        make: vehicles.make,
        model: vehicles.model,
        year: vehicles.year,
        tank_capacity_liters: vehicles.tankCapacityLiters,
        created_at: vehicles.createdAt,
        updated_at: vehicles.updatedAt,
      })
      .from(vehicles)
      .where(eq(vehicles.customerId, req.user.customerId))
      .orderBy(desc(vehicles.createdAt));

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

const serializeTank = (tank: NonNullable<Awaited<ReturnType<typeof getVirtualTank>>>) => ({
  vehicle_id: tank.vehicleId,
  capacity_liters: tank.capacityLiters,
  level_liters: Number((tank.levelMl / 1000).toFixed(2)),
  level_percent:
    tank.capacityLiters > 0
      ? Math.round((tank.levelMl / 1000 / tank.capacityLiters) * 100)
      : null,
  confidence: tank.confidence,
  calibrated_at: tank.calibratedAt,
  calibration_source: tank.calibrationSource,
  consumed_since_calibration_liters: Number(
    (tank.consumedSinceCalibrationMl / 1000).toFixed(2)
  ),
  learned_idle_lph: tank.learnedIdleLph,
  last_reading_at: tank.lastReadingAt,
});

const ownedVehicle = async (vehicleId: string, customerId: string) => {
  const [row] = await db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.customerId, customerId)))
    .limit(1);
  return row ?? null;
};

router.get('/:id/virtual-tank', async (req: Request, res: Response) => {
  const vehicleId = String(req.params.id);
  try {
    if (!(await ownedVehicle(vehicleId, req.user.customerId))) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }
    const tank = await getVirtualTank(vehicleId);
    res.json(tank ? serializeTank(tank) : null);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Anchor the virtual tank to a known level. Body: { liters?: number } —
// omitted/null means "driver filled the tank" (level = capacity).
router.post('/:id/virtual-tank/calibrate', async (req: Request, res: Response) => {
  const { liters } = req.body as { liters?: number | null };

  if (liters != null && (!Number.isFinite(Number(liters)) || Number(liters) < 0)) {
    res.status(400).json({ error: 'liters must be a non-negative number' });
    return;
  }

  const vehicleId = String(req.params.id);
  try {
    if (!(await ownedVehicle(vehicleId, req.user.customerId))) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }

    const tank = await calibrateTank(
      vehicleId,
      req.user.customerId,
      liters != null ? Number(liters) : null,
      liters != null ? 'manual_partial' : 'manual_full'
    );

    await invalidate(req.user.customerId, 'fleet', 'summary');
    res.json({ success: true, tank: serializeTank(tank) });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Anchor the vehicle's true mileage to the dashboard reading. The tracker only
// counts distance since it was fitted, so we store the manager's reading plus
// the device's counter at that instant and report the sum from then on.
router.post('/:id/odometer', async (req: Request, res: Response) => {
  const vehicleId = String(req.params.id);
  const { odometerKm } = req.body as { odometerKm?: number };
  const reading = Number(odometerKm);

  if (!Number.isFinite(reading) || reading < 0) {
    res.status(400).json({ error: 'odometerKm must be a non-negative number' });
    return;
  }

  try {
    if (!(await ownedVehicle(vehicleId, req.user.customerId))) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }

    const [latest] = await db
      .select({ odometer_km: telemetry.odometerKm })
      .from(telemetry)
      .where(and(eq(telemetry.vehicleId, vehicleId), sql`odometer_km IS NOT NULL`))
      .orderBy(desc(telemetry.recordedAt))
      .limit(1);

    const deviceKm = latest?.odometer_km ?? 0;

    const [row] = await db
      .update(vehicles)
      .set({
        odometerBaselineKm: Math.round(reading),
        odometerBaselineDeviceKm: deviceKm,
        odometerBaselineAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      })
      .where(eq(vehicles.id, vehicleId))
      .returning({
        baseline_km: vehicles.odometerBaselineKm,
        baseline_device_km: vehicles.odometerBaselineDeviceKm,
      });

    await invalidate(req.user.customerId, 'fleet', 'summary');
    res.json({
      success: true,
      total_odometer_km: row.baseline_km,
      baseline_km: row.baseline_km,
      device_km_at_baseline: row.baseline_device_km,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.post('/', async (req: Request, res: Response) => {
  const { licensePlate, make, model, year, tankCapacityLiters, imei, deviceModel } =
    req.body as {
      licensePlate?: string;
      make?: string;
      model?: string;
      year?: number;
      tankCapacityLiters?: number;
      imei?: string;
      deviceModel?: string;
    };

  try {
    const result = await db.transaction(async (tx) => {
      const vehicle = await createVehicle(tx, req.user.customerId, {
        licensePlate,
        make,
        model,
        year,
        tankCapacityLiters,
      });

      if (imei) {
        await linkDevice(tx, {
          imei,
          vehicleId: vehicle.id,
          customerId: req.user.customerId,
          deviceModel,
        });
      }

      const fleet = imei ? await getFleetByCustomerId(tx, req.user.customerId) : null;
      const fleetRow = fleet?.find((row: { id: string }) => row.id === vehicle.id) ?? null;

      return { vehicle, fleetRow };
    });

    await invalidate(req.user.customerId, 'fleet', 'summary', 'alerts');
    res.status(201).json({
      success: true,
      ...result.vehicle,
      imei: imei || null,
      fleetRow: result.fleetRow,
    });
  } catch (error) {
    const err = error as Error & { status?: number; code?: string };
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err.code === '23505') {
      res.status(409).json({ error: 'Vehicle with this license plate already exists' });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/with-device', async (req: Request, res: Response) => {
  const {
    licensePlate,
    make,
    model,
    year,
    tankCapacityLiters,
    imei,
    deviceModel,
  } = req.body as {
    licensePlate?: string;
    make?: string;
    model?: string;
    year?: number;
    tankCapacityLiters?: number;
    imei?: string;
    deviceModel?: string;
  };

  if (!imei) {
    res.status(400).json({ error: 'IMEI is required' });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const vehicle = await createVehicle(tx, req.user.customerId, {
        licensePlate,
        make,
        model,
        year,
        tankCapacityLiters,
      });

      await linkDevice(tx, {
        imei,
        vehicleId: vehicle.id,
        customerId: req.user.customerId,
        deviceModel,
      });

      const fleet = await getFleetByCustomerId(tx, req.user.customerId);
      const fleetRow = fleet.find((row: { id: string }) => row.id === vehicle.id) ?? null;

      return { vehicle, fleetRow };
    });

    await invalidate(req.user.customerId, 'fleet', 'summary', 'alerts');
    res.status(201).json({
      success: true,
      message: 'Vehicle and device added. Data will appear once the tracker connects.',
      vehicle: result.vehicle,
      imei,
      fleetRow: result.fleetRow,
    });
  } catch (error) {
    const err = error as Error & { status?: number; code?: string };
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err.code === '23505') {
      res.status(409).json({ error: 'Vehicle with this license plate already exists' });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/bulk', async (req: Request, res: Response) => {
  const { vehicles: vehicleEntries } = req.body as {
    vehicles?: Array<{
      licensePlate?: string;
      make?: string;
      model?: string;
      year?: number;
      tankCapacityLiters?: number;
      imei?: string;
      deviceModel?: string;
    }>;
  };

  if (!Array.isArray(vehicleEntries) || vehicleEntries.length === 0) {
    res.status(400).json({ error: 'At least one vehicle is required' });
    return;
  }

  if (vehicleEntries.length > 20) {
    res.status(400).json({ error: 'Maximum 20 vehicles per bulk upload' });
    return;
  }

  try {
    const added = await db.transaction(async (tx) => {
      const results: Array<Record<string, unknown>> = [];

      for (const entry of vehicleEntries) {
        const vehicle = await createVehicle(tx, req.user.customerId, {
          licensePlate: entry.licensePlate,
          make: entry.make,
          model: entry.model,
          year: entry.year,
          tankCapacityLiters: entry.tankCapacityLiters,
        });

        if (entry.imei) {
          await linkDevice(tx, {
            imei: entry.imei,
            vehicleId: vehicle.id,
            customerId: req.user.customerId,
            deviceModel: entry.deviceModel || 'FMC150',
          });
        }

        results.push({ ...vehicle, imei: entry.imei || null });
      }

      await tx
        .update(customers)
        .set({ onboardingCompleted: true, updatedAt: sql`NOW()` })
        .where(eq(customers.id, req.user.customerId));

      return results;
    });

    const fleet = await getFleetByCustomerId(db, req.user.customerId);

    res.status(201).json({
      success: true,
      message: `${added.length} vehicle(s) added successfully`,
      vehicles: added,
      fleet,
    });
  } catch (error) {
    const err = error as Error & { status?: number; code?: string };
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err.code === '23505') {
      res.status(409).json({ error: 'Duplicate license plate in your fleet' });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

export default router;
