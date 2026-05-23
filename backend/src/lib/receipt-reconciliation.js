const { db, sql } = require('./db-helpers');
const { REFUEL_THRESHOLD_LITERS, DEFAULT_FUEL_PRICE_NGN_LITER } = require('./fuel-metrics');

const RECEIPT_FRAUD_THRESHOLD_LITERS = 5;
const MATCH_TOLERANCE_LITERS = 3;

function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Match OBD refuel delta and telemetry timestamps near a declared purchase time.
 * Returns liters added, when FMC150 recorded the rise, and nearest ignition-on edge.
 */
async function findObdRefuelMatch({ vehicleId, customerId, transactionDate }) {
  const when = toDate(transactionDate);

  const result = await db.execute(sql`
    WITH readings AS (
      SELECT
        fuel_level_liters::numeric AS fuel,
        recorded_at,
        ignition_on
      FROM telemetry
      WHERE vehicle_id = ${vehicleId}
        AND customer_id = ${customerId}
        AND recorded_at BETWEEN ${when.toISOString()}::timestamp - INTERVAL '2 hours'
          AND ${when.toISOString()}::timestamp + INTERVAL '2 hours'
      ORDER BY recorded_at ASC
    ),
    ordered AS (
      SELECT
        fuel,
        recorded_at,
        ignition_on,
        LAG(fuel) OVER (ORDER BY recorded_at) AS prev_fuel,
        LAG(ignition_on) OVER (ORDER BY recorded_at) AS prev_ignition
      FROM readings
    ),
    refuel_events AS (
      SELECT
        fuel - prev_fuel AS delta_liters,
        recorded_at AS detected_at
      FROM ordered
      WHERE prev_fuel IS NOT NULL
        AND fuel - prev_fuel >= ${REFUEL_THRESHOLD_LITERS}
    ),
    best_refuel AS (
      SELECT delta_liters, detected_at
      FROM refuel_events
      ORDER BY delta_liters DESC, detected_at ASC
      LIMIT 1
    ),
    ignition_events AS (
      SELECT recorded_at AS ignition_on_at
      FROM ordered
      WHERE prev_ignition IS FALSE AND ignition_on IS TRUE
    )
    SELECT
      br.delta_liters,
      br.detected_at AS obd_refuel_detected_at,
      COALESCE(
        (
          SELECT ie.ignition_on_at
          FROM ignition_events ie
          WHERE ie.ignition_on_at >= br.detected_at - INTERVAL '2 minutes'
            AND ie.ignition_on_at <= br.detected_at + INTERVAL '45 minutes'
          ORDER BY ie.ignition_on_at ASC
          LIMIT 1
        ),
        (
          SELECT ie.ignition_on_at
          FROM ignition_events ie
          WHERE ie.ignition_on_at >= ${when.toISOString()}::timestamp - INTERVAL '15 minutes'
            AND ie.ignition_on_at <= ${when.toISOString()}::timestamp + INTERVAL '45 minutes'
          ORDER BY ie.ignition_on_at ASC
          LIMIT 1
        )
      ) AS ignition_on_at
    FROM best_refuel br
  `);

  const row = result.rows[0];
  if (!row?.delta_liters) {
    return {
      liters: null,
      obdRefuelDetectedAt: null,
      ignitionOnAt: null,
    };
  }

  return {
    liters: Number(row.delta_liters),
    obdRefuelDetectedAt: row.obd_refuel_detected_at ? new Date(row.obd_refuel_detected_at) : null,
    ignitionOnAt: row.ignition_on_at ? new Date(row.ignition_on_at) : null,
  };
}

async function findObdRefuelLiters(args) {
  const match = await findObdRefuelMatch(args);
  return match.liters;
}

function reconcileReceipt({ declaredLiters, obdLitersActual, pricePerLiter }) {
  const price = pricePerLiter ?? DEFAULT_FUEL_PRICE_NGN_LITER;
  const declared = Number(declaredLiters);

  if (obdLitersActual == null) {
    return {
      obdLitersActual: null,
      differenceLiters: null,
      reconciliationStatus: 'pending',
      estimatedLossNgn: 0,
    };
  }

  const actual = Number(obdLitersActual);
  const difference = Math.round((declared - actual) * 10) / 10;
  let reconciliationStatus = 'pending';

  if (difference > RECEIPT_FRAUD_THRESHOLD_LITERS) {
    reconciliationStatus = 'flagged_theft';
  } else if (Math.abs(difference) <= MATCH_TOLERANCE_LITERS) {
    reconciliationStatus = 'matched';
  }

  const estimatedLossNgn = difference > 0 ? Math.round(difference * price) : 0;

  return {
    obdLitersActual: actual,
    differenceLiters: difference,
    reconciliationStatus,
    estimatedLossNgn,
  };
}

