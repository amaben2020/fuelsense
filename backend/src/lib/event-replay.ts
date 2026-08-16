import { db, sql } from './db-helpers';
import { effectivePriceAt } from './fuel-price';
import { lookupPlace } from './place-lookup';

const REPLAY_WINDOW_MINUTES = 30;
const MAX_READINGS = 200;

/**
 * What the missing fuel was worth, at the price that applied when it went
 * missing.
 *
 * Every loss here used to be multiplied by a flat ₦1,300 constant, so a drop in
 * March and an identical drop in August produced the same naira figure and
 * neither matched the fleet's books. Nigerian pump prices move faster than that:
 * the fleet's own effective-dated benchmark, or failing that its newest receipt,
 * is the only rate we can defend to a manager.
 *
 * When the fleet has never recorded a price there is no honest figure, so the
 * amount is null and the UI shows litres alone rather than inventing money.
 */
async function valueLiters(
  customerId: string,
  at: Date | string,
  liters: number,
): Promise<{
  estimated_loss_ngn: number | null;
  price_ngn_per_liter: number | null;
  price_source: 'benchmark' | 'receipt' | null;
}> {
  const when = at instanceof Date ? at : new Date(parseInstant(at));
  const price = Number.isFinite(when.getTime())
    ? await effectivePriceAt(customerId, when)
    : null;

  if (!price) {
    return {
      estimated_loss_ngn: null,
      price_ngn_per_liter: null,
      price_source: null,
    };
  }

  return {
    estimated_loss_ngn: Math.round(Math.max(0, liters) * price.ngnPerLiter),
    price_ngn_per_liter: price.ngnPerLiter,
    price_source: price.source,
  };
}

interface TelemetryWindowParams {
  vehicleId: string;
  customerId: string;
  centerTime: Date | string;
}

interface RawRow {
  recorded_at: unknown;
  fuel_level_liters?: unknown;
  speed_kph?: unknown;
  ignition_on?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  odometer_km?: unknown;
}

export interface SerializedReading {
  recorded_at: unknown;
  fuel_level_liters: number | null;
  speed_kph: number;
  ignition_on: boolean;
  latitude: number | null;
  longitude: number | null;
  odometer_km: number | null;
}

async function loadTelemetryWindow({
  vehicleId,
  customerId,
  centerTime,
}: TelemetryWindowParams) {
  const center =
    centerTime instanceof Date ? centerTime : new Date(centerTime as string);
  const start = new Date(center.getTime() - REPLAY_WINDOW_MINUTES * 60 * 1000);
  const end = new Date(center.getTime() + REPLAY_WINDOW_MINUTES * 60 * 1000);

  const result = await db.execute(sql`
    SELECT
      recorded_at,
      fuel_level_liters,
      speed_kph,
      ignition_on,
      latitude,
      longitude,
      odometer_km
    FROM telemetry
    WHERE vehicle_id = ${vehicleId}
      AND customer_id = ${customerId}
      AND recorded_at BETWEEN ${start.toISOString()}::timestamp AND ${end.toISOString()}::timestamp
    ORDER BY recorded_at ASC
    LIMIT ${MAX_READINGS}
  `);

  return { start, end, center, rows: result.rows ?? [] };
}

function downsampleReadings(rows: SerializedReading[]): SerializedReading[] {
  if (rows.length <= 120) return rows;
  const step = Math.ceil(rows.length / 120);
  const sampled = rows.filter((_, index) => index % step === 0);
  const last = rows[rows.length - 1];
  if (sampled[sampled.length - 1]?.recorded_at !== last?.recorded_at) {
    sampled.push(last);
  }
  return sampled;
}

function serializeReading(row: RawRow): SerializedReading {
  return {
    recorded_at: row.recorded_at,
    fuel_level_liters:
      row.fuel_level_liters != null ? Number(row.fuel_level_liters) : null,
    speed_kph: row.speed_kph != null ? Number(row.speed_kph) : 0,
    ignition_on: Boolean(row.ignition_on),
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    odometer_km: row.odometer_km != null ? Number(row.odometer_km) : null,
  };
}

/**
 * The reading closest in time to `targetTime`, preferring one with a GPS fix.
 *
 * A manoeuvre matched to a fix-less reading can never be drawn — the track is
 * a polyline of coordinates, and the frontend's index remap silently drops
 * anything that lands on a point with no lat/lng (see `indexInPath` in
 * EventReplayPanel.tsx). That produced a "harsh cornering" flag with a
 * correct description and magnitude but no orange segment anywhere on the
 * map: the event was real, only its position was unpaintable. Snapping to
 * the nearest fixed reading instead keeps the claim visible, at the cost of
 * being off by at most a reading or two.
 */
