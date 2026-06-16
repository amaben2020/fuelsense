import express, { Request, Response } from 'express';
import { authenticateCustomer } from '../middleware/auth';
import { db, drivers, vehicles, eq, and, sql } from '../lib/db-helpers';

const router = express.Router();

router.use(authenticateCustomer);

router.post('/', async (req: Request, res: Response) => {
  const { full_name, phone, license_number } = req.body as {
    full_name?: string;
    phone?: string;
    license_number?: string;
  };

  if (!full_name?.trim()) {
    res.status(400).json({ error: 'full_name is required' });
    return;
  }

  try {
    const [driver] = await db
      .insert(drivers)
      .values({
        customerId: req.user.customerId,
        fullName: full_name.trim(),
        phone: phone?.trim() || null,
        licenseNumber: license_number?.trim() || null,
      })
      .returning({
        id: drivers.id,
        full_name: drivers.fullName,
        phone: drivers.phone,
        license_number: drivers.licenseNumber,
        status: drivers.status,
        vehicle_id: sql<string | null>`null`,
        license_plate: sql<string | null>`null`,
        created_at: drivers.createdAt,
      });

    res.status(201).json(driver);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    const rows = await db
      .select({
        id: drivers.id,
        full_name: drivers.fullName,
        phone: drivers.phone,
        license_number: drivers.licenseNumber,
        status: drivers.status,
        vehicle_id: vehicles.id,
        license_plate: vehicles.licensePlate,
        created_at: drivers.createdAt,
      })
      .from(drivers)
      .leftJoin(
        vehicles,
        and(eq(vehicles.driverId, drivers.id), eq(vehicles.customerId, drivers.customerId))
      )
      .where(eq(drivers.customerId, req.user.customerId))
      .orderBy(drivers.fullName);

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.patch('/assign', async (req: Request, res: Response) => {
  const { driver_id: driverId, vehicle_id: vehicleId } = req.body as {
    driver_id?: string;
    vehicle_id?: string;
  };

  if (!driverId || !vehicleId) {
    res.status(400).json({ error: 'driver_id and vehicle_id are required' });
    return;
  }

  try {
    const customerId = req.user.customerId;

    const [driver] = await db
      .select({ id: drivers.id, fullName: drivers.fullName })
      .from(drivers)
      .where(and(eq(drivers.id, driverId), eq(drivers.customerId, customerId)));

    if (!driver) {
      res.status(404).json({ error: 'Driver not found' });
      return;
    }

    await db
      .update(vehicles)
      .set({ driverId: null, driverName: null, updatedAt: sql`NOW()` })
      .where(and(eq(vehicles.driverId, driverId), eq(vehicles.customerId, customerId)));

    const [vehicle] = await db
      .update(vehicles)
      .set({
        driverId: driverId,
        driverName: driver.fullName,
        updatedAt: sql`NOW()`,
      })
      .where(and(eq(vehicles.id, vehicleId), eq(vehicles.customerId, customerId)))
      .returning({
        id: vehicles.id,
        license_plate: vehicles.licensePlate,
        driver_id: vehicles.driverId,
        driver_name: vehicles.driverName,
      });

    if (!vehicle) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }

    res.json(vehicle);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
