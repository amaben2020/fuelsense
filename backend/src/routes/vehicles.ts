import express, { Request, Response } from 'express';
import { authenticateCustomer } from '../middleware/auth';
import { getFleetByCustomerId } from '../db/queries';
import {
  db,
  customers,
  vehicles,
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