export function findClosestIndex(
  readings: SerializedReading[],
  targetTime: unknown,
): number {
  if (!readings.length) return 0;
  const target = new Date(targetTime as string).getTime();

  const closest = (candidates: SerializedReading[]): { index: number; diff: number } => {
    let best = 0;
    let bestDiff = Infinity;
    candidates.forEach((row, index) => {
      const diff = Math.abs(new Date(row.recorded_at as string).getTime() - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = index;
      }
    });
    return { index: best, diff: bestDiff };
  };

  const fixedIndices = readings
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.latitude != null && row.longitude != null);

  if (fixedIndices.length) {
    const { index } = closest(fixedIndices.map(({ row }) => row));
    return fixedIndices[index].index;
  }

  return closest(readings).index;
}

function findSteepestDropIndex(readings: SerializedReading[]): number {
  let bestIndex = 0;
  let bestDrop = 0;
  for (let i = 1; i < readings.length; i += 1) {
    const prev = readings[i - 1].fuel_level_liters;
    const curr = readings[i].fuel_level_liters;
    if (prev == null || curr == null) continue;
    const drop = prev - curr;
    if (drop > bestDrop) {
      bestDrop = drop;
      bestIndex = i;
    }
  }
  return bestDrop > 0
    ? bestIndex
    : findClosestIndex(
        readings,
        readings[Math.floor(readings.length / 2)]?.recorded_at,
      );
}

function formatTimeLabel(iso: unknown): string {
  try {
    return new Date(iso as string).toLocaleTimeString('en-NG', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Africa/Lagos',
    });
  } catch {
    return '';
  }
}

function buildMoments(
  readings: SerializedReading[],
  anomalyIndex: number,
): unknown[] {
  const moments: unknown[] = [];
  for (let i = 1; i < readings.length; i += 1) {
    const prev = readings[i - 1];
    const curr = readings[i];
    if (prev.fuel_level_liters == null || curr.fuel_level_liters == null)
      continue;

    const delta = curr.fuel_level_liters - prev.fuel_level_liters;
    const drop = prev.fuel_level_liters - curr.fuel_level_liters;

    if (drop >= 3) {
      moments.push({
        index: i,
        type: 'fuel_drop',
        recorded_at: curr.recorded_at,
        fuel_drop_liters: Math.round(drop * 10) / 10,
        fuel_before: prev.fuel_level_liters,
        fuel_after: curr.fuel_level_liters,
        latitude: curr.latitude,
        longitude: curr.longitude,
        speed_kph: curr.speed_kph,
        ignition_on: curr.ignition_on,
        label: `Fuel dropped ${drop.toFixed(1)}L at ${formatTimeLabel(curr.recorded_at)}`,
      });
    } else if (delta >= 5) {
      moments.push({
        index: i,
        type: 'fuel_rise',
        recorded_at: curr.recorded_at,
        fuel_rise_liters: Math.round(delta * 10) / 10,
        fuel_before: prev.fuel_level_liters,
        fuel_after: curr.fuel_level_liters,
        latitude: curr.latitude,
        longitude: curr.longitude,
        speed_kph: curr.speed_kph,
        ignition_on: curr.ignition_on,
        label: `Refuel detected +${delta.toFixed(1)}L at ${formatTimeLabel(curr.recorded_at)}`,
      });
    }

    if (
      i > 1 &&
      !prev.ignition_on &&
      curr.ignition_on &&
      (curr.speed_kph ?? 0) > 5
    ) {
      moments.push({
        index: i,
        type: 'trip_start',
        recorded_at: curr.recorded_at,
        latitude: curr.latitude,
        longitude: curr.longitude,
        speed_kph: curr.speed_kph,
        ignition_on: true,
        label: `Trip started at ${formatTimeLabel(curr.recorded_at)}`,
      });
    }
  }

  const anomalyReading = readings[anomalyIndex];
  if (anomalyReading) {
    const prev = readings[Math.max(0, anomalyIndex - 1)];
    const drop =
      prev?.fuel_level_liters != null &&
      anomalyReading.fuel_level_liters != null
        ? prev.fuel_level_liters - anomalyReading.fuel_level_liters
        : null;

    moments.push({
      index: anomalyIndex,
      type: 'anomaly',
      recorded_at: anomalyReading.recorded_at,
      fuel_drop_liters:
        drop != null && drop > 0 ? Math.round(drop * 10) / 10 : undefined,
      fuel_before: prev?.fuel_level_liters ?? null,
      fuel_after: anomalyReading.fuel_level_liters,
      latitude: anomalyReading.latitude,
      longitude: anomalyReading.longitude,
      speed_kph: anomalyReading.speed_kph,
      ignition_on: anomalyReading.ignition_on,
      label: `Anomaly detected at ${formatTimeLabel(anomalyReading.recorded_at)}`,
    });
  }

  const byIndex = new Map<number, unknown>();
  for (const m of moments as Array<{ index: number; type: string }>) {
    if (!byIndex.has(m.index) || m.type === 'anomaly') byIndex.set(m.index, m);
  }
  return [...byIndex.values()].sort(
    (a, b) =>
      new Date((a as { recorded_at: string }).recorded_at).getTime() -
      new Date((b as { recorded_at: string }).recorded_at).getTime(),
  );
}

