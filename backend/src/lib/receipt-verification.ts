// Verifying a fuel receipt against what the tracker can actually prove.
//
// The older path compared declared litres against a "measured" refuel volume,
// which only exists on a vehicle with a tank-level sensor or a CAN adapter.
// Ours has neither: every telemetry row is a modelled level, and the only
// thing that raises it is a receipt being credited. Checking a receipt against
// that number checks the receipt against itself, so every receipt stayed
// pending forever.
//
// What the FMC150 does prove, without any new hardware:
//
//   1. Where the vehicle was when the receipt says it was fuelling.
//   2. Whether the claimed volume could physically fit in the tank.
//   3. Whether litres bought over time track litres burned.
//
// (1) and (2) can fail — they decide the status. (3) informs the manager but
// never flags on its own: the burn figure comes from AVL 12, which is known to
// under-report on this fleet, so it is evidence to read, not to convict on.
import { db, sql } from './db-helpers';
import { DEFAULT_FUEL_PRICE_NGN_LITER } from './fuel-metrics';
import { lookupPlace, nearbyFuelStation, staticMapPath } from './place-lookup';

/** A fix this close to the receipt's coordinates puts the vehicle on the forecourt. */
const AT_STATION_METERS = 500;

/** Beyond this the vehicle was somewhere else entirely when the receipt was issued. */
const ELSEWHERE_METERS = 3000;

/** How far from the purchase time to look for a position fix. Parked with the
 *  ignition off the device reports rarely, so this is deliberately generous. */
const FIX_WINDOW_MINUTES = 90;

/** Slack on the tank check: modelled level carries error, and a driver can
 *  legitimately fill a tank the model thinks is fuller than it is. */
const TANK_TOLERANCE = 1.15;

export type CheckOutcome = 'pass' | 'fail' | 'unknown';

export interface ReceiptCheck {
  code: 'vehicle_present' | 'volume_fits_tank' | 'bought_vs_burned';
  label: string;
  outcome: CheckOutcome;
  /** One sentence a fleet manager can act on, with the numbers in it. */
  detail: string;
}

/** Imagery of the place a receipt claims, so a manager can look at it. */
export interface StationEvidence {
  /** Google's name for the place, which may differ from what the driver typed. */
  placeName: string | null;
  formattedAddress: string | null;
  /** Proxied through our API — the Google key never reaches the browser. */
  photoUrl: string | null;
  imageKind: 'street_view' | 'place_photo' | 'map' | null;
  streetViewDate: string | null;
  /** Where the imagery was taken from: the receipt's pin or the tracker's fix. */
  source: 'receipt' | 'tracker';
}

export interface ReceiptVerification {
  /** Kept to the values the rest of the app already understands. */
  status: 'matched' | 'pending' | 'flagged_theft';
  checks: ReceiptCheck[];
  summary: string;
  station: StationEvidence | null;
  distanceMeters: number | null;
  nearestFixAt: string | null;
  tankLevelBeforeLiters: number | null;
  headroomLiters: number | null;
  overclaimedLiters: number | null;
  estimatedLossNgn: number;
  verifiedAt: string;
}

export interface VerifyReceiptParams {
  vehicleId: string;
  customerId: string;
  transactionDate: Date;
  declaredLiters: number;
  pricePerLiter?: number | null;
  receiptLatitude?: number | string | null;
  receiptLongitude?: number | string | null;
  tankCapacityLiters?: number | null;
  /** Excluded from the bought-vs-burned window when re-verifying a stored row. */
  receiptId?: string | null;
}

