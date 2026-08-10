import express, { Request, Response } from 'express';
import { authenticateCustomer } from '../middleware/auth';
import { db, telemetry, vehicles, fuelPurchases, eq, and, desc, sql } from '../lib/db-helpers';
import { withCache, invalidate, cacheKey } from '../lib/redis';
import { fleetEfficiencyAggSql } from '../lib/fleet-efficiency-sql';
import { dailyActivitySql } from '../lib/daily-activity-sql';
import { buildDailyActivityReplay } from '../lib/event-replay';
import { segmentTrips, TelemetryTripPoint, TripStop } from '../lib/trip-segmentation';
import {
  CO2_KG_PER_LITER,
  round1,
  round2,
  baselineEfficiencyKmL,
  baselineEfficiencyL100km,
  computeL100km,
  efficiencyDeviationPercentL100km,
  REFUEL_THRESHOLD_LITERS,
  DEFAULT_FUEL_PRICE_NGN_LITER,
  IDLE_BURN_LITERS_PER_HOUR,
  speedBucketMultiplier,
  speedBucketLabel,
} from '../lib/fuel-metrics';
import {
  dailyDistanceThreshold,
  buildDailyFlags,
  classifyDailyRow,
  formatActivityDateDisplay,
  EFFICIENCY_TIERS,
  EFFICIENCY_VARIANCE_THRESHOLD_PERCENT,
  DAILY_DISTANCE_BY_MODEL,
} from '../lib/activity-thresholds';
import { findObdRefuelMatch, buildReceiptTimeline, assessReceiptEvent } from '../lib/receipt-reconciliation';
import { creditRefuel } from '../lib/virtual-tank';
import { reconcileFuelPurchase, consumptionTrend } from '../lib/fuel-calibration';
import { lookupPlace, cachedPlaceNames, placeKeyFor } from '../lib/place-lookup';
import { latestReceiptPrice, currentBenchmarkPrice } from '../lib/fuel-price';
import { googleUsageSnapshot } from '../lib/google-usage';
import { getSerializedIoValue } from '../lib/avl-io';
import { decodeSignal } from '../lib/avl-catalogue';
import { serializeForApi } from '../lib/serialize';

const router = express.Router();

router.use(authenticateCustomer);