/**
 * The manoeuvre types that get their own colour on the replay track.
 *
 * `overspeeding` joined this list once vehicles gained a `speed_limit_kph`.
 * Before that there was no declared limit anywhere in the app, so a red
 * "speeding" stretch would have been the app inventing fleet policy; now it
 * means measured GPS speed exceeded a limit the fleet actually set.
 */
const TRACK_MANOEUVRES = [
  'harsh_braking',
  'harsh_acceleration',
  'harsh_cornering',
  'overspeeding',
] as const;

interface TrackManoeuvre {
  type: string;
  occurred_at: unknown;
  severity: string;
  magnitude_ms2: number | null;
  speed_kph: number | null;
  /** Nearest reading in the replay, so the map can colour the right segment. */
  index: number;
}

/**
 * The harsh manoeuvres inside a replay window, positioned against its readings.
 *
 * These are the rows `driving-events-sweep.ts` already wrote from the GPS speed
 * and heading series — the same events the driving-behaviour page scores — so
 * the track and the feed can never disagree about what happened.
 *
 * Overspeeding is deliberately not fetched. It can only arrive from the
 * device's own overspeed scenario, which is disabled on this fleet's trackers,
 * and no speed limit is configured anywhere in the app to derive it from. A
 * red "speeding" stretch would be an invention, so the track shows measured
 * speed and lets the manager judge.
 */
async function loadTrackManoeuvres({
  customerId,
  vehicleId,
  rows,
}: {
  customerId: string;
  vehicleId: string;
  rows: SerializedReading[];
}): Promise<TrackManoeuvre[]> {
  if (rows.length < 2) return [];

  const start = rows[0].recorded_at as string;
  const end = rows[rows.length - 1].recorded_at as string;

  const result = await db.execute(sql`
    SELECT event_type, occurred_at, severity, value, unit, speed_kph
    FROM device_events
    WHERE vehicle_id = ${vehicleId}
      AND customer_id = ${customerId}
      AND event_type IN (${sql.join(
        TRACK_MANOEUVRES.map((t) => sql`${t}`),
        sql`, `
      )})
      AND occurred_at BETWEEN ${start}::timestamp AND ${end}::timestamp
    ORDER BY occurred_at ASC
  `);

  return (result.rows ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      type: String(r.event_type),
      occurred_at: r.occurred_at,
      severity: String(r.severity ?? 'warning'),
      magnitude_ms2: r.value != null ? Number(r.value) : null,
      speed_kph: r.speed_kph != null ? Number(r.speed_kph) : null,
      index: findClosestIndex(rows, r.occurred_at),
    };
  });
}

function attachMoments(
  payload: Record<string, unknown>,
  readings: SerializedReading[],
  anomalyIndex: number,
): unknown {
  const moments = buildMoments(readings, anomalyIndex);
  const anomalyMoment =
    (moments as Array<{ type: string } & Record<string, unknown>>).find(
      (m) => m.type === 'anomaly',
    ) ??
    (moments as Array<{ type: string } & Record<string, unknown>>).find(
      (m) => m.type === 'fuel_drop',
    ) ??
    null;
  return { ...payload, moments, anomaly_moment: anomalyMoment };
}

function findMaxDropLiters(rows: SerializedReading[]): number {
  let maxDrop = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1].fuel_level_liters;
    const curr = rows[i].fuel_level_liters;
    if (prev == null || curr == null) continue;
    maxDrop = Math.max(maxDrop, prev - curr);
  }
  return maxDrop;
}

function dropWindowMeta(
  rows: SerializedReading[],
  anomalyIndex: number,
): { drop: number; seconds: number; startIndex: number } {
  const end = rows[anomalyIndex];
  if (!end?.fuel_level_liters)
    return { drop: 0, seconds: 0, startIndex: anomalyIndex };

  let startIndex = anomalyIndex;
  let drop = 0;
  for (let i = anomalyIndex; i > 0; i -= 1) {
    const prev = rows[i - 1];
    const curr = rows[i];
    if (prev.fuel_level_liters == null || curr.fuel_level_liters == null) break;
    const step = prev.fuel_level_liters - curr.fuel_level_liters;
    if (step <= 0.2) break;
    drop += step;
    startIndex = i - 1;
  }
  if (drop <= 0 && anomalyIndex > 0) {
    const prev = rows[anomalyIndex - 1];
    if (prev.fuel_level_liters != null && end.fuel_level_liters != null) {
      drop = Math.max(0, prev.fuel_level_liters - end.fuel_level_liters);
      startIndex = anomalyIndex - 1;
    }
  }

  const start = rows[startIndex];
  const seconds =
    start && end
      ? Math.max(
          1,
          Math.round(
            (new Date(end.recorded_at as string).getTime() -
              new Date(start.recorded_at as string).getTime()) /
              1000,
          ),
        )
      : 0;
  return { drop, seconds, startIndex };
}

