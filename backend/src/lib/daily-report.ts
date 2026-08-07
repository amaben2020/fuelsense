// The day's driving, per driver, in a form a manager can read without opening
// the app.
//
// The test for this report is simple: if the manager has to log in to answer a
// question it raised, it failed. So every figure that would prompt "and then
// what?" is already here — where each trip went, how long the engine ran doing
// nothing, what was spent, and what the fleet totals come to.
//
// Nothing here is a new measurement. It reads the same trip segmentation, idle
// detection and receipt records the dashboard shows, so a number in the inbox
// and the same number on screen can never disagree.
import { db, sql } from './db-helpers';
import { segmentTrips, TelemetryTripPoint } from './trip-segmentation';
import { cachedPlaceNames, placeKeyFor } from './place-lookup';
import { latestReceiptPrice } from './fuel-price';
import {
  baselineEfficiencyKmL,
  IDLE_BURN_LITERS_PER_HOUR,
  round1,
  speedBucketMultiplier,
} from './fuel-metrics';

export interface ReportTrip {
  startedAt: Date;
  endedAt: Date;
  distanceKm: number;
  idleMinutes: number;
  fuelLiters: number;
  from: string | null;
  to: string | null;
  stopCount: number;
}

export interface ReportDriver {
  driverName: string;
  licensePlate: string;
  trips: ReportTrip[];
  distanceKm: number;
  idleMinutes: number;
  fuelLiters: number;
  fuelCostNgn: number | null;
  /** Receipts the driver logged that day — actual money out. */
  spendNgn: number;
  litersBought: number;
  receiptCount: number;
}

export interface DailyReport {
  customerName: string;
  date: Date;
  drivers: ReportDriver[];
  totals: {
    distanceKm: number;
    idleMinutes: number;
    fuelLiters: number;
    fuelCostNgn: number | null;
    spendNgn: number;
    litersBought: number;
    tripCount: number;
  };
  pricePerLiter: number | null;
}

/** Lagos day boundaries for a given date, as UTC instants. */
export function lagosDayBounds(date: Date): { from: Date; to: Date } {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  // WAT is UTC+1 year-round — no daylight saving to account for.
  const from = new Date(Date.UTC(y, m, d, -1, 0, 0));
  return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000) };
}

