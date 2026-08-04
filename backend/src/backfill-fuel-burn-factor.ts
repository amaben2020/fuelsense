import 'dotenv/config';

import { db, initDatabase, closePool } from './db';
import { sql } from 'drizzle-orm';
import { deriveBurnFactor } from './lib/virtual-tank';
import { REFUEL_THRESHOLD_LITERS } from './lib/fuel-metrics';

// A level change this large between two pings is a refuel, a manual
// re-anchor or a siphon — never modelled burn, which arrives in fractions
// of a litre per ping.
const STEP_CHANGE_LITERS = REFUEL_THRESHOLD_LITERS;

// Restates historical virtual-tank fuel levels with the burn correction.
//
// The tank is built from the device's Fuel Used GPS accumulator, which on some
// vehicles under-reports badly (see deriveBurnFactor). Rows written before the
// correction shipped still carry the uncorrected curve, so a week of cost and
// efficiency figures reads low until they age out. This replays each vehicle's
// stored curve with its factor applied.
//
// What it does NOT touch:
//   * fuel_used_gps_ml — the raw device value, kept exactly as transmitted
//   * rises in level — refuels and manual calibrations are credited as
//     recorded, since they came from evidence rather than from the accumulator
//
// Only drops are rescaled, because only drops came from the faulty element.
//
// Usage: npm run backfill-fuel-burn-factor                 (dry run)
//        npm run backfill-fuel-burn-factor -- --apply
//        npm run backfill-fuel-burn-factor -- --before "2026-08-04T17:50:00Z" --apply

async function run(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const beforeArg = process.argv.indexOf('--before');
  // Rows written after the correction went live are already correct — passing
  // a cutoff prevents double-applying the factor to them.
  const cutoff = beforeArg !== -1 ? new Date(process.argv[beforeArg + 1]) : new Date();

  if (Number.isNaN(cutoff.getTime())) {
    console.error('--before is not a valid date');
    process.exit(1);
  }

  await initDatabase();
  console.log(`Restating virtual-tank rows recorded before ${cutoff.toISOString()}`);

  const tanks = await db.execute(sql`
    SELECT vt.vehicle_id, vt.capacity_liters, vt.learned_idle_lph,
           vt.accumulator_idle_lph, vt.burn_factor_samples, v.license_plate
    FROM virtual_tanks vt
    JOIN vehicles v ON v.id = vt.vehicle_id
  `);

  let vehiclesChanged = 0;
  let rowsChanged = 0;

  for (const tankRow of tanks.rows) {
    const t = tankRow as Record<string, unknown>;
    const vehicleId = t.vehicle_id as string;
    const plate = (t.license_plate as string) ?? vehicleId;
    const capacityLiters = Number(t.capacity_liters) || 0;

    const { factor, source } = deriveBurnFactor(
      t.learned_idle_lph != null ? Number(t.learned_idle_lph) : null,
      t.accumulator_idle_lph != null ? Number(t.accumulator_idle_lph) : null,
      Number(t.burn_factor_samples ?? 0)
    );

    if (factor === 1) {
      console.log(`  ${plate}: no correction derived — skipped`);
      continue;
    }

    const readings = await db.execute(sql`
      SELECT id, recorded_at, fuel_level_liters
      FROM telemetry
      WHERE vehicle_id = ${vehicleId}::uuid
        AND fuel_source = 'virtual'
        AND fuel_level_liters IS NOT NULL
        AND recorded_at < ${cutoff.toISOString()}::timestamp
      ORDER BY recorded_at ASC
    `);

    if (readings.rows.length < 2) {
      console.log(`  ${plate}: fewer than 2 stored levels — skipped`);
      continue;
    }

    const updates: Array<{ id: number; level: number }> = [];
    let previousStored: number | null = null;
    let restated = 0;

    for (const row of readings.rows) {
      const r = row as Record<string, unknown>;
      const stored = Number(r.fuel_level_liters);

      if (previousStored == null) {
        // Anchor on the first stored level — it predates the drift we are
        // correcting, so it is the best available starting truth.
        restated = stored;
      } else {
        const change = stored - previousStored;
        // Only gradual drops came from the accumulator, and only those are
        // rescaled. A rise is a refuel or a calibration; a step change bigger
        // than a refuel threshold is a manual re-anchor or a siphon event, and
        // scaling one of those would subtract more than a tankful. Both are
        // reproduced exactly as recorded.
        const isModelledBurn = change < 0 && Math.abs(change) <= STEP_CHANGE_LITERS;
        restated += isModelledBurn ? change * factor : change;
        restated = Math.max(0, capacityLiters > 0 ? Math.min(restated, capacityLiters) : restated);
      }

      const rounded = Number(restated.toFixed(2));
      if (Math.abs(rounded - stored) >= 0.01) {
        updates.push({ id: Number(r.id), level: rounded });
      }
      previousStored = stored;
    }

    const first = readings.rows[0] as Record<string, unknown>;
    const last = readings.rows[readings.rows.length - 1] as Record<string, unknown>;
    console.log(
      `  ${plate}: factor ${factor.toFixed(3)} (${source}), ${readings.rows.length} rows, ` +
        `${updates.length} to restate — final level ${Number(last.fuel_level_liters).toFixed(2)}L ` +
        `→ ${restated.toFixed(2)}L (started ${Number(first.fuel_level_liters).toFixed(2)}L)`
    );

    if (apply && updates.length > 0) {
      // One statement per chunk keeps the round trips down without building a
      // single query large enough to upset the driver.
      const CHUNK = 500;
      for (let i = 0; i < updates.length; i += CHUNK) {
        const chunk = updates.slice(i, i + CHUNK);
        await db.execute(sql`
          UPDATE telemetry AS t
          SET fuel_level_liters = v.level
          FROM (VALUES ${sql.join(
            chunk.map((u) => sql`(${u.id}::bigint, ${u.level.toFixed(2)}::numeric)`),
            sql`, `
          )}) AS v(id, level)
          WHERE t.id = v.id
        `);
      }
    }

    vehiclesChanged += 1;
    rowsChanged += updates.length;
  }

  console.log(
    apply
      ? `Restated ${rowsChanged} rows across ${vehiclesChanged} vehicles.`
      : `Dry run: would restate ${rowsChanged} rows across ${vehiclesChanged} vehicles. Re-run with --apply.`
  );

  await closePool();
}

run().catch((error) => {
  console.error('Backfill failed:', error);
  process.exit(1);
});