interface EnrichAnomalyParams {
  rows: SerializedReading[];
  anomalyIndex: number;
  reasons: string[];
  drop: number;
  dropSeconds: number;
  ignitionOff: boolean;
  eventType: string;
}

/**
 * The supporting detail under a flag.
 *
 * Everything here is now read off the rows in the replay window. The previous
 * version asserted "Stable OBD fuel readings in replay window" on every flag,
 * which was false twice over: this fleet's FMC150 sends no OBD or CAN element
 * at all, and the tank level shown is modelled from distance and idle time
 * rather than sensed. It also drew a rising certainty curve — 45%, 75%, final —
 * out of arithmetic on the final score, so a manager watched confidence
 * "accumulate" through numbers that were never computed from evidence.
 *
 * A factor that cannot be checked against a reading is not listed.
 */
function enrichAnomalyFields({
  rows,
  anomalyIndex,
  reasons,
  drop,
  dropSeconds,
  ignitionOff,
  eventType,
}: EnrichAnomalyParams): Record<string, unknown> {
  const durLabel =
    dropSeconds >= 60
      ? `${Math.round(dropSeconds / 60)} min`
      : `${dropSeconds} second${dropSeconds === 1 ? '' : 's'}`;

  const { startIndex } = dropWindowMeta(rows, anomalyIndex);
  const window = rows.slice(startIndex, anomalyIndex + 1);
  const stationary = window.length > 0 && window.every((r) => (r.speed_kph ?? 0) === 0);
  const refuelInWindow = rows.some((row, i) => {
    if (i === 0) return false;
    const prev = rows[i - 1].fuel_level_liters;
    const curr = row.fuel_level_liters;
    return prev != null && curr != null && curr - prev >= 5;
  });

  let primary_explanation = `Modelled tank level fell ${drop.toFixed(1)}L within ${durLabel} while ignition ${ignitionOff ? 'OFF' : 'ON'}`;

  const confidence_factors: string[] = [
    `${window.length} GPS fix${window.length === 1 ? '' : 'es'} across the drop window`,
  ];
  if (ignitionOff) confidence_factors.push('Ignition logged OFF for the whole drop');
  if (stationary) confidence_factors.push('Vehicle stationary throughout (0 km/h)');
  if (!refuelInWindow) confidence_factors.push('No refuel of 5L or more in this window');

  const recommended_actions = [
    'Walk through the replay before deciding',
    'Verify fuel receipts for this vehicle on the same day',
    'Contact assigned driver for operational context',
  ];

  if (eventType === 'receipt_fraud') {
    primary_explanation = reasons[0] ?? primary_explanation;
    confidence_factors.length = 0;
    confidence_factors.push(
      'Receipt timestamp falls inside the telemetry window',
      'Modelled tank rise is smaller than the declared volume',
    );
    recommended_actions.length = 0;
    recommended_actions.push(
      'Verify fuel receipt and station timestamp',
      'Compare declared litres against the tank curve',
      'Contact assigned driver for context',
    );
  }

  return {
    primary_explanation,
    why_flagged: [
      primary_explanation,
      ...reasons.slice(0, 4),
      'Investigation assist — not a final accusation',
    ],
    confidence_factors,
    recommended_actions,
  };
}

