import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { authenticateCustomer } from '../middleware/auth';
import { db, drivers, vehicles, eq, and, sql } from '../lib/db-helpers';
import { driverMonthlyCte, driverTopPlaceCte, driverTripsCte } from '../lib/driver-report-sql';
import { round1, round2, baselineEfficiencyKmL, kmLToMpg } from '../lib/fuel-metrics';
import { withCache, cacheKey } from '../lib/redis';

const router = express.Router();

// Every route here reads `req.user.customerId`, but the middleware was imported
// and never mounted — so the whole router answered 500 on any call, which is
// why the dashboard has always reported zero drivers.
router.use(authenticateCustomer);

/** Longest window the monthly report will aggregate over. */
const MAX_REPORT_MONTHS = 12;
/**
 * Stationary fixes needed before a grid square counts as a place the driver
 * actually visited. At a ~30 s cadence this is roughly three minutes parked,
 * which clears traffic lights and junction queues.
 */
const MIN_PLACE_FIXES = 6;
/** A stop longer than this ends a trip and the next movement starts a new one. */
const TRIP_GAP_MINUTES = 10;
/**
 * Minimum share of the fuel a month's distance should have burned that must
 * actually appear as level deltas before the km/L ratio is reported at all.
 */
const FUEL_COVERAGE_FLOOR = 0.6;

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

/**
 * Monthly performance report per driver.
 *
 * Everything returned is measured from telemetry — distance from the odometer
 * with the same capping the fleet figures use, fuel from consumption-only level
 * deltas, places from stationary fixes joined to the geocode cache. Where a
 * figure cannot be derived it is returned as null; nothing is modelled or
 * back-filled, because these numbers get put to drivers.
 */