export async function buildDailyReport(
  customerId: string,
  date: Date
): Promise<DailyReport | null> {
  const { from, to } = lagosDayBounds(date);

  const [customer] = (
    await db.execute(sql`
      SELECT COALESCE(company_name, name) AS name FROM customers WHERE id = ${customerId}
    `)
  ).rows as Array<{ name: string }>;

  if (!customer) return null;

  const price = await latestReceiptPrice(customerId).catch(() => null);
  const pricePerLiter = price?.ngnPerLiter ?? null;

  const vehicles = (
    await db.execute(sql`
      SELECT v.id, v.license_plate, v.model,
             COALESCE(d.full_name, v.driver_name, 'Unassigned') AS driver_name
      FROM vehicles v
      LEFT JOIN drivers d ON d.id = v.driver_id
      WHERE v.customer_id = ${customerId}
    `)
  ).rows as Array<{
    id: string;
    license_plate: string;
    model: string | null;
    driver_name: string;
  }>;

  const drivers: ReportDriver[] = [];

  for (const vehicle of vehicles) {
    const points = (
      await db.execute(sql`
        SELECT latitude::double precision AS lat, longitude::double precision AS lng,
               speed_kph, ignition_on, recorded_at
        FROM telemetry
        WHERE vehicle_id = ${vehicle.id}
          AND recorded_at >= ${from} AND recorded_at < ${to}
          AND latitude IS NOT NULL AND longitude IS NOT NULL
        ORDER BY recorded_at ASC
      `)
    ).rows as Array<Record<string, unknown>>;

    const tripPoints: TelemetryTripPoint[] = points.map((p) => ({
      lat: Number(p.lat),
      lng: Number(p.lng),
      speedKph: p.speed_kph != null ? Number(p.speed_kph) : 0,
      ignitionOn: Boolean(p.ignition_on),
      recordedAt: new Date(p.recorded_at as string),
    }));

    const segments = segmentTrips(tripPoints);
    const efficiencyKmL = baselineEfficiencyKmL(vehicle.model ?? '');

    // Name the endpoints from the place cache only. A report must not turn
    // into a bill for hundreds of geocodes every morning.
    const endpoints = segments.flatMap((t) => [
      { lat: t.stops[0]?.lat, lng: t.stops[0]?.lng },
      {
        lat: t.stops[t.stops.length - 1]?.lat,
        lng: t.stops[t.stops.length - 1]?.lng,
      },
    ]);
    const names = await cachedPlaceNames(
      endpoints.flatMap((p) => (p.lat != null && p.lng != null ? [{ lat: p.lat, lng: p.lng }] : []))
    );
    const nameFor = (lat?: number, lng?: number): string | null =>
      lat != null && lng != null ? (names.get(placeKeyFor(lat, lng)) ?? null) : null;

    const trips: ReportTrip[] = segments.map((t) => {
      const fuel = round1(
        (t.distance_km / efficiencyKmL) * speedBucketMultiplier(t.avg_speed_kph) +
          (t.idle_minutes / 60) * IDLE_BURN_LITERS_PER_HOUR
      );
      const first = t.stops[0];
      const last = t.stops[t.stops.length - 1];

      return {
        startedAt: new Date(t.start_at),
        endedAt: new Date(t.end_at),
        distanceKm: t.distance_km,
        idleMinutes: t.idle_minutes,
        fuelLiters: fuel,
        from: nameFor(first?.lat, first?.lng),
        to: nameFor(last?.lat, last?.lng),
        stopCount: t.stops.filter((s) => s.kind === 'stop').length,
      };
    });

    const receipts = (
      await db.execute(sql`
        SELECT COALESCE(SUM(total_amount), 0) AS spend,
               COALESCE(SUM(declared_liters), 0) AS liters,
               COUNT(*) AS n
        FROM fuel_receipts
        WHERE vehicle_id = ${vehicle.id}
          AND transaction_date >= ${from} AND transaction_date < ${to}
      `)
    ).rows[0] as Record<string, unknown>;

    const distanceKm = round1(trips.reduce((s, t) => s + t.distanceKm, 0));
    const idleMinutes = Math.round(trips.reduce((s, t) => s + t.idleMinutes, 0));
    const fuelLiters = round1(trips.reduce((s, t) => s + t.fuelLiters, 0));

    // A vehicle that never moved and bought nothing is not worth a section.
    if (trips.length === 0 && Number(receipts.n) === 0) continue;

    drivers.push({
      driverName: vehicle.driver_name,
      licensePlate: vehicle.license_plate,
      trips,
      distanceKm,
      idleMinutes,
      fuelLiters,
      fuelCostNgn: pricePerLiter != null ? Math.round(fuelLiters * pricePerLiter) : null,
      spendNgn: Math.round(Number(receipts.spend)),
      litersBought: round1(Number(receipts.liters)),
      receiptCount: Number(receipts.n),
    });
  }

  const totals = {
    distanceKm: round1(drivers.reduce((s, d) => s + d.distanceKm, 0)),
    idleMinutes: drivers.reduce((s, d) => s + d.idleMinutes, 0),
    fuelLiters: round1(drivers.reduce((s, d) => s + d.fuelLiters, 0)),
    fuelCostNgn:
      pricePerLiter != null
        ? drivers.reduce((s, d) => s + (d.fuelCostNgn ?? 0), 0)
        : null,
    spendNgn: drivers.reduce((s, d) => s + d.spendNgn, 0),
    litersBought: round1(drivers.reduce((s, d) => s + d.litersBought, 0)),
    tripCount: drivers.reduce((s, d) => s + d.trips.length, 0),
  };

  return { customerName: customer.name, date, drivers, totals, pricePerLiter };
}