async function buildSiphonReplay(
  customerId: string,
  event: Record<string, unknown>,
  rawRows: RawRow[],
): Promise<unknown> {
  const before = Number(event.fuel_level_before) || 0;
  const after = Number(event.fuel_level_after) || 0;

  // No synthetic rows. This used to manufacture six evenly spaced readings when
  // the window was thin, then draw them on a map captioned "GPS TRACE" — a
  // trace of positions the vehicle was never recorded at. A sparse window is a
  // fact about the evidence and the panel says so instead.
  const rows = downsampleReadings(rawRows.map(serializeReading));

  const reasons: string[] = [];
  let confidence = 68;

  if (!event.engine_state_before && !event.engine_state_after) {
    reasons.push('Vehicle stationary (ignition off)');
    confidence += 8;
  }
  reasons.push('No refuel event detected');
  confidence += 6;

  const drop =
    Number(event.liters_stolen) ||
    Math.max(0, before - after) ||
    findMaxDropLiters(rows);

  if (drop >= 5) {
    reasons.push(`Sharp fuel decrease (−${drop.toFixed(1)}L)`);
    confidence += 8;
  }
  if (
    event.parked_duration_minutes &&
    Number(event.parked_duration_minutes) >= 30
  ) {
    reasons.push(`Parked ${event.parked_duration_minutes} min before drop`);
    confidence += 5;
  } else if (!event.engine_state_before) {
    reasons.push('Engine off during fuel loss window');
    confidence += 4;
  }

  const anomalyIndex =
    rows.length > 1
      ? findSteepestDropIndex(rows)
      : findClosestIndex(rows, event.occurred_at);

  const confidencePercent = Math.min(Math.round(confidence), 96);
  const { seconds: dropSeconds } = dropWindowMeta(rows, anomalyIndex);
  const ignitionOff = !event.engine_state_before && !event.engine_state_after;
  const enriched = enrichAnomalyFields({
    rows,
    anomalyIndex,
    reasons,
    drop,
    dropSeconds,
    ignitionOff: Boolean(ignitionOff),
    eventType: 'siphon',
  });

  // A loss already priced when the event was recorded keeps that valuation;
  // otherwise it is valued at the rate in force the moment it happened.
  const recorded = Number(event.estimated_loss_ngn);
  const valuation = recorded
    ? { estimated_loss_ngn: recorded, price_ngn_per_liter: null, price_source: null }
    : await valueLiters(customerId, event.occurred_at as string, drop);

  return attachMoments(
    {
      event_type: 'siphon',
      vehicle_plate: event.vehicle_plate,
      driver_name: event.driver_name,
      vehicle_id: event.vehicle_id,
      range_start: rows[0]?.recorded_at ?? event.occurred_at,
      range_end: rows[rows.length - 1]?.recorded_at ?? event.occurred_at,
      anomaly_at: rows[anomalyIndex]?.recorded_at ?? event.occurred_at,
      anomaly_index: anomalyIndex,
      location_name: event.location_name,
      readings: rows,
      manoeuvres: await loadTrackManoeuvres({
        customerId,
        vehicleId: event.vehicle_id as string,
        rows,
      }),
      anomaly: {
        type: 'Possible fuel anomaly',
        liters_lost: drop,
        confidence_percent: confidencePercent,
        reasons,
        ...valuation,
        ...enriched,
      },
    },
    rows,
    anomalyIndex,
  );
}

async function buildReceiptReplay(
  customerId: string,
  receipt: Record<string, unknown>,
  rawRows: RawRow[],
): Promise<unknown> {
  const declared = Number(receipt.declared_liters) || 0;
  const actual =
    receipt.obd_liters_actual != null
      ? Number(receipt.obd_liters_actual)
      : null;
  const diff =
    receipt.difference_liters != null
      ? Number(receipt.difference_liters)
      : declared - (actual ?? 0);
  const rows = downsampleReadings(rawRows.map(serializeReading));

  // "OBD sensor recorded only 30L" was never true — this fleet's FMC150 sends
  // no OBD or CAN element, and the comparison is against a tank level modelled
  // from distance and idle time. Naming the real source lets a manager judge
  // how much weight the mismatch deserves.
  const reasons = [
    `Receipt claimed ${declared.toFixed(1)}L at ${receipt.merchant_name || 'station'}`,
  ];
  if (actual != null) {
    reasons.push(`Modelled tank rose by only ${actual.toFixed(1)}L over the same window`);
    reasons.push(`Discrepancy of ${diff.toFixed(1)}L exceeds review threshold`);
  } else {
    reasons.push('No tank rise could be matched to this receipt');
  }

  const anomalyIndex = findClosestIndex(rows, receipt.transaction_date);
  const confidencePercent =
    actual != null ? Math.min(88 + Math.min(diff / 2, 8), 97) : 72;
  const primary =
    actual != null
      ? `Receipt claimed ${declared.toFixed(1)}L but the tank rose ${actual.toFixed(1)}L in the refuel window`
      : `Receipt could not be matched to any tank rise`;
  const enriched = enrichAnomalyFields({
    rows,
    anomalyIndex,
    reasons: [primary, ...reasons.slice(1)],
    drop: Math.max(0, diff),
    dropSeconds: 60,
    ignitionOff: false,
    eventType: 'receipt_fraud',
  });

  // The receipt's own price is what the driver actually paid at that pump on
  // that day — better evidence than any fleet-wide rate, so it wins. Only when
  // the receipt carries no price does the fleet's effective-dated benchmark
  // stand in, and the shortfall is valued at the rate that applied then rather
  // than at a flat constant.
  const receiptPrice = Number(receipt.price_per_liter);
  const shortfall = Math.max(0, diff);
  const valuation = receiptPrice
    ? {
        estimated_loss_ngn: Math.round(shortfall * receiptPrice),
        price_ngn_per_liter: receiptPrice,
        price_source: 'receipt' as const,
      }
    : await valueLiters(customerId, receipt.transaction_date as string, shortfall);

  return attachMoments(
    {
      event_type: 'receipt_fraud',
      vehicle_plate: receipt.vehicle_plate,
      driver_name: receipt.driver_name,
      vehicle_id: receipt.vehicle_id,
      range_start: rows[0]?.recorded_at ?? receipt.transaction_date,
      range_end: rows[rows.length - 1]?.recorded_at ?? receipt.transaction_date,
      anomaly_at: rows[anomalyIndex]?.recorded_at ?? receipt.transaction_date,
      anomaly_index: anomalyIndex,
      location_name: receipt.merchant_name,
      readings: rows,
      anomaly: {
        type: 'Receipt vs tank mismatch',
        liters_lost: Math.max(0, diff),
        confidence_percent: confidencePercent,
        reasons,
        declared_liters: declared,
        obd_liters_actual: actual,
        ...valuation,
        ...enriched,
      },
    },
    rows,
    anomalyIndex,
  );
}

