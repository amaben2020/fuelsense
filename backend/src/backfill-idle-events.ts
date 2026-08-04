import 'dotenv/config';

import { db, initDatabase, closePool } from './db';
import { sql } from 'drizzle-orm';
import { stepIdle, type IdleState } from './lib/idle-detector';

// Retroactively derives idling from telemetry already in the database.
//
// The live detector only sees records as they arrive, so every idle stretch
// before it shipped is missing. This replays stored telemetry through the same
// state machine to recover them.
//
// Idempotent: a stretch whose (imei, occurred_at, event_type) already exists in
// device_events is skipped, so the script can be re-run safely.
//
// Usage: npm run backfill-idle-events                 (dry run)
//        npm run backfill-idle-events -- --apply
//        npm run backfill-idle-events -- --days 30 --apply

async function run(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const daysArg = process.argv.indexOf('--days');
  const days = daysArg !== -1 ? Number(process.argv[daysArg + 1]) || 30 : 30;

  await initDatabase();

  const readings = await db.execute(sql`
    SELECT t.imei, t.customer_id, t.vehicle_id, t.ignition_on, t.speed_kph,
           t.latitude, t.longitude, t.recorded_at
    FROM telemetry t
    WHERE t.recorded_at > NOW() - (${days} || ' days')::INTERVAL
      AND t.vehicle_id IS NOT NULL
    ORDER BY t.imei ASC, t.recorded_at ASC
  `);

  console.log(`Telemetry records to replay: ${readings.rows.length} (last ${days} days)`);

  // One machine per device, fed in chronological order — the same contract the
  // live path relies on.
  const states = new Map<string, IdleState | null>();
  let inserted = 0;
  let skipped = 0;

  for (const row of readings.rows) {
    const r = row as Record<string, unknown>;
    const imei = r.imei as string;

    const { state, emissions } = stepIdle(states.get(imei) ?? null, {
      ignitionOn: Boolean(r.ignition_on),
      speedKph: r.speed_kph != null ? Number(r.speed_kph) : null,
      recordedAt: new Date(r.recorded_at as string),
    });
    states.set(imei, state);

    for (const emission of emissions) {
      const occurredAt = emission.occurredAt.toISOString();

      const existing = await db.execute(sql`
        SELECT 1 FROM device_events
        WHERE imei = ${imei}
          AND event_type = ${emission.eventType}
          AND occurred_at = ${occurredAt}::timestamp
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
            (${imei}, ${r.customer_id}::uuid, ${r.vehicle_id}::uuid,
             ${emission.eventType}, 'info',
             ${emission.minutes != null ? emission.minutes.toString() : null},
             ${emission.minutes != null ? 'min' : null}, 0,
             ${r.latitude as string | null}, ${r.longitude as string | null},
             ${occurredAt}::timestamp)
        `);
      }
      inserted++;
    }
  }

  console.log(
    apply
      ? `Inserted ${inserted} idle events (${skipped} skipped as duplicates).`
      : `Dry run: would insert ${inserted} idle events (${skipped} skipped). Re-run with --apply to write.`
  );

  await closePool();
}

run().catch((error) => {
  console.error('Backfill failed:', error);
  process.exit(1);
});
