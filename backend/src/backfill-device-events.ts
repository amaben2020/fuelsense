import 'dotenv/config';

import { db, initDatabase, closePool } from './db';
import { sql } from 'drizzle-orm';
import { getSerializedIoValue } from './lib/avl-io';
import {
  decodeScenarioEvent,
  SCENARIO_EVENT_IO_IDS,
} from './lib/device-event-decoder';

// Retroactively extracts FMC150 scenario events (green driving, overspeeding,
// towing, crash, jamming, unplug, idling, trip, geofence) from the raw frames
// already stored in device_frames.io_raw, and inserts them into device_events.
//
// Idempotent: a frame whose (imei, occurred_at, event_type) already exists in
// device_events is skipped, so the script can be re-run safely.
//
// Usage: npm run backfill-device-events            (dry run)
//        npm run backfill-device-events -- --apply

async function run(): Promise<void> {
  const apply = process.argv.includes('--apply');
  await initDatabase();

  const frames = await db.execute(sql`
    SELECT
      f.imei,
      f.event_id,
      f.received_at,
      f.io_raw,
      f.gps_raw,
      d.customer_id,
      d.vehicle_id,
      v.license_plate
    FROM device_frames f
    JOIN devices d ON d.imei = f.imei
    LEFT JOIN vehicles v ON v.id = d.vehicle_id
    WHERE f.event_id IN (${sql.join(
      SCENARIO_EVENT_IO_IDS.map((id) => sql`${id}`),
      sql`, `
    )})
      AND d.vehicle_id IS NOT NULL
    ORDER BY f.received_at ASC
  `);

  console.log(`Scenario-eventful frames found: ${frames.rows.length}`);

  let inserted = 0;
  let skipped = 0;

  for (const row of frames.rows) {
    const r = row as Record<string, unknown>;
    const ioRaw = r.io_raw as Record<string, unknown> | null;
    const gpsRaw = r.gps_raw as Record<string, unknown> | null;
    const eventIoId = Number(r.event_id);

    // Bridge the serialized {hex, dec} shape to the live-decoder's IO reader
    const ioForDecode: Record<string, number> = {};
    if (ioRaw) {
      for (const key of Object.keys(ioRaw)) {
        const value = getSerializedIoValue(ioRaw, Number(key));
        if (value != null) ioForDecode[key] = value;
      }
    }

    const speedKph = gpsRaw?.speed != null ? Math.round(Number(gpsRaw.speed)) : null;
    const decoded = decodeScenarioEvent(eventIoId, {
      io: ioForDecode,
      speedKph,
      licensePlate: (r.license_plate as string) ?? undefined,
    });
    if (!decoded) {
      skipped++;
      continue;
    }

    const occurredAt = new Date(r.received_at as string);
    const lat = gpsRaw?.latitude != null ? Number(gpsRaw.latitude) : null;
    const lng = gpsRaw?.longitude != null ? Number(gpsRaw.longitude) : null;
    const validGps = lat != null && lng != null && (lat !== 0 || lng !== 0);

    const existing = await db.execute(sql`
      SELECT 1 FROM device_events
      WHERE imei = ${r.imei}
        AND event_type = ${decoded.eventType}
        AND occurred_at = ${occurredAt.toISOString()}::timestamp
      LIMIT 1
    `);
    if (existing.rows.length > 0) {
      skipped++;
      continue;
    }

    if (apply) {
      await db.execute(sql`
        INSERT INTO device_events
          (imei, customer_id, vehicle_id, event_type, severity, value, unit,
           speed_kph, latitude, longitude, occurred_at)
        VALUES
          (${r.imei}, ${r.customer_id}::uuid, ${r.vehicle_id}::uuid,
           ${decoded.eventType}, ${decoded.severity},
           ${decoded.value != null ? decoded.value.toString() : null},
           ${decoded.unit}, ${speedKph},
           ${validGps ? lat!.toString() : null},
           ${validGps ? lng!.toString() : null},
           ${occurredAt.toISOString()}::timestamp)
      `);
    }
    inserted++;
    if (inserted % 100 === 0) console.log(`  ...${inserted} events processed`);
  }

  console.log(
    apply
      ? `Inserted ${inserted} device events (${skipped} skipped as duplicates/undecodable).`
      : `Dry run: would insert ${inserted} device events (${skipped} skipped). Re-run with --apply to write.`
  );

  await closePool();
}

run().catch((error) => {
  console.error('Backfill failed:', error);
  process.exit(1);
});