/**
 * The day's readings, or the minutes around one moment of it.
 *
 * `LIMIT` with `ORDER BY recorded_at ASC` takes the *earliest* readings of the
 * day. On a day with 1,700 fixes that is the first 25 minutes, so an event in
 * the afternoon was never loaded: the focus filter found nothing near it, fell
 * back to the whole (truncated) set, and the replay opened on the morning while
 * captioning it "harsh cornering at this point". Clicking Replay on a 15:44
 * event produced a window ending at 12:00 with no cornering in it — evidence
 * for the wrong moment, which is worse than no evidence.
 *
 * When a focus instant is given the window is applied in SQL, so the rows that
 * come back are the ones either side of the event rather than the head of the
 * day.
 */
async function loadTelemetryDay({
  vehicleId,
  customerId,
  activityDate,
  focusAt,
  windowMinutes,
}: {
  vehicleId: string;
  customerId: string;
  activityDate: string;
  focusAt?: string;
  windowMinutes?: number;
}) {
  const focusWindow =
    focusAt && Number.isFinite(parseInstant(focusAt))
      ? sql`AND recorded_at BETWEEN
              ${new Date(parseInstant(focusAt))}::timestamp - (${windowMinutes ?? 5} || ' minutes')::INTERVAL
          AND ${new Date(parseInstant(focusAt))}::timestamp + (${windowMinutes ?? 5} || ' minutes')::INTERVAL`
      : sql``;

  const result = await db.execute(sql`
    SELECT
      recorded_at,
      fuel_level_liters,
      speed_kph,
      ignition_on,
      latitude,
      longitude,
      odometer_km
    FROM telemetry
    WHERE vehicle_id = ${vehicleId}
      AND customer_id = ${customerId}
      AND DATE(recorded_at AT TIME ZONE 'Africa/Lagos') = ${activityDate}::date
      ${focusWindow}
    ORDER BY recorded_at ASC
    LIMIT ${MAX_READINGS}
  `);
  return result.rows ?? [];
}

