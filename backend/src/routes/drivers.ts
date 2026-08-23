import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { authenticateCustomer } from '../middleware/auth';
import { db, drivers, vehicles, eq, and, sql } from '../lib/db-helpers';
import {
  driverPeriodCte,
  driverTopPlaceCte,
  driverTripsCte,
  type ReportBucket,
} from '../lib/driver-report-sql';
import { round1, round2, baselineEfficiencyKmL, kmLToMpg } from '../lib/fuel-metrics';
import { localDate } from '../lib/telemetry-deltas-sql';
import { withCache, cacheKey } from '../lib/redis';
import { logAndRespond } from '../lib/errors';

const router = express.Router();

// Every route here reads `req.user.customerId`, but the middleware was imported
// and never mounted — so the whole router answered 500 on any call, which is
// why the dashboard has always reported zero drivers.
router.use(authenticateCustomer);

/**
 * Longest rolling window the report will aggregate over, per grain. A year of
 * months and a quarter of weeks are both about a dozen buckets — enough to see
 * a trend without asking Postgres to scan the whole telemetry table.
 */
const MAX_PERIODS: Record<ReportBucket, number> = { month: 12, week: 26, day: 31 };
const DEFAULT_PERIODS: Record<ReportBucket, number> = { month: 6, week: 8, day: 14 };

/** `YYYY-MM` for months, ISO week `YYYY-Www` for weeks, `YYYY-MM-DD` for days. */
const PERIOD_FORMAT: Record<ReportBucket, string> = {
  month: 'YYYY-MM',
  week: 'IYYY-"W"IW',
  day: 'YYYY-MM-DD',
};

const isBucket = (value: unknown): value is ReportBucket =>
  value === 'month' || value === 'week' || value === 'day';

/** A query param that must parse to a real date, or be absent. Never a silent Invalid Date. */
function parseDateParam(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
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
    logAndRespond(res, req.path, error);
  }
});

// Issue or rotate a driver's login. The PIN is only ever accepted here and
// never returned — the response reports whether one is set, nothing more.
/** How big a stored face may be. The client compresses well below this. */
const MAX_PHOTO_BYTES = 400_000;

/** Bytes a base64 data URL represents, without decoding it. */
function dataUrlBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * Set or clear a driver's photo.
 *
 * Stored as a data URL on the row, the same way receipt and odometer photos
 * are: this deployment has no object store, and a face at avatar size costs a
 * few tens of kilobytes. Sending null removes it and the card falls back to
 * initials.
 */
