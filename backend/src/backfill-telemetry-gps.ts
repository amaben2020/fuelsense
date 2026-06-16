import 'dotenv/config';

import { db, initDatabase, closePool } from './db';
import { telemetry } from './db/schema';
import { eq, sql } from 'drizzle-orm';

// Mirrors the live-ingest fix in tcp-server.ts: GPS speed is noisy while parked,
// so any non-zero speed recorded while ignition was off is bogus.
const SPEED_WHEN_IGNITION_OFF = sql`${telemetry.ignitionOn} = false AND ${telemetry.speedKph} IS NOT NULL AND ${telemetry.speedKph} != 0`;

// A position is a "spike" if the implied speed to reach it and to leave it are
// both physically impossible for a road vehicle, but skipping it entirely
// (prev -> next) is normal. That pattern is exactly the back-and-forth zigzag
// caused by a momentary bad GPS fix (multipath near buildings).
const SPIKE_KPH_THRESHOLD = 150;

interface TelemetryPoint {
  id: number;
  vehicleId: string | null;
  recordedAt: Date;
  latitude: string | null;
  longitude: string | null;
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function impliedSpeedKph(a: TelemetryPoint, b: TelemetryPoint): number | null {
  if (!a.latitude || !a.longitude || !b.latitude || !b.longitude) return null;
  const hours = (b.recordedAt.getTime() - a.recordedAt.getTime()) / 3_600_000;
  if (hours <= 0) return null;
  const km = haversineKm(
    Number(a.latitude),
    Number(a.longitude),
    Number(b.latitude),
    Number(b.longitude)
  );
  return km / hours;
}

async function findGpsSpikes(): Promise<number[]> {
  const rows = (await db
    .select({
      id: telemetry.id,
      vehicleId: telemetry.vehicleId,
      recordedAt: telemetry.recordedAt,
      latitude: telemetry.latitude,
      longitude: telemetry.longitude,
    })
    .from(telemetry)
    .where(sql`${telemetry.latitude} IS NOT NULL AND ${telemetry.longitude} IS NOT NULL`)
    .orderBy(telemetry.vehicleId, telemetry.recordedAt)) as TelemetryPoint[];

  const byVehicle = new Map<string, TelemetryPoint[]>();
  for (const row of rows) {
    if (!row.vehicleId) continue;
    const list = byVehicle.get(row.vehicleId) ?? [];
    list.push(row);
    byVehicle.set(row.vehicleId, list);
  }

  const spikeIds: number[] = [];
  for (const points of byVehicle.values()) {
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1];
      const cur = points[i];
      const next = points[i + 1];

      const inSpeed = impliedSpeedKph(prev, cur);
      const outSpeed = impliedSpeedKph(cur, next);
      const skipSpeed = impliedSpeedKph(prev, next);

      if (
        inSpeed != null &&
        outSpeed != null &&
        inSpeed > SPIKE_KPH_THRESHOLD &&
        outSpeed > SPIKE_KPH_THRESHOLD &&
        (skipSpeed == null || skipSpeed <= SPIKE_KPH_THRESHOLD)
      ) {
        spikeIds.push(cur.id);
      }
    }
  }
  return spikeIds;
}

async function run(): Promise<void> {
  const apply = process.argv.includes('--apply');
  await initDatabase();

  const [{ count: badSpeedCount }] = (await db
    .select({ count: sql<number>`count(*)::int` })
    .from(telemetry)
    .where(SPEED_WHEN_IGNITION_OFF)) as { count: number }[];

  const spikeIds = await findGpsSpikes();

  console.log(`Rows with speed_kph != 0 while ignition_on = false: ${badSpeedCount}`);
  console.log(`GPS spike points (zigzag artifacts) detected: ${spikeIds.length}`);

  if (!apply) {
    console.log('\nDry run only — re-run with --apply to write these fixes.');
    await closePool();
    return;
  }

  if (badSpeedCount > 0) {
    await db.update(telemetry).set({ speedKph: 0 }).where(SPEED_WHEN_IGNITION_OFF);
    console.log(`Zeroed speed_kph on ${badSpeedCount} rows.`);
  }

  if (spikeIds.length > 0) {
    for (const id of spikeIds) {
      await db
        .update(telemetry)
        .set({ latitude: null, longitude: null })
        .where(eq(telemetry.id, id));
    }
    console.log(`Cleared latitude/longitude on ${spikeIds.length} GPS spike rows.`);
  }

  await closePool();
}

run().catch((error) => {
  console.error('Backfill failed:', error);
  process.exit(1);
});
