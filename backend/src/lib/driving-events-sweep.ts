// Turns raw frames into the driving-behaviour feed.
//
// Speed and heading both live in `device_frames.gps_raw`, sampled about a
// second apart while the vehicle moves — dense enough to see a manoeuvre.
// Detection runs here rather than in the TCP handler because a harsh event
// needs the sample *after* the one being judged, and because a frame must
// never wait on analysis to be persisted.
//
// Events are written as `device_events` rows using the same three types the
// device would have emitted with its Eco/Green Driving scenario enabled, so
// the existing scoring, feed and icons pick them up with no further wiring.
import { db, sql, deviceEvents } from './db-helpers';
import { detectHarshEvents, DrivingSample, HarshEvent } from './harsh-driving';

const LOOKBACK_DAYS = Number(process.env.HARSH_LOOKBACK_DAYS || 14);
/** Frames per vehicle per pass. A day of driving is a few thousand. */
const MAX_FRAMES = Number(process.env.HARSH_MAX_FRAMES || 20_000);

interface FrameRow {
  imei: string;
  received_at: string;
  gps_valid: boolean | null;
  gps_raw: { speed?: number; angle?: number; latitude?: number; longitude?: number } | null;
}

/**
 * Detect and store harsh manoeuvres for every vehicle.
 *
 * Idempotent by design: a manoeuvre already recorded within a minute of the
 * same second is not written twice, so the pass can re-run over the same
 * fortnight without inflating a driver's score.
 */
export async function detectDrivingEvents(): Promise<{ found: number; written: number }> {
  // Frames are keyed by IMEI — the device, not the vehicle it is fitted to —
  // so the owning vehicle comes from `devices`.
  const vehicles = (
    await db.execute(sql`
      SELECT DISTINCT d.vehicle_id, d.customer_id, f.imei
      FROM device_frames f
      JOIN devices d ON d.imei = f.imei
      WHERE f.received_at > NOW() - (${LOOKBACK_DAYS} || ' days')::INTERVAL
        AND d.vehicle_id IS NOT NULL
    `)
  ).rows as Array<{ vehicle_id: string; customer_id: string; imei: string }>;

  let found = 0;
  let written = 0;

  for (const vehicle of vehicles) {
    const frames = (
      await db.execute(sql`
        SELECT imei, received_at, gps_raw, gps_valid
        FROM device_frames
        WHERE imei = ${vehicle.imei}
          AND received_at > NOW() - (${LOOKBACK_DAYS} || ' days')::INTERVAL
          AND gps_raw IS NOT NULL
        ORDER BY received_at ASC
        LIMIT ${MAX_FRAMES}
      `)
    ).rows as unknown as FrameRow[];

    if (frames.length < 2) continue;

    const samples: DrivingSample[] = frames.map((frame) => ({
      at: new Date(frame.received_at),
      speedKph: Number(frame.gps_raw?.speed ?? 0),
      // Heading without a valid fix is not "due north", it is unknown — and
      // feeding a stale 0° into a turn calculation invents hairpins.
      headingDeg:
        frame.gps_valid && frame.gps_raw?.angle != null ? Number(frame.gps_raw.angle) : null,
      lat: frame.gps_raw?.latitude != null ? Number(frame.gps_raw.latitude) : null,
      lng: frame.gps_raw?.longitude != null ? Number(frame.gps_raw.longitude) : null,
    }));

    const events = detectHarshEvents(samples);
    found += events.length;

    for (const event of events) {
      if (await alreadyRecorded(vehicle.vehicle_id, event)) continue;

      await db.insert(deviceEvents).values({
        imei: vehicle.imei,
        customerId: vehicle.customer_id,
        vehicleId: vehicle.vehicle_id,
        eventType: event.type,
        severity: event.severity,
        value: event.magnitudeMs2.toString(),
        unit: 'm/s2',
        speedKph: event.speedKph,
        latitude: event.lat?.toString() ?? null,
        longitude: event.lng?.toString() ?? null,
        occurredAt: event.occurredAt,
      });

      written += 1;
    }
  }

  return { found, written };
}

/**
 * Guards re-runs, nothing more.
 *
 * The window is deliberately tight. A minute-wide match looked safe and was
 * not: pulling away from three junctions in quick succession is three separate
 * manoeuvres, and a wide window silently swallowed the second and third —
 * 81 events detected, only 58 written. Contiguous samples are already merged
 * into a single event by the detector, so anything arriving seconds apart is a
 * genuinely distinct moment.
 */
async function alreadyRecorded(vehicleId: string, event: HarshEvent): Promise<boolean> {
  const existing = await db.execute(sql`
    SELECT 1 FROM device_events
    WHERE vehicle_id = ${vehicleId}
      AND event_type = ${event.type}
      AND occurred_at BETWEEN ${event.occurredAt}::timestamp - INTERVAL '2 seconds'
        AND ${event.occurredAt}::timestamp + INTERVAL '2 seconds'
    LIMIT 1
  `);
  return existing.rows.length > 0;
}

let timer: NodeJS.Timeout | null = null;

export function startDrivingEventSweep(intervalMs = 10 * 60 * 1000): void {
  if (timer) return;

  const run = async () => {
    try {
      const { found, written } = await detectDrivingEvents();
      if (written > 0) {
        console.log(`[driving_events] ${written} new harsh event(s) of ${found} detected`);
      }
    } catch (error) {
      console.error('[driving_events] sweep failed:', (error as Error).message);
    }
  };

  timer = setInterval(run, intervalMs);
  timer.unref?.();
  void run();
}