function buildReceiptTimeline({
  purchasedAt,
  obdRefuelDetectedAt,
  ignitionOnAt,
}) {
  const purchase = purchasedAt ? toDate(purchasedAt) : null;
  const obd = obdRefuelDetectedAt ? toDate(obdRefuelDetectedAt) : null;
  const ignition = ignitionOnAt ? toDate(ignitionOnAt) : null;

  const deltaMinutes = (from, to) => {
    if (!from || !to) return null;
    return Math.round((to.getTime() - from.getTime()) / 60000);
  };

  return {
    purchased_at: purchase?.toISOString() ?? null,
    obd_refuel_detected_at: obd?.toISOString() ?? null,
    ignition_on_at: ignition?.toISOString() ?? null,
    purchase_to_obd_minutes: deltaMinutes(purchase, obd),
    obd_to_ignition_minutes: deltaMinutes(obd, ignition),
    purchase_to_ignition_minutes: deltaMinutes(purchase, ignition),
  };
}

function deltaMinutes(from, to) {
  if (!from || !to) return null;
  return Math.round((to.getTime() - from.getTime()) / 60000);
}

function formatDurationLabel(minutes) {
  if (minutes == null) return null;
  const abs = Math.abs(minutes);
  if (abs < 1) return 'under 1 minute';
  if (abs < 60) return `${abs} minute${abs === 1 ? '' : 's'}`;
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  if (!mins) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${hours}h ${mins}m`;
}

/**
 * Build chronological narrative + theft probability for a reconciled receipt.
 */
function assessReceiptEvent({
  purchasedAt,
  obdRefuelDetectedAt,
  ignitionOnAt,
  litersDeclared,
  litersActual,
  status,
  merchant,
  licensePlate,
  costPerLiter,
}) {
  const purchase = purchasedAt ? toDate(purchasedAt) : null;
  const obd = obdRefuelDetectedAt ? toDate(obdRefuelDetectedAt) : null;
  const ignition = ignitionOnAt ? toDate(ignitionOnAt) : null;
  const declared = Number(litersDeclared);
  const actual = litersActual != null ? Number(litersActual) : null;
  const difference = actual != null ? Math.round((declared - actual) * 10) / 10 : null;
  const price = costPerLiter ?? DEFAULT_FUEL_PRICE_NGN_LITER;

  const timeline = buildReceiptTimeline({ purchasedAt, obdRefuelDetectedAt, ignitionOnAt });

  const rawEvents = [
    purchase && {
      key: 'purchase',
      label: 'Pump purchase',
      at: purchase,
      source: 'Driver receipt',
      detail: merchant
        ? `Driver logged ${declared}L at ${merchant}.`
        : `Driver logged ${declared}L at the fuel station.`,
    },
    obd && {
      key: 'obd',
      label: 'OBD fuel rise',
      at: obd,
      source: 'FMC150 IO 390',
      detail:
        actual != null
          ? `Tank sensor recorded +${actual}L entering the vehicle.`
          : 'Tank sensor recorded a fuel level increase.',
    },
    ignition && {
      key: 'ignition',
      label: 'Ignition on',
      at: ignition,
      source: 'FMC150 IO 239',
      detail: 'Engine ignition switched on (telemetry edge).',
    },
  ].filter(Boolean);

  rawEvents.sort((a, b) => a.at.getTime() - b.at.getTime());

  const chronological = rawEvents.map((event, index) => {
    const prev = index > 0 ? rawEvents[index - 1] : null;
    const minutesAfterPrev = prev ? deltaMinutes(prev.at, event.at) : null;
    let note = null;

    if (event.key === 'ignition' && purchase && event.at.getTime() < purchase.getTime()) {
      note =
        'This ignition event occurred before the logged pump purchase — it belongs to an earlier trip, not this refuel.';
    } else if (event.key === 'obd' && purchase && event.at.getTime() < purchase.getTime()) {
      note =
        'OBD detected fuel rising before the receipt time — the purchase timestamp may be wrong or this is a different event.';
    } else if (minutesAfterPrev != null && index > 0) {
      note = `${formatDurationLabel(minutesAfterPrev)} after ${prev.label.toLowerCase()}.`;
    }

    return {
      ...event,
      at: event.at.toISOString(),
      minutes_after_previous: minutesAfterPrev,
      note,
    };
  });

  const reasons = [];
  const signals = [];
  let probability = 0;

  if (difference != null && difference > 0) {
    const literRatio = declared > 0 ? difference / declared : 0;
    const literPoints = Math.min(45, Math.round(literRatio * 40 + difference * 2.5));
    probability += literPoints;
    signals.push({
      code: 'liter_gap',
      weight: literPoints,
      message: `Receipt claims ${declared}L but the OBD sensor only recorded ${actual}L — a ${difference}L gap.`,
    });
    reasons.push(
      `The driver declared ${difference}L more than FMC150 measured entering the tank. At ₦${price}/L, that is ~₦${Math.round(difference * price).toLocaleString('en-NG')} unaccounted for.`
    );
  }

  if (purchase && ignition && ignition.getTime() < purchase.getTime()) {
    const points = 18;
    probability += points;
    signals.push({
      code: 'ignition_before_purchase',
      weight: points,
      message: 'Ignition was on before the logged pump purchase — likely an unrelated earlier engine start.',
    });
    reasons.push(
      'Ignition telemetry predates the receipt time, so the matched ignition event is probably from a prior trip rather than this refuel sequence.'
    );
  }

  if (purchase && obd) {
    const gap = timeline.purchase_to_obd_minutes;
    if (gap != null && gap < 0) {
      const points = 22;
      probability += points;
      signals.push({
        code: 'obd_before_purchase',
        weight: points,
        message: 'OBD fuel rise was recorded before the logged purchase time.',
      });
      reasons.push('Fuel entered the tank before the receipt timestamp — timing inconsistency increases fraud likelihood.');
    } else if (gap != null && gap > 45) {
      const points = 12;
      probability += points;
      signals.push({
        code: 'long_purchase_to_obd_gap',
        weight: points,
        message: `OBD refuel was ${gap} minutes after purchase — unusually long for a single stop.`,
      });
      reasons.push(
        `There was a ${formatDurationLabel(gap)} gap between payment and the OBD refuel signal — longer than a typical pump-to-tank fill.`
      );
    }
  }

  if (status === 'flagged_theft') {
    probability = Math.max(probability, 78);
  } else if (status === 'verified' && (difference ?? 0) <= 3) {
    probability = Math.min(probability, 12);
  }

  if (actual == null) {
    probability = Math.min(probability, 35);
    reasons.push('No OBD refuel was matched within ±2 hours — we cannot fully verify this receipt yet.');
  }

  probability = Math.max(0, Math.min(99, Math.round(probability)));

  let verdict = 'verified';
  if (status === 'flagged_theft' || probability >= 70) verdict = 'likely_theft';
  else if (status === 'pending_receipt' || probability >= 40) verdict = 'suspicious';
  else if (probability >= 20) verdict = 'review';

  const summary =
    verdict === 'likely_theft'
      ? `High-confidence receipt fraud signal (${probability}% probability). Telemetry and declared liters do not align.`
      : verdict === 'suspicious'
        ? `Suspicious receipt (${probability}% probability). Review the timeline and liter gap before approving.`
        : verdict === 'review'
          ? `Minor inconsistencies (${probability}% probability). Likely legitimate but worth a quick check.`
          : `Receipt aligns with OBD telemetry (${probability}% fraud probability).`;

  return {
    chronological_timeline: chronological,
    expected_sequence:
      'Typical refuel: pump purchase → fuel enters tank (OBD rise) → ignition on to depart.',
    theft_probability: probability,
    verdict,
    summary,
    reasons,
    signals,
    estimated_loss_ngn: difference != null && difference > 0 ? Math.round(difference * price) : 0,
    license_plate: licensePlate ?? null,
    liters_declared: declared,
    liters_actual: actual,
    difference_liters: difference,
  };
}

module.exports = {
  RECEIPT_FRAUD_THRESHOLD_LITERS,
  findObdRefuelLiters,
  findObdRefuelMatch,
  reconcileReceipt,
  buildReceiptTimeline,
  assessReceiptEvent,
};