const toNumber = (value: unknown): number | null => {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Metres between two coordinates. Haversine — flat-earth maths is off by
 *  enough at Nigerian latitudes to matter at the 500 m decision boundary. */
export function distanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

const minutesBetween = (a: Date, b: Date): number =>
  Math.round(Math.abs(a.getTime() - b.getTime()) / 60000);

export interface Evidence {
  fix: { at: Date; latitude: number; longitude: number } | null;
  /** A stop the detector matched to a filling station near this purchase. */
  fuelStop: { at: Date; minutes: number | null } | null;
  levelBefore: number | null;
  litersBurnedSincePrevious: number | null;
  litersBoughtSincePrevious: number | null;
  previousReceiptAt: Date | null;
}

async function gatherEvidence(params: VerifyReceiptParams): Promise<Evidence> {
  const { vehicleId, customerId, transactionDate: when } = params;

  // Nearest position fix either side of the purchase. A vehicle parked at a
  // pump with the ignition off may not report until it pulls away, so the
  // closest fix in time is the right one to compare against — not the last.
  const fixResult = await db.execute(sql`
    SELECT recorded_at, latitude, longitude
    FROM telemetry
    WHERE vehicle_id = ${vehicleId}
      AND customer_id = ${customerId}
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL
      AND recorded_at BETWEEN ${when}::timestamp - (${FIX_WINDOW_MINUTES} || ' minutes')::INTERVAL
        AND ${when}::timestamp + (${FIX_WINDOW_MINUTES} || ' minutes')::INTERVAL
    ORDER BY ABS(EXTRACT(EPOCH FROM (recorded_at - ${when}::timestamp)))
    LIMIT 1
  `);

  const fixRow = fixResult.rows[0] as Record<string, unknown> | undefined;
  const fixLat = toNumber(fixRow?.latitude);
  const fixLng = toNumber(fixRow?.longitude);

  // Independent corroboration: the vehicle stood on a forecourt around this
  // time. Carries the receipt on its own when the phone recorded no GPS.
  const stopResult = await db.execute(sql`
    SELECT occurred_at, value
    FROM device_events
    WHERE vehicle_id = ${vehicleId}
      AND customer_id = ${customerId}
      AND event_type = 'fuel_stop'
      AND occurred_at BETWEEN ${when}::timestamp - (${FIX_WINDOW_MINUTES} || ' minutes')::INTERVAL
        AND ${when}::timestamp + (${FIX_WINDOW_MINUTES} || ' minutes')::INTERVAL
    ORDER BY ABS(EXTRACT(EPOCH FROM (occurred_at - ${when}::timestamp)))
    LIMIT 1
  `);
  const stopRow = stopResult.rows[0] as Record<string, unknown> | undefined;

  // Modelled level immediately before the fill — what the tank had room for.
  const levelResult = await db.execute(sql`
    SELECT fuel_level_liters
    FROM telemetry
    WHERE vehicle_id = ${vehicleId}
      AND customer_id = ${customerId}
      AND fuel_level_liters IS NOT NULL
      AND recorded_at <= ${when}
    ORDER BY recorded_at DESC
    LIMIT 1
  `);

  // The fill before this one bounds the window for the burn comparison.
  const previousResult = await db.execute(sql`
    SELECT transaction_date
    FROM fuel_receipts
    WHERE vehicle_id = ${vehicleId}
      AND customer_id = ${customerId}
      AND transaction_date < ${when}
    ORDER BY transaction_date DESC
    LIMIT 1
  `);

  const previousAt = (previousResult.rows[0] as Record<string, unknown> | undefined)
    ?.transaction_date;
  const previousReceiptAt = previousAt ? new Date(previousAt as string) : null;

  let litersBurned: number | null = null;
  let litersBought: number | null = null;

  if (previousReceiptAt) {
    // Positive deltas only: AVL 12 is an accumulator that resets to zero when
    // the device loses power, and a reset must not read as a negative burn.
    const burnResult = await db.execute(sql`
      WITH readings AS (
        SELECT
          fuel_used_gps_ml,
          LAG(fuel_used_gps_ml) OVER (ORDER BY recorded_at) AS prev_ml
        FROM telemetry
        WHERE vehicle_id = ${vehicleId}
          AND customer_id = ${customerId}
          AND fuel_used_gps_ml IS NOT NULL
          AND recorded_at BETWEEN ${previousReceiptAt} AND ${when}
      )
      SELECT COALESCE(SUM(fuel_used_gps_ml - prev_ml), 0) AS burned_ml
      FROM readings
      WHERE prev_ml IS NOT NULL AND fuel_used_gps_ml >= prev_ml
    `);

    const burnedMl = toNumber((burnResult.rows[0] as Record<string, unknown>)?.burned_ml);
    litersBurned = burnedMl != null ? Math.round((burnedMl / 1000) * 10) / 10 : null;

    const boughtResult = await db.execute(sql`
      SELECT COALESCE(SUM(declared_liters), 0) AS bought
      FROM fuel_receipts
      WHERE vehicle_id = ${vehicleId}
        AND customer_id = ${customerId}
        AND transaction_date > ${previousReceiptAt}
        AND transaction_date <= ${when}
        ${params.receiptId ? sql`AND id <> ${params.receiptId}` : sql``}
    `);

    const bought = toNumber((boughtResult.rows[0] as Record<string, unknown>)?.bought) ?? 0;
    litersBought = Math.round((bought + params.declaredLiters) * 10) / 10;
  }

  return {
    fix:
      fixRow && fixLat != null && fixLng != null
        ? {
            at: new Date(fixRow.recorded_at as string),
            latitude: fixLat,
            longitude: fixLng,
          }
        : null,
    fuelStop: stopRow
      ? { at: new Date(stopRow.occurred_at as string), minutes: toNumber(stopRow.value) }
      : null,
    levelBefore: toNumber((levelResult.rows[0] as Record<string, unknown>)?.fuel_level_liters),
    litersBurnedSincePrevious: litersBurned,
    litersBoughtSincePrevious: litersBought,
    previousReceiptAt,
  };
}

/**
 * Decide a receipt's standing from the evidence. Pure, so the thresholds and
 * the wording can be tested without a database.
 */
export function decideVerification(
  params: VerifyReceiptParams,
  evidence: Evidence
): ReceiptVerification {
  const when = params.transactionDate;
  const declared = params.declaredLiters;
  const price = params.pricePerLiter ?? DEFAULT_FUEL_PRICE_NGN_LITER;
  const receiptLat = toNumber(params.receiptLatitude);
  const receiptLng = toNumber(params.receiptLongitude);
  const capacity = params.tankCapacityLiters ?? null;

  const checks: ReceiptCheck[] = [];

  const stopPhrase = evidence.fuelStop
    ? `The tracker recorded a ${evidence.fuelStop.minutes != null ? `${evidence.fuelStop.minutes} min ` : ''}stop at a filling station at ${evidence.fuelStop.at.toISOString().slice(11, 16)}.`
    : null;

  // 1. Was the vehicle where the receipt says the fuel went in?
  let distance: number | null = null;
  if (receiptLat == null || receiptLng == null || !evidence.fix) {
    const reason =
      receiptLat == null || receiptLng == null
        ? 'The receipt carries no location'
        : `The tracker reported no position within ${FIX_WINDOW_MINUTES} minutes of the purchase`;
    // A forecourt stop stands on its own: it is the tracker's own evidence
    // that the vehicle was buying fuel, independent of the driver's phone.
    checks.push({
      code: 'vehicle_present',
      label: 'Vehicle at the station',
      outcome: stopPhrase ? 'pass' : 'unknown',
      detail: stopPhrase ? `${stopPhrase} ${reason}, but the stop places the vehicle at a station.` : `${reason}.`,
    });
  } else {
    distance = distanceMeters(
      evidence.fix.latitude,
      evidence.fix.longitude,
      receiptLat,
      receiptLng
    );
    const gap = minutesBetween(evidence.fix.at, when);
    const nearestPhrase = gap === 0 ? 'at that moment' : `${gap} min ${evidence.fix.at > when ? 'later' : 'earlier'}`;

    if (distance <= AT_STATION_METERS) {
      checks.push({
        code: 'vehicle_present',
        label: 'Vehicle at the station',
        outcome: 'pass',
        detail: `The tracker put the vehicle ${distance} m from the receipt's location ${nearestPhrase}.${stopPhrase ? ` ${stopPhrase}` : ''}`,
      });
    } else if (distance >= ELSEWHERE_METERS) {
      checks.push({
        code: 'vehicle_present',
        label: 'Vehicle at the station',
        outcome: 'fail',
        detail: `The vehicle was ${(distance / 1000).toFixed(1)} km away ${nearestPhrase} — it was not at this station.`,
      });
    } else {
      checks.push({
        code: 'vehicle_present',
        label: 'Vehicle at the station',
        outcome: stopPhrase ? 'pass' : 'unknown',
        detail: stopPhrase
          ? `${stopPhrase} The phone's location was ${distance} m off ${nearestPhrase}, which is within normal GPS error for a forecourt.`
          : `The vehicle was ${distance} m from the receipt's location ${nearestPhrase} — close, but not close enough to confirm.`,
      });
    }
  }

  // 2. Could the tank have taken this much?
  let headroom: number | null = null;
  let overclaimed: number | null = null;
  if (capacity == null || evidence.levelBefore == null) {
    checks.push({
      code: 'volume_fits_tank',
      label: 'Volume fits the tank',
      outcome: 'unknown',
      detail:
        capacity == null
          ? 'No tank capacity is recorded for this vehicle.'
          : 'The tank level before the fill is unknown.',
    });
  } else {
    headroom = Math.round((capacity - evidence.levelBefore) * 10) / 10;
    if (declared <= headroom * TANK_TOLERANCE) {
      checks.push({
        code: 'volume_fits_tank',
        label: 'Volume fits the tank',
        outcome: 'pass',
        detail: `The tank held ${evidence.levelBefore.toFixed(1)}L of ${capacity}L, leaving room for ${headroom.toFixed(1)}L — ${declared.toFixed(2)}L fits.`,
      });
    } else {
      overclaimed = Math.round((declared - headroom) * 10) / 10;
      checks.push({
        code: 'volume_fits_tank',
        label: 'Volume fits the tank',
        outcome: 'fail',
        detail: `${declared.toFixed(2)}L was claimed into a tank with room for about ${headroom.toFixed(1)}L — ${overclaimed.toFixed(1)}L could not have gone in.`,
      });
    }
  }

  // 3. Does the buying track the burning? Informational by design.
  if (evidence.litersBurnedSincePrevious == null || evidence.litersBoughtSincePrevious == null) {
    checks.push({
      code: 'bought_vs_burned',
      label: 'Buying tracks burning',
      outcome: 'unknown',
      detail: 'This is the first logged fill for this vehicle, so there is nothing to compare against yet.',
    });
  } else {
    const burned = evidence.litersBurnedSincePrevious;
    const bought = evidence.litersBoughtSincePrevious;
    const gap = Math.round((bought - burned) * 10) / 10;
    checks.push({
      code: 'bought_vs_burned',
      label: 'Buying tracks burning',
      outcome: gap > burned && burned > 0 ? 'unknown' : 'pass',
      detail: `${bought.toFixed(1)}L bought since the last fill against ${burned.toFixed(1)}L burned by the engine${gap > 0 ? ` — ${gap.toFixed(1)}L more bought than burned` : ''}. Burn comes from the tracker's GPS fuel counter, which reads low on this fleet, so treat it as a trend rather than a verdict.`,
    });
  }

  const failed = checks.filter((c) => c.outcome === 'fail');
  const decisive = checks.filter((c) => c.code !== 'bought_vs_burned');
  const allDecisivePassed = decisive.every((c) => c.outcome === 'pass');

  let status: ReceiptVerification['status'] = 'pending';
  let summary: string;
  let estimatedLossNgn = 0;

  if (failed.length > 0) {
    status = 'flagged_theft';
    const presenceFailed = failed.some((c) => c.code === 'vehicle_present');
    // A receipt for a station the vehicle never visited is a total loss; an
    // overclaimed volume only loses the litres that could not have fitted.
    const litersAtRisk = presenceFailed ? declared : (overclaimed ?? 0);
    estimatedLossNgn = Math.round(litersAtRisk * price);
    summary = failed.map((c) => c.detail).join(' ');
  } else if (allDecisivePassed) {
    status = 'matched';
    summary = `Verified: the vehicle was at the station and ${declared.toFixed(2)}L fits what the tank could take.`;
  } else {
    const missing = decisive.filter((c) => c.outcome === 'unknown');
    summary = `Not enough evidence to verify yet — ${missing.map((c) => c.detail).join(' ')}`;
  }

  return {
    status,
    checks,
    summary,
    station: null,
    distanceMeters: distance,
    nearestFixAt: evidence.fix?.at.toISOString() ?? null,
    tankLevelBeforeLiters: evidence.levelBefore,
    headroomLiters: headroom,
    overclaimedLiters: overclaimed,
    estimatedLossNgn,
    verifiedAt: new Date().toISOString(),
  };
}

/**
 * A picture of the place the fuel was supposedly bought.
 *
 * Numbers convince an analyst; a photograph of the forecourt convinces the
 * person who has to confront a driver. Street View of the exact coordinates
 * beats a stock photo of the venue, which is what `lookupPlace` already
 * prefers, and both are proxied so the API key stays server-side. Results are
 * cached per ~11 m cell, so the same station costs one lookup ever.
 *
 * Prefers the receipt's own pin — that is the claim being tested. Falls back
 * to the tracker's fix so a receipt with no GPS still shows where the vehicle
 * actually was.
 */
async function stationEvidence(
  params: VerifyReceiptParams,
  evidence: Evidence
): Promise<StationEvidence | null> {
  const receiptLat = toNumber(params.receiptLatitude);
  const receiptLng = toNumber(params.receiptLongitude);

  const point =
    receiptLat != null && receiptLng != null
      ? { lat: receiptLat, lng: receiptLng, source: 'receipt' as const }
      : evidence.fix
        ? { lat: evidence.fix.latitude, lng: evidence.fix.longitude, source: 'tracker' as const }
        : null;

  if (!point) return null;

  try {
    // The forecourt itself is the thing being corroborated, so the filling
    // station lookup comes first — the general place lookup tends to answer
    // with the neighbourhood ("Ado") rather than the station.
    const [station, place] = await Promise.all([
      nearbyFuelStation(point.lat, point.lng),
      lookupPlace(point.lat, point.lng),
    ]);

    // Order of preference: Street View of the exact spot, then a photo of the
    // station itself, then a map. Google has no imagery at all for parts of
    // this fleet's routes, and a map of the pin against the tracker's fix is
    // still evidence a manager can read.
    const streetView = place.image_kind === 'street_view' ? place.photo_url : null;
    const stationPhoto = station?.photoUrl ?? (place.image_kind === 'place_photo' ? place.photo_url : null);
    const map = staticMapPath(
      point.lat,
      point.lng,
      evidence.fix ? { lat: evidence.fix.latitude, lng: evidence.fix.longitude } : null
    );

    return {
      placeName: station?.name ?? place.place_name,
      formattedAddress: place.formatted_address,
      photoUrl: streetView ?? stationPhoto ?? map,
      imageKind: streetView ? 'street_view' : stationPhoto ? 'place_photo' : 'map',
      streetViewDate: streetView ? place.street_view_date : null,
      source: point.source,
    };
  } catch (error) {
    // Imagery is corroboration, not the verdict — a lookup failure must never
    // stop a receipt being verified.
    console.error('[receipt_verification] station lookup failed:', (error as Error).message);
    return null;
  }
}

/** Gather the evidence for one receipt and rule on it. */
export async function verifyReceipt(
  params: VerifyReceiptParams
): Promise<ReceiptVerification> {
  const evidence = await gatherEvidence(params);
  const verdict = decideVerification(params, evidence);
  return { ...verdict, station: await stationEvidence(params, evidence) };
}