async function buildDailyReplay({
  customerId,
  vehicle,
  rawRows,
  flagType,
  focused = false,
}: {
  customerId: string;
  vehicle: Record<string, unknown>;
  rawRows: RawRow[];
  flagType: string;
  /** True when the window is already centred on a specific manoeuvre. */
  focused?: boolean;
}): Promise<unknown | null> {
  const rows = downsampleReadings(rawRows.map(serializeReading));
  if (!rows.length) return null;

  const anomalyIndex = findSteepestDropIndex(rows);
  const anomalyReading = rows[anomalyIndex];
  const prev = rows[Math.max(0, anomalyIndex - 1)];
  const drop =
    prev?.fuel_level_liters != null && anomalyReading?.fuel_level_liters != null
      ? Math.max(0, prev.fuel_level_liters - anomalyReading.fuel_level_liters)
      : 0;

  const eventType =
    flagType === 'data_anomaly'
      ? 'data_anomaly'
      : flagType === 'low_efficiency' || flagType === 'high_fuel_per_km'
        ? 'low_efficiency'
        : MANOEUVRE_REASON[flagType]
          ? flagType
          : 'daily_flag';

  const manoeuvres = await loadTrackManoeuvres({
    customerId,
    vehicleId: vehicle.vehicle_id as string,
    rows,
  });

  const reasons: string[] = [];
  // A focused replay is about the manoeuvre itself, so it says how the
  // manoeuvre was found rather than talking about the day around it.
  if (MANOEUVRE_REASON[flagType]) {
    reasons.push(MANOEUVRE_REASON[flagType]);

    // The measured force, when this window contains the manoeuvre it was
    // opened for. "Harsh braking" alone gives a manager nothing to weigh — a
    // 3.1 m/s² stop in traffic and a 6 m/s² emergency stop are not the same
    // conversation with a driver.
    const match = manoeuvres.find((m) => m.type === flagType && m.magnitude_ms2 != null);
    if (match) {
      reasons.push(
        flagType === 'overspeeding'
          ? `Peak ${Math.round(match.magnitude_ms2!)} km/h`
          : `Peak ${match.magnitude_ms2!.toFixed(1)} m/s² (${(match.magnitude_ms2! / 9.81).toFixed(2)} g)` +
              (match.speed_kph != null ? ` at ${match.speed_kph} km/h` : '')
      );
    }

    reasons.push(
      `Speed and position either side of the event, ±${FOCUS_WINDOW_MINUTES} minutes`
    );
  }
  if (drop >= 3)
    reasons.push(`Largest fuel drop this day: −${drop.toFixed(1)}L`);
  if (flagType === 'data_anomaly')
    reasons.push('Fuel/distance ratio inconsistent with normal trips');
  if (flagType === 'low_efficiency')
    reasons.push('Daily consumption above vehicle baseline');
  if (!reasons.length)
    reasons.push(
      focused
        ? 'Telemetry around the reported moment'
        : 'Review full-day telemetry for operational waste'
    );

  // Where this actually happened, spelled out — a manager staring at a dashed
  // pin on a map still has to work out what street that pin is on. Best
  // effort: a resolver outage must never fail the replay itself.
  //
  // The anomaly row itself is picked for its fuel-drop, not its GPS quality,
  // so it can land on a reading between fixes with no coordinate at all —
  // the nearest reading either side that does have one is close enough for
  // "roughly where this was" and beats showing nothing.
  const fixNear = (index: number): { latitude: number; longitude: number } | null => {
    for (let offset = 0; offset < rows.length; offset += 1) {
      const before = rows[index - offset];
      if (before?.latitude != null && before?.longitude != null) {
        return { latitude: before.latitude, longitude: before.longitude };
      }
      const after = rows[index + offset];
      if (after?.latitude != null && after?.longitude != null) {
        return { latitude: after.latitude, longitude: after.longitude };
      }
    }
    return null;
  };
  const anomalyFix = fixNear(anomalyIndex);
  const locationName = anomalyFix
    ? await lookupPlace(anomalyFix.latitude, anomalyFix.longitude)
        .then((place) => place.formatted_address || place.place_name)
        .catch(() => null)
    : null;

  return attachMoments(
    {
      event_type: eventType,
      vehicle_plate: vehicle.license_plate,
      driver_name: vehicle.driver_name,
      vehicle_id: vehicle.vehicle_id,
      range_start: rows[0].recorded_at,
      range_end: rows[rows.length - 1].recorded_at,
      anomaly_at: anomalyReading?.recorded_at ?? rows[0].recorded_at,
      anomaly_index: anomalyIndex,
      location_name: locationName,
      readings: rows,
      manoeuvres,
      // Lets the track shade its own overspeed stretches from the speeds it is
      // already drawing. Null when the fleet has set no limit, and the track
      // then makes no claim about speeding at all.
      speed_limit_kph:
        vehicle.speed_limit_kph != null ? Number(vehicle.speed_limit_kph) : null,
      anomaly: {
        type:
          eventType === 'data_anomaly'
            ? 'Data anomaly'
            : eventType === 'low_efficiency'
              ? 'Low efficiency day'
              : 'Daily flag review',
        liters_lost: drop,
        ...(await valueLiters(
          customerId,
          (anomalyReading?.recorded_at ?? rows[0].recorded_at) as string,
          drop,
        )),
        confidence_percent: drop >= 5 ? 82 : 68,
        reasons,
      },
    },
    rows,
    anomalyIndex,
  );
}

export async function buildDailyActivityReplay({
  customerId,
  vehicleId,
  activityDate,
  flagType,
  focusAt,
}: {
  customerId: string;
  vehicleId: string;
  activityDate: string;
  flagType: string;
  /** Centre the replay on one moment — a harsh brake is a second, not a day. */
  focusAt?: string;
}): Promise<unknown | null> {
  const vehicleResult = await db.execute(sql`
    SELECT v.id AS vehicle_id, v.license_plate, v.model, v.speed_limit_kph,
      COALESCE(dr.full_name, v.driver_name) AS driver_name
    FROM vehicles v
    LEFT JOIN drivers dr ON dr.id = v.driver_id
    WHERE v.id = ${vehicleId} AND v.customer_id = ${customerId}
    LIMIT 1
  `);
  const vehicle = vehicleResult.rows[0] as Record<string, unknown> | undefined;
  if (!vehicle) return null;

  // A focused replay is about one manoeuvre, so a siphon elsewhere that day is
  // not what the user asked to see.
  if (!focusAt) {
    const siphonResult = await db.execute(sql`
      SELECT id FROM siphon_events
      WHERE vehicle_id = ${vehicleId}
        AND customer_id = ${customerId}
        AND DATE(occurred_at AT TIME ZONE 'Africa/Lagos') = ${activityDate}::date
      ORDER BY occurred_at DESC
      LIMIT 1
    `);
    if ((siphonResult.rows[0] as { id?: string } | undefined)?.id) {
      return buildSiphonEventReplay({
        customerId,
        eventId: (siphonResult.rows[0] as { id: string }).id,
      });
    }
  }

  const rows = (await loadTelemetryDay({
    vehicleId,
    customerId,
    activityDate,
    focusAt,
    windowMinutes: FOCUS_WINDOW_MINUTES,
  })) as RawRow[];

  // Narrow to the minutes either side of the event. Wide enough to show the
  // approach and the recovery, tight enough that the manoeuvre is the subject.
  let focused = rows;
  if (focusAt) {
    const centre = parseInstant(focusAt);
    if (Number.isFinite(centre)) {
      const window = FOCUS_WINDOW_MINUTES * 60_000;
      const near = rows.filter((r) => {
        const t = parseInstant(r.recorded_at as string | Date);
        return Math.abs(t - centre) <= window;
      });
      // Fall back to the whole day rather than showing an empty replay.
      if (near.length >= 2) focused = near;
    }
  }

  return buildDailyReplay({
    customerId,
    vehicle,
    rawRows: focused,
    flagType,
    focused: !!focusAt,
  });
}

