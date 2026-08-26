import 'dotenv/config';

import { db, initDatabase, closePool } from './db';
import { sql } from 'drizzle-orm';
import {
  EXTERNAL_POWER_MIN_MV,
  CONSECUTIVE_LOW_FRAMES,
  EXTERNAL_VOLTAGE_AVL_ID,
} from './lib/power-monitor';

// Recovers tracker power-loss events that happened before AVL 66 was being
// read, from the raw frames already in device_frames.io_raw.
//
// The live detector in lib/power-monitor.ts only sees frames as they arrive, so
// a disconnect that predates it left evidence and no event. This replays the
// same rules — same threshold, same debounce — over history.
//
// Idempotent: an (imei, occurred_at, event_type) already in device_events is
// skipped, so it can be re-run safely.
//
// Usage: npm run backfill-power-events            (dry run)
//        npm run backfill-power-events -- --apply

interface FrameRow {
  imei: string;
  customer_id: string;
  vehicle_id: string;
  license_plate: string | null;
  // Raw `db.execute` hands timestamps back as strings, not Dates — unlike the
  // query builder. Coerced at the point of use below rather than trusted.
  received_at: string | Date;
  external_mv: number | null;
  latitude: string | null;
  longitude: string | null;
}

interface Transition {
  imei: string;
  customerId: string;
  vehicleId: string;
  plate: string;
  type: 'power_unplug' | 'power_restored';
  at: Date;
  externalMv: number;
  latitude: string | null;
  longitude: string | null;
}

const fmtV = (mv: number): string => `${(mv / 1000).toFixed(1)}V`;