router.patch('/:id/photo', async (req: Request, res: Response) => {
  const { photo } = (req.body ?? {}) as { photo?: string | null };

  if (photo != null) {
    // Only real raster images, and only ones small enough to sit on a row.
    // A permissive check here would let any string become a stored "photo"
    // that every dashboard then tries to render.
    if (typeof photo !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(photo)) {
      res.status(400).json({ error: 'Photo must be a PNG, JPEG or WebP data URL' });
      return;
    }
    if (dataUrlBytes(photo) > MAX_PHOTO_BYTES) {
      res.status(413).json({ error: 'That image is too large — try a smaller one' });
      return;
    }
  }

  try {
    const [row] = await db
      .update(drivers)
      .set({ photoUrl: photo ?? null, updatedAt: sql`NOW()` })
      .where(
        and(eq(drivers.id, String(req.params.id)), eq(drivers.customerId, req.user.customerId))
      )
      .returning({ id: drivers.id, photo_url: drivers.photoUrl });

    if (!row) {
      res.status(404).json({ error: 'Driver not found' });
      return;
    }
    res.json({ success: true, id: row.id, photo_url: row.photo_url });
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

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
    logAndRespond(res, req.path, error);
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
        photo_url: drivers.photoUrl,
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
    logAndRespond(res, req.path, error);
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
    logAndRespond(res, req.path, error);
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
  const bucket: ReportBucket = isBucket(req.query.bucket) ? req.query.bucket : 'month';
  const requested = Number(req.query.periods ?? req.query.months);
  const periods = Math.min(
    Math.max(Number.isFinite(requested) ? requested : DEFAULT_PERIODS[bucket], 1),
    MAX_PERIODS[bucket],
  );
  const from = parseDateParam(req.query.from);
  const to = parseDateParam(req.query.to);

  if (from && to && from > to) {
    res.status(400).json({ error: '`from` must not be after `to`.' });
    return;
  }

  try {
    const customerId = req.user.customerId;
    const periodFormat = PERIOD_FORMAT[bucket];
    const cacheId = [bucket, periods, from?.toISOString() ?? '', to?.toISOString() ?? ''].join(':');

    const payload = await withCache(cacheKey(customerId, 'driver-reports', cacheId), 60, async () => {
      const monthly = await db.execute(sql`
        WITH ${driverPeriodCte({ customerId, bucket, from, to, periods })},
        ${driverTripsCte({ gapMinutes: TRIP_GAP_MINUTES })},
        totals AS (
          SELECT
            driver_id,
            driver_name,
            period,
            MIN(model) AS model,
            MIN(manual_l100km) AS manual_l100km,
            COUNT(DISTINCT license_plate) AS vehicles,
            COALESCE(SUM(dist_delta), 0) AS distance_km,
            COALESCE(SUM(fuel_delta), 0) AS fuel_liters,
            COALESCE(SUM(idle_delta_s), 0) AS idle_seconds,
            COALESCE(SUM(moving_delta_s), 0) AS moving_seconds,
            COUNT(DISTINCT CASE WHEN dist_delta > 0 THEN ${localDate} END) AS active_days,
            MAX(recorded_at) AS last_seen_at
          FROM deltas
          WHERE driver_name IS NOT NULL
          GROUP BY driver_id, driver_name, period
        )
        SELECT
          t.driver_id,
          t.driver_name,
          to_char(t.period, ${periodFormat}) AS period,
          t.manual_l100km,
          t.period AS period_start,
          (t.period + ('1 ' || ${bucket})::INTERVAL - INTERVAL '1 day')::date AS period_end,
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
          ON tc.driver_name = t.driver_name AND tc.period = t.period
        ORDER BY t.driver_name, t.period DESC
      `);

      const places = await db.execute(sql`
        WITH ${driverPeriodCte({ customerId, bucket, from, to, periods })},
        ${driverTopPlaceCte({ minFixes: MIN_PLACE_FIXES })}
        SELECT
          driver_id,
          driver_name,
          to_char(period, ${periodFormat}) AS period,
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
        period: string;
        place_name: string | null;
        formatted_address: string | null;
        lat_key: string;
        lng_key: string;
        fixes: string;
      };

      const placeFor = new Map<string, PlaceRow>();
      for (const row of places.rows as unknown as PlaceRow[]) {
        placeFor.set(`${row.driver_name}|${row.period}`, row);
      }

      type PeriodRow = {
        driver_id: string | null;
        driver_name: string;
        period: string;
        period_start: string;
        period_end: string;
        manual_l100km: string | null;
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
        { driver_id: string | null; driver_name: string; periods: unknown[] }
      >();

      for (const row of monthly.rows as unknown as PeriodRow[]) {
        const distanceKm = Number(row.distance_km);
        const fuelLiters = Number(row.fuel_liters);
        // The vehicle's own dashboard figure, when the manager entered one,
        // outranks the model-name lookup it would otherwise fall back to.
        const manualL100km = row.manual_l100km != null ? Number(row.manual_l100km) : null;
        const baselineKmL =
          manualL100km != null && manualL100km > 0
            ? round1(100 / manualL100km)
            : row.model
              ? round1(baselineEfficiencyKmL(row.model))
              : null;

        // How much of the fuel this distance must have burned actually shows up
        // as level deltas. Periods where the tracker logged movement but only
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
        const place = placeFor.get(`${row.driver_name}|${row.period}`) ?? null;

        const entry = byDriver.get(row.driver_name) ?? {
          driver_id: row.driver_id,
          driver_name: row.driver_name,
          periods: [],
        };
        entry.periods.push({
          period: row.period,
          period_start: row.period_start,
          period_end: row.period_end,
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
        bucket,
        periods,
        from: from?.toISOString() ?? null,
        to: to?.toISOString() ?? null,
        // Telemetry carries no driver identity, so every figure is attributed
        // through the vehicle's current assignment. Surfaced so the UI can say so.
        attribution: 'vehicle_assignment' as const,
        drivers: [...byDriver.values()],
      };
    });

    res.json(payload);
  } catch (error) {
    logAndRespond(res, req.path, error);
  }
});

export default router;