router.get('/latest', async (req: Request, res: Response) => {
  try {
    const [row] = await db
      .select({
        id: telemetry.id,
        imei: telemetry.imei,
        customer_id: telemetry.customerId,
        vehicle_id: telemetry.vehicleId,
        recorded_at: telemetry.recordedAt,
        fuel_level_liters: telemetry.fuelLevelLiters,
        odometer_km: telemetry.odometerKm,
        latitude: telemetry.latitude,
        longitude: telemetry.longitude,
        speed_kph: telemetry.speedKph,
        ignition_on: telemetry.ignitionOn,
        created_at: telemetry.createdAt,
        license_plate: vehicles.licensePlate,
      })
      .from(telemetry)
      .leftJoin(vehicles, eq(telemetry.vehicleId, vehicles.id))
      .where(eq(telemetry.customerId, req.user.customerId))
      .orderBy(desc(telemetry.recordedAt))
      .limit(1);

    res.json(row || null);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/history', async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const vehicleId = typeof req.query.vehicle_id === 'string' ? req.query.vehicle_id : null;

  try {
    const rows = await db
      .select({
        id: telemetry.id,
        imei: telemetry.imei,
        customer_id: telemetry.customerId,
        vehicle_id: telemetry.vehicleId,
        recorded_at: telemetry.recordedAt,
        fuel_level_liters: telemetry.fuelLevelLiters,
        fuel_source: telemetry.fuelSource,
        fuel_rate_lph: telemetry.fuelRateLph,
        odometer_km: telemetry.odometerKm,
        latitude: telemetry.latitude,
        longitude: telemetry.longitude,
        speed_kph: telemetry.speedKph,
        ignition_on: telemetry.ignitionOn,
        created_at: telemetry.createdAt,
        license_plate: vehicles.licensePlate,
      })
      .from(telemetry)
      .leftJoin(vehicles, eq(telemetry.vehicleId, vehicles.id))
      .where(
        vehicleId
          ? and(eq(telemetry.customerId, req.user.customerId), eq(telemetry.vehicleId, vehicleId))
          : eq(telemetry.customerId, req.user.customerId)
      )
      .orderBy(desc(telemetry.recordedAt))
      .limit(limit);

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/tracks', async (req: Request, res: Response) => {
  // Up to 7 days of trail. A week of dense pings is far more than a map can
  // draw, so long windows are evenly sampled below rather than truncated.
  const minutes = Math.min(Number(req.query.minutes) || 1440, 10080);
  const limit = Math.min(Number(req.query.limit) || 2000, 5000);
  const customerId = req.user.customerId;

  // Shared column list to avoid repetition across three fallback queries
  const trackColumns = sql`
    t.vehicle_id, t.imei, v.license_plate, v.make, v.model, v.driver_name,
    t.latitude, t.longitude, t.speed_kph, t.fuel_level_liters,
    t.ignition_on, t.recorded_at
  `;
  const validGps = sql`
    t.latitude IS NOT NULL AND t.longitude IS NOT NULL
    AND (t.latitude::numeric != 0 OR t.longitude::numeric != 0)
  `;

  try {
    const key = cacheKey(customerId, 'tracks', String(minutes));
    const cached = await withCache(key, 15, async () => {
      // Tier 1 — live window (user-selected trail duration).
      // Sampled every Nth point per vehicle so a week-long trail keeps its
      // full shape end-to-end. A plain LIMIT would have returned only the
      // oldest points and silently cut off everything recent.
      const recent = await db.execute(sql`
        WITH numbered AS (
          SELECT ${trackColumns},
            ROW_NUMBER() OVER (PARTITION BY t.vehicle_id ORDER BY t.recorded_at ASC) AS rn,
            COUNT(*) OVER (PARTITION BY t.vehicle_id) AS total
          FROM telemetry t
          JOIN vehicles v ON v.id = t.vehicle_id
          WHERE t.customer_id = ${customerId}
            AND t.recorded_at > NOW() - (${minutes} || ' minutes')::INTERVAL
            AND ${validGps}
        )
        SELECT vehicle_id, imei, license_plate, make, model, driver_name,
               latitude, longitude, speed_kph, fuel_level_liters, ignition_on, recorded_at
        FROM numbered
        WHERE rn % GREATEST(1, CEIL(total::numeric / ${limit})) = 0
           OR rn = total
           OR rn = 1
        ORDER BY vehicle_id ASC, recorded_at ASC
      `);

      let rows = recent.rows;
      let source = 'live';

      // Tier 2 — historical trail (last 30 days) when live window is empty
      if (rows.length === 0) {
        const historical = await db.execute(sql`
          WITH ranked AS (
            SELECT ${trackColumns},
              ROW_NUMBER() OVER (PARTITION BY t.vehicle_id ORDER BY t.recorded_at DESC) AS rn
            FROM telemetry t
            JOIN vehicles v ON v.id = t.vehicle_id
            WHERE t.customer_id = ${customerId}
              AND t.recorded_at > NOW() - INTERVAL '30 days'
              AND ${validGps}
          )
          SELECT vehicle_id, imei, license_plate, make, model, driver_name,
                 latitude, longitude, speed_kph, fuel_level_liters, ignition_on, recorded_at
          FROM ranked WHERE rn <= ${limit}
          ORDER BY vehicle_id ASC, recorded_at ASC
        `);
        rows = historical.rows;
        source = rows.length > 0 ? 'historical' : source;
      }

      // Tier 3 — last known position (no time limit) — ensures the car is always on the map
      // even after extended offline periods. Returns one point per vehicle; no trail line
      // renders (path.length < 2) but the car marker always appears at its last position.
      if (rows.length === 0) {
        const lastKnown = await db.execute(sql`
          WITH ranked AS (
            SELECT ${trackColumns},
              ROW_NUMBER() OVER (PARTITION BY t.vehicle_id ORDER BY t.recorded_at DESC) AS rn
            FROM telemetry t
            JOIN vehicles v ON v.id = t.vehicle_id
            WHERE t.customer_id = ${customerId}
              AND ${validGps}
          )
          SELECT vehicle_id, imei, license_plate, make, model, driver_name,
                 latitude, longitude, speed_kph, fuel_level_liters, ignition_on, recorded_at
          FROM ranked WHERE rn = 1
          ORDER BY vehicle_id ASC
        `);
        rows = lastKnown.rows;
        source = rows.length > 0 ? 'last_known' : source;
      }

      return { rows, source };
    }); // end withCache

    res.setHeader('X-Track-Source', cached.source);
    res.json(cached.rows);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Server-side trip segmentation — no point cap, simplified paths.
// A trip ends after 30+ minutes of ignition-off / tracker silence.
router.get('/trips', async (req: Request, res: Response) => {
  const minutes = Math.min(Number(req.query.minutes) || 1440, 43200); // up to 30 days
  const customerId = req.user.customerId;
  // Money shown against a trip is only as real as the price behind it, so the
  // rate comes from this fleet's most recent logged receipt. No receipt means
  // no price, and the response carries null rather than an assumed rate.
  // Deliberately NOT awaited here: this ran on every request, ahead of the
  // cache, so a cache hit still cost a database round trip. Resolved inside the
  // cached block instead, where it is shared by every caller in the TTL window.
  let pricePerLiter: number | null = null;

  // Explicit calendar range wins over the rolling `minutes` window when both
  // ends parse. Used by the date-range picker; `minutes` stays the default so
  // existing callers are unaffected.
  const parseDate = (v: unknown): Date | null => {
    if (typeof v !== 'string' || !v.trim()) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const fromDate = parseDate(req.query.from);
  const toDate = parseDate(req.query.to);
  const useRange = Boolean(fromDate && toDate && fromDate! < toDate!);

  // When the caller picked a window deliberately, an empty result is the
  // truthful answer — silently widening to 30 days makes the range control
  // look broken. Callers opt back into the old behaviour with fallback=1.
  const allowFallback = req.query.fallback === '1' || req.query.fallback === 'true';

  try {
    const key = cacheKey(
      customerId,
      'trips',
      useRange
        ? `${fromDate!.toISOString()}..${toDate!.toISOString()}:${allowFallback ? 'fb' : 'strict'}`
        : `${minutes}:${allowFallback ? 'fb' : 'strict'}`
    );
    const cached = await withCache(key, 60, async () => {
      const price = await latestReceiptPrice(customerId);
      pricePerLiter = price?.ngnPerLiter ?? null;
      const tripColumns = sql`
        t.vehicle_id,
        v.license_plate,
        v.model,
        COALESCE(dr.full_name, v.driver_name) AS driver_name,
        t.latitude::double precision AS lat,
        t.longitude::double precision AS lng,
        t.speed_kph,
        t.ignition_on,
        t.recorded_at
      `;
      const tripValidGps = sql`
        t.latitude IS NOT NULL AND t.longitude IS NOT NULL
        AND (t.latitude::numeric != 0 OR t.longitude::numeric != 0)
      `;

      type TripRow = Record<string, unknown>;

      // Groups raw points by vehicle, segments them into trips, and prices
      // each trip using the same methodology as the fuel estimate (driving +
      // engine-idle burn). Shared by both the live-window and historical query.
      const buildVehicleTrips = (rows: TripRow[]) => {
        const byVehicle = new Map<
          string,
          {
            license_plate: string;
            model: string | null;
            driver_name: string | null;
            points: TelemetryTripPoint[];
          }
        >();
        for (const row of rows) {
          const vid = String(row.vehicle_id);
          if (!byVehicle.has(vid)) {
            byVehicle.set(vid, {
              license_plate: String(row.license_plate),
              model: row.model != null ? String(row.model) : null,
              driver_name: row.driver_name != null ? String(row.driver_name) : null,
              points: [],
            });
          }
          byVehicle.get(vid)!.points.push({
            lat: Number(row.lat),
            lng: Number(row.lng),
            speedKph: row.speed_kph != null ? Number(row.speed_kph) : null,
            ignitionOn: row.ignition_on == null ? null : Boolean(row.ignition_on),
            recordedAt: new Date(row.recorded_at as string),
          });
        }

        const nowMs = Date.now();
        return Array.from(byVehicle.entries()).map(([vehicleId, v]) => {
          const efficiencyKmL = baselineEfficiencyKmL(v.model ?? '');
          const trips = segmentTrips(v.points, nowMs).map((trip) => {
            // Economy follows a U-curve, so the same distance burns more in
            // stop-start traffic than at a steady cruise. Applied only to the
            // driving portion — idle burn is time-based and unaffected by it.
            const multiplier = speedBucketMultiplier(trip.avg_speed_kph);
            const fuel = round1(
              (trip.distance_km / efficiencyKmL) * multiplier +
                (trip.idle_minutes / 60) * IDLE_BURN_LITERS_PER_HOUR
            );
            return {
              ...trip,
              estimated_fuel_liters: fuel,
              // null until a real receipt establishes a price — see
              // lib/fuel-price.ts. Litres are measured; money is not, and an
              // assumed rate must not be shown as though it were.
              estimated_cost_ngn:
                pricePerLiter != null ? Math.round(fuel * pricePerLiter) : null,
              speed_bucket: speedBucketLabel(trip.avg_speed_kph),
              speed_bucket_multiplier: multiplier,
            };
          });
          return {
            vehicle_id: vehicleId,
            license_plate: v.license_plate,
            model: v.model,
            driver_name: v.driver_name,
            trips,
            total_distance_km:
              Math.round(trips.reduce((s, t) => s + t.distance_km, 0) * 10) / 10,
            total_fuel_liters: round1(trips.reduce((s, t) => s + t.estimated_fuel_liters, 0)),
            total_cost_ngn:
              pricePerLiter != null
                ? trips.reduce((s, t) => s + (t.estimated_cost_ngn ?? 0), 0)
                : null,
          };
        });
      };

      const window = useRange
        ? sql`t.recorded_at >= ${fromDate!.toISOString()}::timestamptz
              AND t.recorded_at <= ${toDate!.toISOString()}::timestamptz`
        : sql`t.recorded_at > NOW() - (${minutes} || ' minutes')::INTERVAL`;

      const liveResult = await db.execute(sql`
        SELECT ${tripColumns}
        FROM telemetry t
        JOIN vehicles v ON v.id = t.vehicle_id
        LEFT JOIN drivers dr ON dr.id = v.driver_id AND dr.customer_id = v.customer_id
        WHERE t.customer_id = ${customerId}
          AND ${window}
          AND ${tripValidGps}
        ORDER BY t.vehicle_id ASC, t.recorded_at ASC
      `);

      let source = 'live';
      let vehicleTrips = buildVehicleTrips(liveResult.rows as TripRow[]);
      const liveTripCount = vehicleTrips.reduce((s, v) => s + v.trips.length, 0);

      // The live window can be non-empty (parked heartbeat pings) yet contain
      // zero actual trips. Only when the caller opted in (fallback=1) do we
      // substitute the most recent real journeys — up to 30 days back — rather
      // than showing an empty trail next to "0 trips". Doing this
      // unconditionally contradicted the selected range control.
      if (liveTripCount === 0 && allowFallback) {
        const historical = await db.execute(sql`
          WITH ranked AS (
            SELECT ${tripColumns},
              ROW_NUMBER() OVER (PARTITION BY t.vehicle_id ORDER BY t.recorded_at DESC) AS rn
            FROM telemetry t
            JOIN vehicles v ON v.id = t.vehicle_id
            LEFT JOIN drivers dr ON dr.id = v.driver_id AND dr.customer_id = v.customer_id
            WHERE t.customer_id = ${customerId}
              AND t.recorded_at > NOW() - INTERVAL '30 days'
              AND ${tripValidGps}
          )
          SELECT vehicle_id, license_plate, model, driver_name,
                 lat, lng, speed_kph, ignition_on, recorded_at
          FROM ranked WHERE rn <= 15000
          ORDER BY vehicle_id ASC, recorded_at ASC
        `);
        const historicalTrips = buildVehicleTrips(historical.rows as TripRow[]);
        const historicalTripCount = historicalTrips.reduce((s, v) => s + v.trips.length, 0);
        if (historicalTripCount > 0) {
          vehicleTrips = historicalTrips;
          source = 'historical';
        }
        // else: truly never driven in 30 days — keep the (empty-trip) live result
      }

      // Where the engine sat running.
      //
      // "18m idle" as a bare number tells a manager money was wasted but not
      // where to go and ask about it. The idle detector already writes every
      // stretch with its position, so each one is attached to the trip it
      // happened during and becomes something clickable.
      const idleRows = await db.execute(sql`
        SELECT vehicle_id, event_type, occurred_at, value, latitude, longitude
        FROM device_events
        WHERE customer_id = ${customerId}
          AND event_type IN ('idling_start', 'idling_end')
          AND occurred_at > NOW() - INTERVAL '30 days'
        ORDER BY vehicle_id ASC, occurred_at ASC
      `);

      interface IdleStretch {
        started_at: string;
        ended_at: string | null;
        minutes: number;
        lat: number | null;
        lng: number | null;
        place_label?: string | null;
      }

      const idleByVehicle = new Map<string, IdleStretch[]>();
      const openIdle = new Map<string, Record<string, unknown>>();

      for (const raw of idleRows.rows as Array<Record<string, unknown>>) {
        const vehicleId = String(raw.vehicle_id);
        if (raw.event_type === 'idling_start') {
          openIdle.set(vehicleId, raw);
          continue;
        }
        // An end without its start (server restarted mid-idle) is still worth
        // showing — it carries both the duration and the position.
        const start = openIdle.get(vehicleId) ?? raw;
        openIdle.delete(vehicleId);
        const list = idleByVehicle.get(vehicleId) ?? [];
        list.push({
          started_at: new Date(start.occurred_at as string).toISOString(),
          ended_at: new Date(raw.occurred_at as string).toISOString(),
          minutes: Math.round(Number(raw.value ?? 0) * 10) / 10,
          lat: start.latitude != null ? Number(start.latitude) : null,
          lng: start.longitude != null ? Number(start.longitude) : null,
        });
        idleByVehicle.set(vehicleId, list);
      }

      for (const vehicle of vehicleTrips) {
        const stretches = idleByVehicle.get(vehicle.vehicle_id) ?? [];
        for (const trip of vehicle.trips) {
          const from = new Date(trip.start_at).getTime();
          const to = new Date(trip.end_at).getTime();
          (trip as { idle_events?: IdleStretch[] }).idle_events = stretches.filter((s) => {
            const at = new Date(s.started_at).getTime();
            return at >= from && at <= to;
          });
        }
      }

      // Name the stops a manager has already paid to resolve. Cache-only: a
      // trip list can hold hundreds of points and resolving them live would
      // bill a geocode each, every time this screen is opened. Points nobody
      // has opened yet stay unnamed and read as plain "Stopped".
      const allStops = vehicleTrips.flatMap((v) => v.trips.flatMap((t) => t.stops));
      const allIdle = vehicleTrips.flatMap((v) =>
        v.trips.flatMap((t) => (t as { idle_events?: IdleStretch[] }).idle_events ?? [])
      );
      const names = await cachedPlaceNames([
        ...allStops.map((s) => ({ lat: s.lat, lng: s.lng })),
        ...allIdle.flatMap((s) => (s.lat != null && s.lng != null ? [{ lat: s.lat, lng: s.lng }] : [])),
      ]);
      for (const stop of allStops) {
        (stop as TripStop & { place_label?: string | null }).place_label =
          names.get(placeKeyFor(stop.lat, stop.lng)) ?? null;
      }
      for (const idle of allIdle) {
        idle.place_label =
          idle.lat != null && idle.lng != null
            ? (names.get(placeKeyFor(idle.lat, idle.lng)) ?? null)
            : null;
      }

      return {
        period_minutes: useRange
          ? Math.round((toDate!.getTime() - fromDate!.getTime()) / 60000)
          : minutes,
        from: useRange ? fromDate!.toISOString() : null,
        to: useRange ? toDate!.toISOString() : null,
        source,
        price_per_liter_ngn: pricePerLiter,
        price_as_of: price?.asOf ?? null,
        vehicles: vehicleTrips,
      };
    });

    res.json(cached);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Resolves one stop's address/venue. Called when the manager opens a stop —
// not for every stop in the list, so we only pay Google for places actually
// inspected. Repeat lookups are served from place_cache.
router.get('/stop-place', async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    res.status(400).json({ error: 'valid lat and lng are required' });
    return;
  }

  try {
    res.json(await lookupPlace(lat, lng));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Today's Google Maps spend, so the cap is observable rather than silent.
// Measured consumption over time for one vehicle — the trend a manager reads
// to spot a rate drifting upward (mechanical, driving habits, or fraud).
router.get('/consumption-trend/:vehicleId', async (req: Request, res: Response) => {
  const vehicleId = String(req.params.vehicleId);
  try {
    const [owned] = await db
      .select({ id: vehicles.id, rate: vehicles.consumptionRateL100km, source: vehicles.rateSource })
      .from(vehicles)
      .where(and(eq(vehicles.id, vehicleId), eq(vehicles.customerId, req.user.customerId)))
      .limit(1);

    if (!owned) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }

    const history = await consumptionTrend(vehicleId);
    res.json({
      vehicle_id: vehicleId,
      current_rate_l_per_100km: owned.rate != null ? Number(owned.rate) : null,
      rate_source: owned.source,
      calibrated_from: history.filter((h) => h.real_consumption_l_per_100km != null).length,
      history,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Latest purchase per vehicle, reduced to the numbers a plain-language card is
// built from. Variance is measured against the rate actually in force, so this
// card and the efficiency flag are reading the same figure and cannot disagree.
router.get('/purchase-reconciliation', async (req: Request, res: Response) => {
  try {
    const result = await db.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (fp.vehicle_id)
          fp.id, fp.vehicle_id, fp.purchased_at,
          COALESCE(fp.liters_actual, fp.liters_declared)::double precision AS liters,
          fp.odometer_delta_km,
          fp.gps_distance_km::double precision AS gps_distance_km,
          fp.real_consumption_l_per_100km::double precision AS measured_rate,
          fp.distance_mismatch, fp.implausible_odometer, fp.unusual_purchase,
          fp.flag_reason
        FROM fuel_purchases fp
        WHERE fp.customer_id = ${req.user.customerId}
        ORDER BY fp.vehicle_id, fp.purchased_at DESC
      )
      SELECT l.*, v.license_plate,
             COALESCE(dr.full_name, v.driver_name) AS driver_name,
             v.consumption_rate_l_per_100km::double precision AS rate_in_force,
             v.rate_source
      FROM latest l
      JOIN vehicles v ON v.id = l.vehicle_id
      LEFT JOIN drivers dr ON dr.id = v.driver_id
      ORDER BY l.purchased_at DESC
    `);

    const cards = (result.rows as Array<Record<string, unknown>>).map((r) => {
      const liters = Number(r.liters ?? 0);
      const rate = Number(r.rate_in_force ?? 0);
      // Odometer is the better distance when we have it; GPS is the fallback.
      const distance =
        r.odometer_delta_km != null ? Number(r.odometer_delta_km) : Number(r.gps_distance_km ?? 0);
      const expected = distance > 0 && rate > 0 ? round1((distance * rate) / 100) : null;
      const variance =
        expected != null && expected > 0
          ? Math.round(((liters - expected) / expected) * 1000) / 10
          : null;

      // Attention level mirrors the flags the calibration engine already set,
      // rather than inventing a second opinion on the same purchase.
      const attention =
        r.unusual_purchase || r.implausible_odometer
          ? 'high'
          : r.distance_mismatch || (variance != null && Math.abs(variance) >= 20)
            ? 'medium'
            : 'neutral';

      return {
        vehicle_id: r.vehicle_id,
        license_plate: r.license_plate,
        driver_name: r.driver_name,
        purchased_at: r.purchased_at,
        liters_purchased: round1(liters),
        distance_since_purchase_km: distance > 0 ? round1(distance) : null,
        distance_source: r.odometer_delta_km != null ? 'odometer' : 'gps',
        rate_l_per_100km: rate || null,
        rate_source: r.rate_source,
        expected_liters: expected,
        variance_percent: variance != null ? Math.abs(variance) : null,
        variance_direction: variance == null ? null : variance >= 0 ? 'over' : 'under',
        attention,
        flags: {
          distance_mismatch: !!r.distance_mismatch,
          implausible_odometer: !!r.implausible_odometer,
          unusual_purchase: !!r.unusual_purchase,
        },
        flag_reason: r.flag_reason,
      };
    });

    res.json({ cards });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/google-usage', async (_req: Request, res: Response) => {
  res.json(googleUsageSnapshot());
});

router.get('/fleet-efficiency', async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.days) || 7, 90);

  try {
    const customerId = req.user.customerId;

    // The manager's declared price is the benchmark. It only sets the fallback
    // for periods before any price was declared — the SQL prices each litre by
    // the period it was burned in.
    const benchmark = await currentBenchmarkPrice(customerId);
    // With no benchmark declared, the last price a driver actually paid beats
    // a compiled-in constant — pump prices move, and the receipt is evidence.
    const receipt = benchmark ? null : await latestReceiptPrice(customerId);
    const pricePerLiter =
      benchmark?.ngnPerLiter ??
      receipt?.ngnPerLiter ??
      Number(process.env.FUEL_PRICE_NGN_LITER || DEFAULT_FUEL_PRICE_NGN_LITER);

    const [result, alertRows, siphonRows, harshRows] = await Promise.all([
      db.execute(fleetEfficiencyAggSql({ customerId, days, pricePerLiter })),
      db.execute(sql`
        SELECT vehicle_id, alert_type, estimated_loss_ngn
        FROM alerts
        WHERE customer_id = ${customerId}
          AND is_resolved = false
      `),
      db.execute(sql`
        SELECT
          vehicle_id,
          COALESCE(SUM(estimated_loss_ngn), 0)::int AS siphon_loss_ngn
        FROM siphon_events
        WHERE customer_id = ${customerId}
          AND occurred_at > NOW() - (${days} || ' days')::interval
          AND status NOT IN ('resolved', 'false_alarm')
        GROUP BY vehicle_id
      `),
      // Aggressive driving burns fuel the baseline does not allow for. Counted,
      // not costed — there is no honest litres-per-harsh-brake conversion.
      db.execute(sql`
        SELECT vehicle_id, COUNT(*)::int AS harsh_events
        FROM device_events
        WHERE customer_id = ${customerId}
          AND occurred_at > NOW() - (${days} || ' days')::interval
          AND event_type IN (
            'harsh_braking', 'harsh_acceleration', 'harsh_cornering', 'overspeeding'
          )
        GROUP BY vehicle_id
      `),
    ]);

    const harshByVehicle = new Map<string, number>(
      harshRows.rows.map((row) => {
        const r = row as Record<string, unknown>;
        return [r.vehicle_id as string, Number(r.harsh_events) || 0];
      })
    );

    const alertTheftByVehicle = new Map<string, number>();
    for (const alert of alertRows.rows) {
      const a = alert as Record<string, unknown>;
      if (!a.vehicle_id) continue;
      const prev = alertTheftByVehicle.get(a.vehicle_id as string) || 0;
      const loss =
        a.alert_type === 'fuel_theft' ? Number(a.estimated_loss_ngn) || 0 : 0;
      alertTheftByVehicle.set(a.vehicle_id as string, prev + loss);
    }

    const siphonLossByVehicle = new Map<string, number>(
      siphonRows.rows.map((row) => {
        const r = row as Record<string, unknown>;
        return [r.vehicle_id as string, Number(r.siphon_loss_ngn) || 0];
      })
    );

    const rows = result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      const distanceKm = Number(r.distance_km) || 0;
      const fuelUsed = Number(r.fuel_used_liters) || 0;
      const expectedKmL = baselineEfficiencyKmL(r.model as string | null | undefined);
      const expectedL100km = baselineEfficiencyL100km(r.model as string | null | undefined);

      const tankDistance = Number(r.tank_distance_km) || Number(r.distance_since_purchase_km) || 0;
      const tankFuel = Number(r.tank_fuel_used_liters) || Number(r.fuel_since_purchase_liters) || 0;
      const tankEfficiencyKmL =
        tankDistance > 0 && tankFuel >= 0.5 ? tankDistance / tankFuel : null;
      const tankEfficiencyL100km = computeL100km(tankFuel, tankDistance);

      const periodEfficiencyKmL =
        distanceKm > 0 && fuelUsed >= 0.5 ? distanceKm / fuelUsed : null;
      const periodEfficiencyL100km = computeL100km(fuelUsed, distanceKm);

      const variancePercent =
        periodEfficiencyL100km != null && expectedL100km > 0
          ? efficiencyDeviationPercentL100km(periodEfficiencyL100km, expectedL100km)
          : null;

      const tankVariancePercent =
        tankEfficiencyL100km != null && expectedL100km > 0
          ? efficiencyDeviationPercentL100km(tankEfficiencyL100km, expectedL100km)
          : null;

      // Prices come from the SQL already applied per period, so a fleet that
      // changed its declared price mid-window is costed at both prices rather
      // than having today's rate projected backwards.
      const periodPriceNgn = Number(r.avg_price_ngn) || pricePerLiter;
      const expectedFuelLiters = expectedKmL > 0 ? distanceKm / expectedKmL : 0;
      const expectedCostNgn = Math.round(expectedFuelLiters * periodPriceNgn);

      const purchaseCostNgn = Math.round(Number(r.purchase_cost_ngn) || 0);
      const telemetryCostNgn = Math.round(
        Number(r.telemetry_cost_ngn) || fuelUsed * periodPriceNgn
      );
      const receiptFraudLossNgn = Math.round(Number(r.receipt_fraud_loss_ngn) || 0);
      const alertTheftLossNgn = alertTheftByVehicle.get(r.vehicle_id as string) || 0;
      const siphonLossNgn = siphonLossByVehicle.get(r.vehicle_id as string) || 0;
      const theftLossNgn = receiptFraudLossNgn + alertTheftLossNgn + siphonLossNgn;

      const actualCostNgn =
        purchaseCostNgn > 0 ? purchaseCostNgn : telemetryCostNgn;

      const efficiencyLossNgn = Math.max(0, telemetryCostNgn - expectedCostNgn);
      const totalLossNgn = theftLossNgn + efficiencyLossNgn;
      const savingsNgn = expectedCostNgn - telemetryCostNgn;

      // A loss figure with no cause behind it is an accusation. Split the extra
      // fuel into the part the tracker can explain (engine running while
      // stationary, measured) and the part it cannot, and carry the harsh-event
      // count as context for the remainder.
      const idleHours = (Number(r.idle_seconds) || 0) / 3600;
      const idleLiters = Math.min(idleHours * IDLE_BURN_LITERS_PER_HOUR, fuelUsed);
      const excessLiters = Math.max(0, fuelUsed - expectedFuelLiters);
      const idleExcessLiters = Math.min(idleLiters, excessLiters);
      const unexplainedLiters = Math.max(0, excessLiters - idleExcessLiters);
      const harshEvents = harshByVehicle.get(r.vehicle_id as string) || 0;

      const co2EmissionsKg = Math.round(fuelUsed * CO2_KG_PER_LITER);

      let status = 'verified';
      if (theftLossNgn > 0) status = 'theft_alert';
      else if (variancePercent != null && variancePercent >= EFFICIENCY_VARIANCE_THRESHOLD_PERCENT) {
        status = 'underperforming';
      }

      return {
        vehicle_id: r.vehicle_id,
        license_plate: r.license_plate,
        driver_name: r.driver_name,
        model: r.model,
        tank_capacity_liters: r.tank_capacity_liters,
        distance_km: Math.round(distanceKm),
        fuel_used_liters: round1(fuelUsed),
        efficiency_km_l: periodEfficiencyKmL != null ? round2(periodEfficiencyKmL) : null,
        efficiency_l_100km: periodEfficiencyL100km,
        expected_efficiency_km_l: expectedKmL,
        expected_efficiency_l_100km: expectedL100km,
        variance_percent: variancePercent != null ? round2(variancePercent) : null,
        tank_distance_km: Math.round(tankDistance),
        tank_fuel_used_liters: round1(tankFuel),
        tank_efficiency_km_l: tankEfficiencyKmL != null ? round2(tankEfficiencyKmL) : null,
        tank_efficiency_l_100km: tankEfficiencyL100km,
        tank_variance_percent: tankVariancePercent != null ? round2(tankVariancePercent) : null,
        expected_fuel_liters: round1(expectedFuelLiters),
        expected_cost_ngn: expectedCostNgn,
        idle_hours: round1(idleHours),
        idle_fuel_liters: round1(idleLiters),
        idle_cost_ngn: Math.round(idleLiters * periodPriceNgn),
        harsh_event_count: harshEvents,
        loss_reason: {
          excess_liters: round1(excessLiters),
          idle_liters: round1(idleExcessLiters),
          idle_cost_ngn: Math.round(idleExcessLiters * periodPriceNgn),
          idle_hours: round1(idleHours),
          unexplained_liters: round1(unexplainedLiters),
          unexplained_cost_ngn: Math.round(unexplainedLiters * periodPriceNgn),
          harsh_event_count: harshEvents,
        },
        actual_cost_ngn: actualCostNgn,
        telemetry_cost_ngn: telemetryCostNgn,
        fuel_cost_ngn: actualCostNgn,
        savings_ngn: Math.round(savingsNgn),
        total_loss_ngn: Math.round(totalLossNgn),
        efficiency_loss_ngn: Math.round(efficiencyLossNgn),
        theft_loss_ngn: theftLossNgn,
        receipt_fraud_loss_ngn: receiptFraudLossNgn,
        alert_theft_loss_ngn: alertTheftLossNgn,
        siphon_loss_ngn: siphonLossNgn,
        co2_emissions_kg: co2EmissionsKg,
        status,
        period_days: days,
        price_per_liter_ngn: pricePerLiter,
        last_purchase_at: r.last_purchase_at ?? null,
        last_fuel_added_liters:
          r.last_fuel_added_liters != null ? round1(Number(r.last_fuel_added_liters)) : null,
        last_receipt_liters:
          r.last_receipt_liters != null ? round1(Number(r.last_receipt_liters)) : null,
        last_purchase_merchant: r.last_purchase_merchant ?? null,
        distance_since_purchase_km: Math.round(Number(r.distance_since_purchase_km) || 0),
        fuel_since_purchase_liters: round1(Number(r.fuel_since_purchase_liters) || 0),
      };
    });

    const summary = {
      total_distance_km: rows.reduce((s, r) => s + r.distance_km, 0),
      total_fuel_used_liters: round1(rows.reduce((s, r) => s + r.fuel_used_liters, 0)),
      total_expected_fuel_liters: round1(rows.reduce((s, r) => s + r.expected_fuel_liters, 0)),
      total_expected_cost_ngn: rows.reduce((s, r) => s + r.expected_cost_ngn, 0),
      total_idle_hours: round1(rows.reduce((s, r) => s + r.idle_hours, 0)),
      total_idle_fuel_liters: round1(rows.reduce((s, r) => s + r.idle_fuel_liters, 0)),
      total_harsh_events: rows.reduce((s, r) => s + r.harsh_event_count, 0),
      loss_reason: {
        idle_liters: round1(rows.reduce((s, r) => s + r.loss_reason.idle_liters, 0)),
        idle_cost_ngn: rows.reduce((s, r) => s + r.loss_reason.idle_cost_ngn, 0),
        idle_hours: round1(rows.reduce((s, r) => s + r.loss_reason.idle_hours, 0)),
        unexplained_liters: round1(
          rows.reduce((s, r) => s + r.loss_reason.unexplained_liters, 0)
        ),
        unexplained_cost_ngn: rows.reduce(
          (s, r) => s + r.loss_reason.unexplained_cost_ngn,
          0
        ),
        harsh_event_count: rows.reduce((s, r) => s + r.harsh_event_count, 0),
      },
      total_actual_cost_ngn: rows.reduce((s, r) => s + r.actual_cost_ngn, 0),
      total_telemetry_cost_ngn: rows.reduce((s, r) => s + r.telemetry_cost_ngn, 0),
      total_loss_ngn: rows.reduce((s, r) => s + r.total_loss_ngn, 0),
      total_savings_ngn: rows.reduce((s, r) => s + r.savings_ngn, 0),
      total_theft_loss_ngn: rows.reduce((s, r) => s + r.theft_loss_ngn, 0),
      total_efficiency_loss_ngn: rows.reduce((s, r) => s + r.efficiency_loss_ngn, 0),
      recoverable_ngn: Math.round(rows.reduce((s, r) => s + r.total_loss_ngn, 0) * 0.9),
      price_per_liter_ngn: pricePerLiter,
      period_days: days,
    };

    res.json({ summary, vehicles: rows });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/daily-activity', async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.days) || 30, 90);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 50);

  try {
    const customerId = req.user.customerId;
    const result = await db.execute(dailyActivitySql({ customerId, days }));

    const allRows = result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      const distanceKm = Number(r.distance_km) || 0;
      const fuelUsed = Number(r.fuel_used_liters) || 0;
      const idleHours = Number(r.idle_hours) || 0;
      const tripCount = Number(r.trip_count) || 0;
      const expectedKmL = baselineEfficiencyKmL(r.model as string | null | undefined);
      const expectedL100km = baselineEfficiencyL100km(r.model as string | null | undefined);
      const efficiencyL100km = computeL100km(fuelUsed, distanceKm);
      const band = dailyDistanceThreshold(r.model as string | null | undefined);
      const deviationPercent = efficiencyDeviationPercentL100km(
        efficiencyL100km,
        expectedL100km
      );
      const activityDate =
        r.activity_date instanceof Date
          ? r.activity_date.toISOString().slice(0, 10)
          : String(r.activity_date).slice(0, 10);

      const classification = classifyDailyRow({
        model: r.model as string | undefined,
        distanceKm,
        fuelUsed,
        efficiencyL100km,
        expectedEfficiencyL100km: expectedL100km,
        deviationPercent,
        idleHours,
        tripCount,
      });

      return {
        vehicle_id: r.vehicle_id,
        license_plate: r.license_plate,
        driver_name: r.driver_name,
        model: r.model,
        activity_date: activityDate,
        activity_date_display: formatActivityDateDisplay(activityDate),
        distance_km: Math.round(distanceKm),
        fuel_used_liters: round1(fuelUsed),
        efficiency_l_100km:
          classification.display_efficiency_l_100km != null
            ? classification.display_efficiency_l_100km
            : null,
        raw_efficiency_l_100km: efficiencyL100km,
        expected_efficiency_l_100km: expectedL100km,
        expected_efficiency_km_l: expectedKmL,
        efficiency_deviation_percent: deviationPercent,
        status: classification.status,
        status_label: classification.status_label,
        status_severity: classification.status_severity,
        data_anomaly: classification.data_anomaly,
        insight: classification.insight,
        expected_distance_min_km: band.min,
        expected_distance_max_km: band.max,
        expected_distance_km: band.expected,
        idle_hours: round1(idleHours),
        trip_count: tripCount,
        _flags: buildDailyFlags({
          vehicleId: r.vehicle_id as string,
          licensePlate: r.license_plate as string,
          driverName: r.driver_name as string | null,
          activityDate,
          model: r.model as string | null,
          distanceKm,
          fuelUsed,
          idleHours,
          efficiencyL100km,
          expectedEfficiencyL100km: expectedL100km,
          deviationPercent,
        }),
      };
    });

    const activeFlags = allRows.flatMap((row) => row._flags);
    const total = allRows.length;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const offset = (page - 1) * limit;
    const rows = allRows.slice(offset, offset + limit).map(({ _flags: _f, ...row }) => row);

    res.json({
      period_days: days,
      page,
      limit,
      total,
      total_pages: totalPages,
      efficiency_tiers: EFFICIENCY_TIERS.map((t) => ({
        status: t.status,
        label: t.label,
        severity: t.severity,
        max_deviation_percent: t.maxDeviation,
      })),
      efficiency_variance_threshold_percent: EFFICIENCY_VARIANCE_THRESHOLD_PERCENT,
      daily_distance_by_model: DAILY_DISTANCE_BY_MODEL,
      rows,
      active_flags: activeFlags,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/daily-activity/replay', async (req: Request, res: Response) => {
  const customerId = req.user.customerId;
  const vehicleId = String(req.query.vehicle_id || '').trim();
  const date = String(req.query.date || '').trim();
  const flagType = String(req.query.flag_type || 'efficiency').trim();
  const focusAt = String(req.query.at || '').trim();

  if (!vehicleId || !date) {
    res.status(400).json({ error: 'vehicle_id and date are required' });
    return;
  }

  try {
    const replay = await buildDailyActivityReplay({
      customerId,
      vehicleId,
      activityDate: date,
      flagType,
      focusAt: focusAt || undefined,
    });
    if (!replay) {
      res.status(404).json({ error: 'No replay data for this day' });
      return;
    }
    res.json(replay);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/fuel-purchases', async (req: Request, res: Response) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 10, 100);
  const offset = (page - 1) * limit;
  const customerId = req.user.customerId;
  const includeSummary = req.query.include_summary === 'true';

  try {
    const countResult = await db.execute(sql`
      SELECT COUNT(*)::int AS total FROM fuel_purchases WHERE customer_id = ${customerId}
    `);
    const total = (countResult.rows[0] as Record<string, unknown>)?.total ?? 0;

    if (total === 0) {
      res.json({
        source: 'empty',
        page,
        limit,
        total: 0,
        total_pages: 0,
        purchases: [],
        note: 'Run npm run seed-fuel-purchases after seed-telemetry',
        ...(includeSummary
          ? {
              summary: {
                daily_totals: [],
                grand_total: {
                  receipt_count: 0,
                  total_cost_ngn: 0,
                  total_receipt_liters: 0,
                  total_obd_liters: 0,
                },
              },
            }
          : {}),
      });
      return;
    }

    const rows = await db.execute(sql`
      SELECT
        fp.id,
        fp.vehicle_id,
        v.license_plate,
        COALESCE(submit_dr.full_name, dr.full_name, v.driver_name) AS driver_name,
        fp.purchased_at AS timestamp,
        fp.obd_refuel_detected_at,
        fp.ignition_on_at,
        fp.merchant,
        fp.receipt_reference,
        fp.liters_declared,
        fp.liters_actual,
        fp.cost_per_liter_ngn,
        fp.total_amount_ngn,
        fp.odometer_km,
        fp.status,
        fp.source,
        fr.verification,
        fr.merchant_address
      FROM fuel_purchases fp
      JOIN vehicles v ON v.id = fp.vehicle_id
      LEFT JOIN drivers dr ON dr.id = v.driver_id
      LEFT JOIN fuel_receipts fr ON fp.source = 'driver_upload'
        AND fp.receipt_reference = 'DRV-' || upper(substr(fr.id::text, 1, 8))
      LEFT JOIN drivers submit_dr ON submit_dr.id = fr.driver_id
      WHERE fp.customer_id = ${customerId}
      ORDER BY fp.purchased_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const purchases = rows.rows.map((row) => {
      const r = row as Record<string, unknown>;
      const declared = Number(r.liters_declared);
      const actualRaw = r.liters_actual != null ? Number(r.liters_actual) : null;
      const actual =
        r.status === 'pending_receipt' && (actualRaw == null || actualRaw === 0)
          ? 0
          : actualRaw;
      const diff =
        actual != null ? Math.max(0, Math.round((declared - actual) * 10) / 10) : declared;
      const costPerLiter = Number(r.cost_per_liter_ngn) || DEFAULT_FUEL_PRICE_NGN_LITER;

      return {
        id: r.id,
        vehicle_id: r.vehicle_id,
        license_plate: r.license_plate,
        driver_name: r.driver_name,
        timestamp: r.timestamp,
        purchased_at: r.timestamp,
        obd_refuel_detected_at: r.obd_refuel_detected_at,
        ignition_on_at: r.ignition_on_at,
        timeline: buildReceiptTimeline({
          purchasedAt: r.timestamp as Date,
          obdRefuelDetectedAt: r.obd_refuel_detected_at as Date | null,
          ignitionOnAt: r.ignition_on_at as Date | null,
        }),
        event_assessment: assessReceiptEvent({
          purchasedAt: r.timestamp as Date,
          obdRefuelDetectedAt: r.obd_refuel_detected_at as Date | null,
          ignitionOnAt: r.ignition_on_at as Date | null,
          litersDeclared: declared,
          litersActual: actual,
          status: r.status as string,
          merchant: r.merchant as string | null,
          licensePlate: r.license_plate as string,
          costPerLiter,
        }),
        merchant: r.merchant,
        merchant_address: r.merchant_address ?? null,
        receipt_reference: r.receipt_reference,
        liters_declared: declared,
        liters_actual: actual,
        difference_liters: diff,
        cost_per_liter_ngn: costPerLiter,
        // The slip's own total when the driver logged one — litres × price is
        // a reconstruction and lands a naira or two off what was paid.
        total_cost_ngn:
          r.total_amount_ngn != null
            ? Number(r.total_amount_ngn)
            : Math.round(declared * costPerLiter),
        odometer_km: r.odometer_km,
        status: r.status,
        source: r.source,
        // The checks behind the status: where the vehicle was, whether the
        // volume fitted, how buying compares to burning.
        verification: r.verification ?? null,
        actual_from: 'tracker_evidence',
      };
    });

    let summary: unknown;
    if (includeSummary) {
      const dailyResult = await db.execute(sql`
        SELECT
          DATE(fp.purchased_at AT TIME ZONE 'Africa/Lagos') AS activity_date,
          COALESCE(submit_dr.full_name, dr.full_name, v.driver_name, 'Unassigned') AS driver_name,
          SUM(COALESCE(fp.total_amount_ngn, fp.liters_declared::numeric * COALESCE(fp.cost_per_liter_ngn, ${DEFAULT_FUEL_PRICE_NGN_LITER})))::int AS total_cost_ngn,
          SUM(fp.liters_declared::numeric)::numeric AS total_receipt_liters,
          SUM(COALESCE(fp.liters_actual::numeric, 0))::numeric AS total_obd_liters,
          COUNT(*)::int AS receipt_count
        FROM fuel_purchases fp
        JOIN vehicles v ON v.id = fp.vehicle_id
        LEFT JOIN drivers dr ON dr.id = v.driver_id
        LEFT JOIN fuel_receipts fr ON fp.source = 'driver_upload'
          AND fp.receipt_reference = 'DRV-' || upper(substr(fr.id::text, 1, 8))
        LEFT JOIN drivers submit_dr ON submit_dr.id = fr.driver_id
        WHERE fp.customer_id = ${customerId}
        GROUP BY 1, 2
        ORDER BY 1 DESC, 2 ASC
      `);

      const grandResult = await db.execute(sql`
        SELECT
          SUM(COALESCE(fp.total_amount_ngn, fp.liters_declared::numeric * COALESCE(fp.cost_per_liter_ngn, ${DEFAULT_FUEL_PRICE_NGN_LITER})))::int AS total_cost_ngn,
          SUM(fp.liters_declared::numeric)::numeric AS total_receipt_liters,
          SUM(COALESCE(fp.liters_actual::numeric, 0))::numeric AS total_obd_liters,
          COUNT(*)::int AS receipt_count
        FROM fuel_purchases fp
        WHERE fp.customer_id = ${customerId}
      `);

      const grand = (grandResult.rows[0] ?? {}) as Record<string, unknown>;
      summary = {
        daily_totals: dailyResult.rows.map((row) => {
          const r = row as Record<string, unknown>;
          return {
            activity_date: r.activity_date,
            driver_name: r.driver_name,
            receipt_count: Number(r.receipt_count),
            total_cost_ngn: Number(r.total_cost_ngn),
            total_receipt_liters: Math.round(Number(r.total_receipt_liters) * 10) / 10,
            total_obd_liters: Math.round(Number(r.total_obd_liters) * 10) / 10,
          };
        }),
        grand_total: {
          receipt_count: Number(grand.receipt_count) || 0,
          total_cost_ngn: Number(grand.total_cost_ngn) || 0,
          total_receipt_liters: Math.round(Number(grand.total_receipt_liters || 0) * 10) / 10,
          total_obd_liters: Math.round(Number(grand.total_obd_liters || 0) * 10) / 10,
        },
      };
    }

    res.json({
      source: 'database',
      page,
      limit,
      total,
      total_pages: Math.ceil(Number(total) / limit),
      purchases,
      ...(summary ? { summary } : {}),
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.post('/fuel-purchases/receipt', async (req: Request, res: Response) => {
  const {
    vehicle_id: vehicleId,
    liters_declared: litersDeclared,
    merchant,
    receipt_reference: receiptReference,
    purchased_at: purchasedAt,
    odometer_km: odometerKm,
    odometer_photo_url: odometerPhotoUrl,
  } = req.body as {
    vehicle_id?: string;
    liters_declared?: number;
    merchant?: string;
    receipt_reference?: string;
    purchased_at?: string;
    odometer_km?: number;
    odometer_photo_url?: string;
  };

  if (!vehicleId || !litersDeclared) {
    res.status(400).json({ error: 'vehicle_id and liters_declared are required' });
    return;
  }

  try {
    const customerId = req.user.customerId;
    const pricePerLiter = Number(process.env.FUEL_PRICE_NGN_LITER || DEFAULT_FUEL_PRICE_NGN_LITER);
    const when = purchasedAt ? new Date(purchasedAt) : new Date();

    const obdMatch = await findObdRefuelMatch({
      vehicleId,
      customerId,
      transactionDate: when,
    });

    const litersActual = obdMatch.liters;
    const declared = Number(litersDeclared);
    const diff =
      litersActual != null ? Math.max(0, Math.round((declared - litersActual) * 10) / 10) : null;

    let status = 'pending_receipt';
    if (litersActual != null && diff != null) {
      if (diff >= 10) status = 'flagged_theft';
      else if (diff <= 2) status = 'verified';
    }

    const [row] = await db
      .insert(fuelPurchases)
      .values({
        customerId,
        vehicleId,
        purchasedAt: when,
        merchant: merchant || 'Manual entry',
        receiptReference: receiptReference || null,
        litersDeclared: declared.toFixed(2),
        litersActual: litersActual != null ? litersActual.toFixed(2) : null,
        obdRefuelDetectedAt: obdMatch.obdRefuelDetectedAt,
        ignitionOnAt: obdMatch.ignitionOnAt,
        costPerLiterNgn: pricePerLiter,
        odometerKm:
          odometerKm != null && Number.isFinite(Number(odometerKm))
            ? Math.round(Number(odometerKm))
            : null,
        odometerPhotoUrl: odometerPhotoUrl ?? null,
        status,
        source: 'receipt_upload',
      })
      .returning({ id: fuelPurchases.id });

    // Credit the virtual tank — the receipt is the only refuel signal we have
    // on vehicles without a fuel sensor. Prefer the OBD-matched volume when a
    // sensor exists; otherwise trust the declared litres (reconciliation flags
    // inflated receipts separately).
    // A fill larger than the tank's modelled headroom is the audit moment for
    // the model, so the price rides along to value any gap it exposes.
    await creditRefuel(vehicleId, customerId, litersActual ?? declared, {
      pricePerLiter,
    }).catch((err) => console.error('[virtual_tank] refuel credit failed:', err));

    // Fill-to-fill reconciliation: compares this odometer reading against the
    // previous fill and against GPS, then refreshes the vehicle's rate.
    const reconciliation = await reconcileFuelPurchase(row.id).catch((err) => {
      console.error('[calibration] failed:', err);
      return null;
    });

    await invalidate(customerId, 'fleet', 'summary');

    res.status(201).json({
      id: row.id,
      reconciliation,
      liters_declared: declared,
      liters_actual: litersActual,
      difference_liters: diff,
      status,
      purchased_at: when.toISOString(),
      obd_refuel_detected_at: obdMatch.obdRefuelDetectedAt?.toISOString() ?? null,
      ignition_on_at: obdMatch.ignitionOnAt?.toISOString() ?? null,
      timeline: buildReceiptTimeline({
        purchasedAt: when,
        obdRefuelDetectedAt: obdMatch.obdRefuelDetectedAt,
        ignitionOnAt: obdMatch.ignitionOnAt,
      }),
      actual_from: litersActual != null ? 'obd_sensor' : 'pending_obd_match',
      message:
        litersActual != null
          ? `OBD recorded ${litersActual.toFixed(1)}L at ${obdMatch.obdRefuelDetectedAt?.toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Lagos' }) ?? 'refuel time'}.`
          : 'Receipt saved. OBD timestamps will attach when a refuel event is detected nearby.',
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/readings', async (req: Request, res: Response) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = (page - 1) * limit;
  const customerId = req.user.customerId;

  try {
    const countResult = await db.execute(sql`
      SELECT COUNT(*)::int AS total FROM telemetry WHERE customer_id = ${customerId}
    `);
    const total = (countResult.rows[0] as Record<string, unknown>)?.total ?? 0;

    const rows = await db.execute(sql`
      SELECT
        t.id,
        t.vehicle_id,
        v.license_plate,
        COALESCE(dr.full_name, v.driver_name) AS driver_name,
        t.recorded_at,
        t.fuel_level_liters,
        t.odometer_km,
        t.speed_kph,
        t.ignition_on,
        t.latitude,
        t.longitude
      FROM telemetry t
      JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN drivers dr ON dr.id = v.driver_id
      WHERE t.customer_id = ${customerId}
      ORDER BY t.recorded_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    res.json({
      page,
      limit,
      total,
      total_pages: Math.ceil(Number(total) / limit),
      rows: rows.rows,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/efficiency', async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.days) || 7, 90);

  try {
    const result = await db.execute(sql`
      SELECT
        DATE(recorded_at) as date,
        AVG(odometer_km) as avg_odometer,
        AVG(fuel_level_liters) as avg_fuel
      FROM telemetry
      WHERE customer_id = ${req.user.customerId}
        AND recorded_at > NOW() - (${days} || ' days')::INTERVAL
      GROUP BY DATE(recorded_at)
      ORDER BY date DESC
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Everything the tracker reports about one vehicle, in two parts:
//   signals  — every IO element in the newest frame, decoded and named
//   activity — how the day was actually spent, derived from telemetry
//
// The signal list is driven by the frame, not by a fixed set of columns, so a
// newly enabled element in the configurator shows up here on its own.
router.get('/vehicle-signals', async (req: Request, res: Response) => {
  const vehicleId = String(req.query.vehicle_id || '').trim();
  const days = Math.min(Math.max(Number(req.query.days) || 1, 1), 30);
  const customerId = req.user.customerId;

  if (!vehicleId) {
    return res.status(400).json({ error: 'vehicle_id is required' });
  }

  try {
    const key = cacheKey(customerId, 'vehicle-signals', `${vehicleId}:${days}`);
    const cached = await withCache(key, 30, async () => {
      const [frame] = (
        await db.execute(sql`
          SELECT f.imei, f.received_at, f.io_raw, f.gps_satellites, f.gps_valid, f.event_id
          FROM device_frames f
          JOIN devices d ON d.imei = f.imei
          WHERE d.vehicle_id = ${vehicleId}::uuid
            AND d.customer_id = ${customerId}::uuid
          ORDER BY f.received_at DESC
          LIMIT 1
        `)
      ).rows as Array<Record<string, unknown>>;

      const ioRaw = (frame?.io_raw as Record<string, unknown> | null) ?? null;
      const signals = ioRaw
        ? Object.keys(ioRaw)
            .map(Number)
            .filter((id) => Number.isFinite(id))
            .sort((a, b) => a - b)
            .flatMap((id) => {
              const raw = getSerializedIoValue(ioRaw, id);
              return raw == null ? [] : [decodeSignal(id, raw)];
            })
        : [];

      // Time is attributed to the state at the START of each gap — a frame
      // saying "ignition off" closes the running period, it does not describe
      // it. Gaps are capped at the device's one-hour idle heartbeat so a
      // tracker that goes offline for a day cannot report a day of driving.
      const [activity] = (
        await db.execute(sql`
          WITH readings AS (
            SELECT
              t.recorded_at,
              COALESCE(t.ignition_on, false) AS ignition_on,
              COALESCE(t.speed_kph, 0) AS speed_kph,
              t.odometer_km,
              t.fuel_used_gps_ml
            FROM telemetry t
            WHERE t.vehicle_id = ${vehicleId}::uuid
              AND t.customer_id = ${customerId}::uuid
              AND t.recorded_at > NOW() - (${days} || ' days')::INTERVAL
          ),
          spans AS (
            SELECT
              *,
              LAG(ignition_on) OVER w AS prev_ignition,
              LEAST(
                EXTRACT(EPOCH FROM (LEAD(recorded_at) OVER w - recorded_at)),
                3600
              ) AS span_s
            FROM readings
            WINDOW w AS (ORDER BY recorded_at)
          )
          SELECT
            COUNT(*)::int AS records,
            COALESCE(SUM(span_s) FILTER (WHERE ignition_on), 0)::numeric AS engine_on_seconds,
            COALESCE(SUM(span_s) FILTER (WHERE speed_kph >= 2), 0)::numeric AS moving_seconds,
            COALESCE(
              SUM(span_s) FILTER (WHERE ignition_on AND speed_kph < 2), 0
            )::numeric AS idle_seconds,
            COUNT(*) FILTER (WHERE prev_ignition = false AND ignition_on)::int AS ignition_cycles,
            MAX(speed_kph)::int AS max_speed_kph,
            ROUND(AVG(speed_kph) FILTER (WHERE speed_kph >= 2))::int AS avg_moving_speed_kph,
            MIN(recorded_at) FILTER (WHERE speed_kph >= 2) AS first_moved_at,
            MAX(recorded_at) FILTER (WHERE speed_kph >= 2) AS last_moved_at,
            GREATEST(MAX(odometer_km) - MIN(odometer_km), 0)::int AS distance_km,
            -- The GPS fuel accumulator resets on a power cycle, which would
            -- read as a negative burn. Clamp rather than report a refund.
            GREATEST(
              (MAX(fuel_used_gps_ml) - MIN(fuel_used_gps_ml)) / 1000.0, 0
            )::numeric AS fuel_used_liters
          FROM spans
        `)
      ).rows as Array<Record<string, unknown>>;

      return {
        imei: frame?.imei ?? null,
        frame_at: frame?.received_at ?? null,
        gps_satellites: frame?.gps_satellites ?? null,
        gps_valid: frame?.gps_valid ?? null,
        signals,
        activity: activity ?? null,
        days,
      };
    });

    res.json(serializeForApi(cached));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