async function run(): Promise<void> {
  const apply = process.argv.includes('--apply');
  await initDatabase();

  const result = await db.execute(sql`
    SELECT
      f.imei,
      d.customer_id,
      d.vehicle_id,
      v.license_plate,
      f.received_at,
      (f.io_raw -> ${String(EXTERNAL_VOLTAGE_AVL_ID)} ->> 'dec')::int AS external_mv,
      t.latitude::text  AS latitude,
      t.longitude::text AS longitude
    FROM device_frames f
    JOIN devices d ON d.imei = f.imei
    LEFT JOIN vehicles v ON v.id = d.vehicle_id
    LEFT JOIN telemetry t ON t.id = f.telemetry_id
    WHERE f.io_raw ? ${String(EXTERNAL_VOLTAGE_AVL_ID)}
      AND d.vehicle_id IS NOT NULL
    ORDER BY f.imei, f.received_at ASC
  `);

  const frames = result.rows as unknown as FrameRow[];
  console.log(
    `Scanning ${frames.length} frames carrying AVL ${EXTERNAL_VOLTAGE_AVL_ID}, ` +
      `threshold ${EXTERNAL_POWER_MIN_MV} mV, debounce ${CONSECUTIVE_LOW_FRAMES} frames.`
  );

  // Same state machine as the live detector, per device.
  const transitions: Transition[] = [];
  const state = new Map<string, { unplugged: boolean; lowStreak: number }>();

  for (const f of frames) {
    if (f.external_mv == null || !Number.isFinite(f.external_mv)) continue;

    const at = f.received_at instanceof Date ? f.received_at : new Date(f.received_at);
    const s = state.get(f.imei) ?? { unplugged: false, lowStreak: 0 };
    state.set(f.imei, s);

    const plate = f.license_plate || f.imei;
    const low = f.external_mv < EXTERNAL_POWER_MIN_MV;

    if (low) {
      s.lowStreak += 1;
      if (!s.unplugged && s.lowStreak >= CONSECUTIVE_LOW_FRAMES) {
        s.unplugged = true;
        transitions.push({
          imei: f.imei,
          customerId: f.customer_id,
          vehicleId: f.vehicle_id,
          plate,
          type: 'power_unplug',
          at,
          externalMv: f.external_mv,
          latitude: f.latitude,
          longitude: f.longitude,
        });
      }
      continue;
    }

    s.lowStreak = 0;
    if (!s.unplugged) continue;
    s.unplugged = false;
    transitions.push({
      imei: f.imei,
      customerId: f.customer_id,
      vehicleId: f.vehicle_id,
      plate,
      type: 'power_restored',
      at,
      externalMv: f.external_mv,
      latitude: f.latitude,
      longitude: f.longitude,
    });
  }

  if (transitions.length === 0) {
    console.log('No power transitions found.');
    await closePool();
    return;
  }

  // Pair each unplug with its restore so the report reads as episodes rather
  // than a list of edges — the duration is the part a manager reacts to.
  console.log(`\n${transitions.length} transition(s):\n`);
  let openedAt: Date | null = null;
  for (const t of transitions) {
    if (t.type === 'power_unplug') {
      openedAt = t.at;
      console.log(
        `  UNPLUG   ${t.plate}  ${t.at.toISOString()}  external ${fmtV(t.externalMv)}`
      );
    } else {
      const secs = openedAt ? Math.round((t.at.getTime() - openedAt.getTime()) / 1000) : null;
      console.log(
        `  RESTORED ${t.plate}  ${t.at.toISOString()}  external ${fmtV(t.externalMv)}` +
          (secs != null ? `  (off for ${Math.floor(secs / 60)}m ${secs % 60}s)` : '')
      );
      openedAt = null;
    }
  }
  if (openedAt) console.log(`\n  Still unplugged since ${openedAt.toISOString()}.`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write these events and alerts.');
    await closePool();
    return;
  }

  let events = 0;
  let raised = 0;
  let resolved = 0;

  for (const t of transitions) {
    const inserted = await db.execute(sql`
      INSERT INTO device_events
        (imei, customer_id, vehicle_id, event_type, severity, value, unit,
         latitude, longitude, occurred_at)
      SELECT ${t.imei}, ${t.customerId}::uuid, ${t.vehicleId}::uuid, ${t.type},
             ${t.type === 'power_unplug' ? 'critical' : 'info'},
             ${String(t.externalMv)}, 'mV',
             ${t.latitude}::numeric, ${t.longitude}::numeric, ${t.at.toISOString()}::timestamp
      WHERE NOT EXISTS (
        SELECT 1 FROM device_events
        WHERE imei = ${t.imei}
          AND event_type = ${t.type}
          AND occurred_at = ${t.at.toISOString()}::timestamp
      )
      RETURNING id
    `);
    if (inserted.rows.length > 0) events += 1;

    if (t.type === 'power_unplug') {
      // Historic alerts are inserted already resolved when the power came back,
      // so a backfill never leaves a manager with a critical alert for a
      // disconnect that ended weeks ago. Only a still-open episode stays open.
      const stillOpen = t === transitions[transitions.length - 1] &&
        transitions[transitions.length - 1].type === 'power_unplug';

      const alertRows = await db.execute(sql`
        INSERT INTO alerts
          (imei, customer_id, vehicle_id, alert_type, message, latitude, longitude,
           is_resolved, created_at)
        SELECT ${t.imei}, ${t.customerId}::uuid, ${t.vehicleId}::uuid, 'power_unplug',
               ${`Tracker on ${t.plate} lost main power and is running on its internal battery. External voltage read ${fmtV(t.externalMv)}. Possible tamper or disconnect.`},
               ${t.latitude}::numeric, ${t.longitude}::numeric,
               ${!stillOpen}, ${t.at.toISOString()}::timestamp
        WHERE NOT EXISTS (
          SELECT 1 FROM alerts
          WHERE imei = ${t.imei}
            AND alert_type = 'power_unplug'
            AND created_at = ${t.at.toISOString()}::timestamp
        )
        RETURNING id
      `);
      if (alertRows.rows.length > 0) raised += 1;
    } else {
      const closed = await db.execute(sql`
        UPDATE alerts SET is_resolved = TRUE, resolved_at = ${t.at.toISOString()}::timestamp
        WHERE imei = ${t.imei}
          AND alert_type = 'power_unplug'
          AND is_resolved = FALSE
          AND created_at <= ${t.at.toISOString()}::timestamp
        RETURNING id
      `);
      resolved += closed.rows.length;
    }
  }

  console.log(
    `\nApplied: ${events} device_event(s), ${raised} alert(s) raised, ${resolved} resolved.`
  );
  await closePool();
}

run().catch(async (err) => {
  console.error(err);
  await closePool();
  process.exit(1);
});