/** Minutes either side of a focused event that the replay covers. */
const FOCUS_WINDOW_MINUTES = 5;

/**
 * Timestamps reach us in two shapes: a Date from pg, and a timezone-less string
 * like "2026-08-07 18:19:35" once it has been through JSON and back from the
 * browser. `new Date` reads the second as *server-local*, which silently shifted
 * the focus window by the host's UTC offset and made it miss the event
 * entirely. Everything stored is UTC, so say so.
 */
function parseInstant(value: string | Date): number {
  if (value instanceof Date) return value.getTime();
  const text = String(value).trim();
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text);
  const normalized = hasZone ? text : `${text.replace(' ', 'T')}Z`;
  return new Date(normalized).getTime();
}

/**
 * Where a manoeuvre flag actually came from.
 *
 * These previously all read "Tracker reported harsh cornering at this point",
 * which credited the device with a judgement it never made: this fleet's
 * FMC150 has its Eco/Green Driving scenario switched off and has never emitted
 * event 253, 255 or any other scenario ID. The three harsh types are computed
 * here from the GPS speed and heading series (see `harsh-driving.ts`) — a real
 * derivation, but a derivation, and a manager weighing an accusation against a
 * driver deserves to know which.
 *
 * Crash and overspeeding are left attributed to the device because that is the
 * only way they can arrive; until those scenarios are enabled in the Teltonika
 * Configurator they simply never appear.
 */
const MANOEUVRE_REASON: Record<string, string> = {
  harsh_braking: 'Harsh braking, derived from the GPS speed trace at this point',
  harsh_acceleration: 'Harsh acceleration, derived from the GPS speed trace at this point',
  harsh_cornering: 'Harsh cornering, derived from GPS speed and heading change at this point',
  overspeeding: 'Measured GPS speed held above the limit set for this vehicle',
  crash: 'Tracker reported a crash-level impact',
};

export async function buildSiphonEventReplay({
  customerId,
  eventId,
}: {
  customerId: string;
  eventId: string;
}): Promise<unknown | null> {
  const result = await db.execute(sql`
    SELECT
      s.id,
      s.vehicle_id,
      s.occurred_at,
      s.liters_stolen,
      s.estimated_loss_ngn,
      s.fuel_level_before,
      s.fuel_level_after,
      s.engine_state_before,
      s.engine_state_after,
      s.parked_duration_minutes,
      s.latitude,
      s.longitude,
      s.location_name,
      v.license_plate AS vehicle_plate,
      dr.full_name AS driver_name
    FROM siphon_events s
    JOIN vehicles v ON v.id = s.vehicle_id
    LEFT JOIN drivers dr ON dr.id = s.driver_id
    WHERE s.id = ${eventId} AND s.customer_id = ${customerId}
    LIMIT 1
  `);

  const event = result.rows[0] as Record<string, unknown> | undefined;
  if (!event) return null;

  const { rows } = await loadTelemetryWindow({
    vehicleId: event.vehicle_id as string,
    customerId,
    centerTime: event.occurred_at as string,
  });

  return buildSiphonReplay(customerId, event, rows as RawRow[]);
}

export async function buildReceiptEventReplay({
  customerId,
  receiptId,
}: {
  customerId: string;
  receiptId: string;
}): Promise<unknown | null> {
  const result = await db.execute(sql`
    SELECT
      r.id,
      r.vehicle_id,
      r.transaction_date,
      r.merchant_name,
      r.declared_liters,
      r.obd_liters_actual,
      r.difference_liters,
      r.price_per_liter,
      r.receipt_latitude,
      r.receipt_longitude,
      v.license_plate AS vehicle_plate,
      dr.full_name AS driver_name
    FROM fuel_receipts r
    JOIN vehicles v ON v.id = r.vehicle_id
    JOIN drivers dr ON dr.id = r.driver_id
    WHERE r.id = ${receiptId} AND r.customer_id = ${customerId}
    LIMIT 1
  `);

  const receipt = result.rows[0] as Record<string, unknown> | undefined;
  if (!receipt) return null;

  const { rows } = await loadTelemetryWindow({
    vehicleId: receipt.vehicle_id as string,
    customerId,
    centerTime: receipt.transaction_date as string,
  });

  return buildReceiptReplay(customerId, receipt, rows as RawRow[]);
}
