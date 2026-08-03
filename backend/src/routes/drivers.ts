import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { authenticateCustomer } from '../middleware/auth';
import { db, drivers, vehicles, eq, and, sql } from '../lib/db-helpers';

const router = express.Router();

// Matches the cost used everywhere else a driver PIN is written.
const PIN_ROUNDS = 12;
const PIN_PATTERN = /^\d{4,6}$/;

// routes/driver.ts's login looks a driver up by driver_code alone — it is NOT
// scoped to a customer — so a code has to be unique across the whole table,
// not just within one fleet. Codes are stored upper-cased because login
// upper-cases what the driver types before matching.
const normalizeCode = (code: string): string => code.trim().toUpperCase();

async function codeTaken(code: string, exceptDriverId?: string): Promise<boolean> {
  const rows = await db
    .select({ id: drivers.id })
    .from(drivers)
    .where(eq(drivers.driverCode, code));
  return rows.some((r) => r.id !== exceptDriverId);
}

/** Validates the optional credential half of a create/update payload. */
function readCredentials(body: { driver_code?: string; pin?: string }):
  | { ok: true; code: string | null; pin: string | null }
  | { ok: false; error: string } {
  const rawCode = body.driver_code?.trim();
  const rawPin = body.pin?.trim();

  if (rawCode && !rawPin) return { ok: false, error: 'pin is required when driver_code is set' };
  if (rawPin && !rawCode) return { ok: false, error: 'driver_code is required when pin is set' };
  if (rawPin && !PIN_PATTERN.test(rawPin)) {
    return { ok: false, error: 'pin must be 4 to 6 digits' };
  }
  if (rawCode && rawCode.length > 50) {
    return { ok: false, error: 'driver_code must be 50 characters or fewer' };
  }

  return { ok: true, code: rawCode ? normalizeCode(rawCode) : null, pin: rawPin ?? null };
}

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

  const creds = readCredentials(req.body ?? {});
  if (!creds.ok) {
    res.status(400).json({ error: creds.error });
    return;
  }

  try {
    if (creds.code && (await codeTaken(creds.code))) {
      res.status(409).json({ error: `Driver code "${creds.code}" is already in use` });
      return;
    }

    const [driver] = await db
      .insert(drivers)
      .values({
        customerId: req.user.customerId,
        fullName: full_name.trim(),
        phone: phone?.trim() || null,
        licenseNumber: license_number?.trim() || null,
        driverCode: creds.code,
        pinHash: creds.pin ? await bcrypt.hash(creds.pin, PIN_ROUNDS) : null,
      })
      .returning({
        id: drivers.id,
        full_name: drivers.fullName,
        phone: drivers.phone,
        license_number: drivers.licenseNumber,
        driver_code: drivers.driverCode,
        status: drivers.status,
        vehicle_id: sql<string | null>`null`,
        license_plate: sql<string | null>`null`,
        created_at: drivers.createdAt,
      });

    res.status(201).json({ ...driver, has_pin: Boolean(creds.pin) });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Issue or rotate a driver's login. The PIN is only ever accepted here and
// never returned — the response reports whether one is set, nothing more.
router.patch('/:id/credentials', async (req: Request, res: Response) => {
  const creds = readCredentials(req.body ?? {});
  if (!creds.ok) {
    res.status(400).json({ error: creds.error });
    return;
  }
  if (!creds.code || !creds.pin) {
    res.status(400).json({ error: 'driver_code and pin are required' });
    return;
  }

  try {
    const [driver] = await db
      .select({ id: drivers.id })
      .from(drivers)
      .where(
        and(eq(drivers.id, String(req.params.id)), eq(drivers.customerId, req.user.customerId))
      );

    if (!driver) {
      res.status(404).json({ error: 'Driver not found' });
      return;
    }

    if (await codeTaken(creds.code, driver.id)) {
      res.status(409).json({ error: `Driver code "${creds.code}" is already in use` });
      return;
    }

    const [updated] = await db
      .update(drivers)
      .set({
        driverCode: creds.code,
        pinHash: await bcrypt.hash(creds.pin, PIN_ROUNDS),
        updatedAt: sql`NOW()`,
      })
      .where(eq(drivers.id, driver.id))
      .returning({
        id: drivers.id,
        full_name: drivers.fullName,
        driver_code: drivers.driverCode,
        status: drivers.status,
      });

    res.json({ ...updated, has_pin: true });
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
        driver_code: drivers.driverCode,
        // Never expose the hash — the UI only needs to know a login exists.
        has_pin: sql<boolean>`${drivers.pinHash} IS NOT NULL`,
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