router.get('/reports', async (req: Request, res: Response) => {
  const months = Math.min(Math.max(Number(req.query.months) || 6, 1), MAX_REPORT_MONTHS);

  try {
    const customerId = req.user.customerId;

    const payload = await withCache(cacheKey(customerId, 'driver-reports', String(months)), 60, async () => {
      const monthly = await db.execute(sql`
        WITH ${driverMonthlyCte({ customerId, months })},
        ${driverTripsCte({ gapMinutes: TRIP_GAP_MINUTES })},
        totals AS (
          SELECT
            driver_id,
            driver_name,
            month,
            MIN(model) AS model,
            COUNT(DISTINCT license_plate) AS vehicles,
            COALESCE(SUM(dist_delta), 0) AS distance_km,
            COALESCE(SUM(fuel_delta), 0) AS fuel_liters,
            COALESCE(SUM(idle_delta_s), 0) AS idle_seconds,
            COALESCE(SUM(moving_delta_s), 0) AS moving_seconds,
            COUNT(DISTINCT CASE WHEN dist_delta > 0 THEN recorded_at::date END) AS active_days,
            MAX(recorded_at) AS last_seen_at
          FROM deltas
          WHERE driver_name IS NOT NULL
          GROUP BY driver_id, driver_name, month
        )
        SELECT
          t.driver_id,
          t.driver_name,
          to_char(t.month, 'YYYY-MM') AS month,
          t.model,
          t.vehicles,
          t.distance_km,
          t.fuel_liters,
          t.idle_seconds,
          t.moving_seconds,
          COALESCE(tc.trips, 0) AS trips,
          t.active_days,
          t.last_seen_at
        FROM totals t
        LEFT JOIN trip_counts tc
          ON tc.driver_name = t.driver_name AND tc.month = t.month
        ORDER BY t.driver_name, t.month DESC
      `);

      const places = await db.execute(sql`
        WITH ${driverMonthlyCte({ customerId, months })},
        ${driverTopPlaceCte({ minFixes: MIN_PLACE_FIXES })}
        SELECT
          driver_id,
          driver_name,
          to_char(month, 'YYYY-MM') AS month,
          place_name,
          formatted_address,
          lat_key,
          lng_key,
          fixes
        FROM ranked_places
        WHERE rn = 1
      `);

      type PlaceRow = {
        driver_id: string | null;
        driver_name: string;
        month: string;
        place_name: string | null;
        formatted_address: string | null;
        lat_key: string;
        lng_key: string;
        fixes: string;
      };

      const placeFor = new Map<string, PlaceRow>();
      for (const row of places.rows as unknown as PlaceRow[]) {
        placeFor.set(`${row.driver_name}|${row.month}`, row);
      }

      type MonthRow = {
        driver_id: string | null;
        driver_name: string;
        month: string;
        model: string | null;
        vehicles: string;
        distance_km: string;
        fuel_liters: string;
        idle_seconds: string;
        moving_seconds: string;
        trips: string;
        active_days: string;
        last_seen_at: string | null;
      };

      const byDriver = new Map<
        string,
        { driver_id: string | null; driver_name: string; months: unknown[] }
      >();

      for (const row of monthly.rows as unknown as MonthRow[]) {
        const distanceKm = Number(row.distance_km);
        const fuelLiters = Number(row.fuel_liters);
        const baselineKmL = row.model ? round1(baselineEfficiencyKmL(row.model)) : null;

        // How much of the fuel this distance must have burned actually shows up
        // as level deltas. Months where the tracker logged movement but only
        // patchy fuel levels otherwise divide a full distance by a partial
        // litre count and report a RAV4 doing double its rated economy — a
        // flattering number with nothing behind it. Below the floor the ratio
        // is withheld rather than shown with a caveat nobody reads.
        const expectedLiters =
          baselineKmL != null && baselineKmL > 0 ? distanceKm / baselineKmL : null;
        const fuelCoverage =
          expectedLiters != null && expectedLiters > 0
            ? round2(fuelLiters / expectedLiters)
            : null;
        const fuelComplete = fuelCoverage == null || fuelCoverage >= FUEL_COVERAGE_FLOOR;

        // km/L only means something once there is enough of both to divide,
        // and only when the fuel side of that division is trustworthy.
        const efficiencyKmL =
          distanceKm > 1 && fuelLiters > 0.5 && fuelComplete
            ? round2(distanceKm / fuelLiters)
            : null;
        const place = placeFor.get(`${row.driver_name}|${row.month}`) ?? null;

        const entry = byDriver.get(row.driver_name) ?? {
          driver_id: row.driver_id,
          driver_name: row.driver_name,
          months: [],
        };
        entry.months.push({
          month: row.month,
          distance_km: round1(distanceKm),
          fuel_liters: round1(fuelLiters),
          efficiency_km_l: efficiencyKmL,
          efficiency_mpg: kmLToMpg(efficiencyKmL),
          baseline_km_l: baselineKmL,
          // Lets the UI say "partial fuel data" instead of leaving a bare dash.
          fuel_coverage: fuelCoverage,
          fuel_complete: fuelComplete,
          moving_hours: round1(Number(row.moving_seconds) / 3600),
          idle_hours: round1(Number(row.idle_seconds) / 3600),
          trips: Number(row.trips),
          active_days: Number(row.active_days),
          vehicles: Number(row.vehicles),
          last_seen_at: row.last_seen_at,
          top_location: place
            ? {
                // Null name = the coordinates were never geocoded. Reported as
                // such rather than labelled with a guess.
                name: place.place_name,
                address: place.formatted_address,
                latitude: Number(place.lat_key),
                longitude: Number(place.lng_key),
                visits: Number(place.fixes),
              }
            : null,
        });
        byDriver.set(row.driver_name, entry);
      }

      return {
        months,
        // Telemetry carries no driver identity, so every figure is attributed
        // through the vehicle's current assignment. Surfaced so the UI can say so.
        attribution: 'vehicle_assignment' as const,
        drivers: [...byDriver.values()],
      };
    });

    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
