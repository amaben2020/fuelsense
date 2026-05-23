const { db, sql } = require('./db-helpers');
const { DEFAULT_FUEL_PRICE_NGN_LITER } = require('./fuel-metrics');

const REPLAY_WINDOW_MINUTES = 30;
const MAX_READINGS = 200;

async function loadTelemetryWindow({ vehicleId, customerId, centerTime }) {
  const center = centerTime instanceof Date ? centerTime : new Date(centerTime);
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

function downsampleReadings(rows) {
  if (rows.length <= 120) return rows;
  const step = Math.ceil(rows.length / 120);
  const sampled = rows.filter((_, index) => index % step === 0);
  const last = rows[rows.length - 1];
  if (sampled[sampled.length - 1]?.recorded_at !== last?.recorded_at) {
    sampled.push(last);
  }
  return sampled;
}

function serializeReading(row) {
  return {
    recorded_at: row.recorded_at,
    fuel_level_liters: row.fuel_level_liters != null ? Number(row.fuel_level_liters) : null,
    speed_kph: row.speed_kph != null ? Number(row.speed_kph) : 0,
    ignition_on: Boolean(row.ignition_on),
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    odometer_km: row.odometer_km != null ? Number(row.odometer_km) : null,
  };
}

function findClosestIndex(readings, targetTime) {
  if (!readings.length) return 0;
  const target = new Date(targetTime).getTime();
  let best = 0;
  let bestDiff = Infinity;
  readings.forEach((row, index) => {
    const diff = Math.abs(new Date(row.recorded_at).getTime() - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = index;
    }
  });
  return best;
}

function findSteepestDropIndex(readings) {
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
  return bestDrop > 0 ? bestIndex : findClosestIndex(readings, readings[Math.floor(readings.length / 2)]?.recorded_at);
}

function formatTimeLabel(iso) {
  try {
    return new Date(iso).toLocaleTimeString('en-NG', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Africa/Lagos',
    });
  } catch {
    return '';
  }
}

function buildMoments(readings, anomalyIndex) {
  const moments = [];
  for (let i = 1; i < readings.length; i += 1) {
    const prev = readings[i - 1];
    const curr = readings[i];
    if (prev.fuel_level_liters == null || curr.fuel_level_liters == null) continue;

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
      prev?.fuel_level_liters != null && anomalyReading.fuel_level_liters != null
        ? prev.fuel_level_liters - anomalyReading.fuel_level_liters
        : null;

    moments.push({
      index: anomalyIndex,
      type: 'anomaly',
      recorded_at: anomalyReading.recorded_at,
      fuel_drop_liters: drop != null && drop > 0 ? Math.round(drop * 10) / 10 : undefined,
      fuel_before: prev?.fuel_level_liters ?? null,
      fuel_after: anomalyReading.fuel_level_liters,
      latitude: anomalyReading.latitude,
      longitude: anomalyReading.longitude,
      speed_kph: anomalyReading.speed_kph,
      ignition_on: anomalyReading.ignition_on,
      label: `Anomaly detected at ${formatTimeLabel(anomalyReading.recorded_at)}`,
    });
  }

  const byIndex = new Map();
  for (const m of moments) {
    if (!byIndex.has(m.index) || m.type === 'anomaly') byIndex.set(m.index, m);
  }
  return [...byIndex.values()].sort(
    (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
  );
}

function attachMoments(payload, readings, anomalyIndex) {
  const moments = buildMoments(readings, anomalyIndex);
  const anomalyMoment = moments.find((m) => m.type === 'anomaly') ?? moments.find((m) => m.type === 'fuel_drop') ?? null;
  return { ...payload, moments, anomaly_moment: anomalyMoment };
}

function buildFallbackReadings({ center, beforeLiters, afterLiters, lat, lng }) {
  const centerMs = center.getTime();
  const points = [
    { offsetMin: -20, fuel: beforeLiters, speed: 0, ignition: false },
    { offsetMin: -10, fuel: beforeLiters, speed: 0, ignition: false },
    { offsetMin: -2, fuel: beforeLiters, speed: 0, ignition: false },
    { offsetMin: 0, fuel: afterLiters, speed: 0, ignition: false },
    { offsetMin: 10, fuel: afterLiters, speed: 0, ignition: false },
    { offsetMin: 20, fuel: afterLiters, speed: 15, ignition: true },
  ];
  return points.map((point) => ({
    recorded_at: new Date(centerMs + point.offsetMin * 60 * 1000).toISOString(),
    fuel_level_liters: point.fuel,
    speed_kph: point.speed,
    ignition_on: point.ignition,
    latitude: lat,
    longitude: lng,
    odometer_km: null,
  }));
}

function buildSiphonReplay(event, rawRows) {
  const before = Number(event.fuel_level_before) || 0;
  const after = Number(event.fuel_level_after) || 0;
  const lat = event.latitude != null ? Number(event.latitude) : null;
  const lng = event.longitude != null ? Number(event.longitude) : null;

  let rows = downsampleReadings(rawRows.map(serializeReading));
  if (rows.length < 3 && before > 0) {
    rows = buildFallbackReadings({
      center: new Date(event.occurred_at),
      beforeLiters: before,
      afterLiters: after,
      lat,
      lng,
    });
  }

  const reasons = [];
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
  if (event.parked_duration_minutes && event.parked_duration_minutes >= 30) {
    reasons.push(`Parked ${event.parked_duration_minutes} min before drop`);
    confidence += 5;
  } else if (!event.engine_state_before) {
    reasons.push('Engine off during fuel loss window');
    confidence += 4;
  }

  const anomalyIndex =
    rows.length > 1 ? findSteepestDropIndex(rows) : findClosestIndex(rows, event.occurred_at);

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
      anomaly: {
        type: 'Sudden fuel drop',
        liters_lost: drop,
        estimated_loss_ngn: Number(event.estimated_loss_ngn) || Math.round(drop * DEFAULT_FUEL_PRICE_NGN_LITER),
        confidence_percent: Math.min(Math.round(confidence), 96),
        reasons,
      },
    },
    rows,
    anomalyIndex
  );
}

function buildReceiptReplay(receipt, rawRows) {
  const declared = Number(receipt.declared_liters) || 0;
  const actual = receipt.obd_liters_actual != null ? Number(receipt.obd_liters_actual) : null;
  const diff = receipt.difference_liters != null ? Number(receipt.difference_liters) : declared - (actual ?? 0);
  const price = Number(receipt.price_per_liter) || DEFAULT_FUEL_PRICE_NGN_LITER;

  let rows = downsampleReadings(rawRows.map(serializeReading));
  if (rows.length < 3 && declared > 0) {
    const center = new Date(receipt.transaction_date);
    const baseline = actual != null ? Math.max(actual, declared * 0.3) : declared * 0.5;
    rows = buildFallbackReadings({
      center,
      beforeLiters: baseline,
      afterLiters: baseline + (actual ?? declared * 0.15),
      lat: receipt.receipt_latitude != null ? Number(receipt.receipt_latitude) : null,
      lng: receipt.receipt_longitude != null ? Number(receipt.receipt_longitude) : null,
    });
  }

  const reasons = [
    `Receipt claimed ${declared.toFixed(1)}L at ${receipt.merchant_name || 'station'}`,
  ];
  if (actual != null) {
    reasons.push(`OBD sensor recorded only ${actual.toFixed(1)}L refuel`);
    reasons.push(`Discrepancy of ${diff.toFixed(1)}L exceeds fraud threshold`);
  } else {
    reasons.push('OBD refuel delta could not be matched to receipt');
  }
  reasons.push('No legitimate refuel event supports declared volume');

  const anomalyIndex = findClosestIndex(rows, receipt.transaction_date);

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
        type: 'Receipt fraud',
        liters_lost: Math.max(0, diff),
        estimated_loss_ngn:
          Number(receipt.estimated_loss_ngn) || Math.round(Math.max(0, diff) * price),
        confidence_percent: actual != null ? Math.min(88 + Math.min(diff / 2, 8), 97) : 72,
        reasons,
        declared_liters: declared,
        obd_liters_actual: actual,
      },
    },
    rows,
    anomalyIndex
  );
}

async function loadTelemetryDay({ vehicleId, customerId, activityDate }) {
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
    ORDER BY recorded_at ASC
    LIMIT ${MAX_READINGS}
  `);
  return result.rows ?? [];
}

function buildDailyReplay({ vehicle, rawRows, flagType }) {
  let rows = downsampleReadings(rawRows.map(serializeReading));
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
        : 'daily_flag';

  const reasons = [];
  if (drop >= 3) reasons.push(`Largest fuel drop this day: −${drop.toFixed(1)}L`);
  if (flagType === 'data_anomaly') reasons.push('Fuel/distance ratio inconsistent with normal trips');
  if (flagType === 'low_efficiency') reasons.push('Daily consumption above vehicle baseline');
  if (!reasons.length) reasons.push('Review full-day telemetry for operational waste');

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
      location_name: null,
      readings: rows,
      anomaly: {
        type:
          eventType === 'data_anomaly'
            ? 'Data anomaly'
            : eventType === 'low_efficiency'
              ? 'Low efficiency day'
              : 'Daily flag review',
        liters_lost: drop,
        estimated_loss_ngn: Math.round(drop * DEFAULT_FUEL_PRICE_NGN_LITER),
        confidence_percent: drop >= 5 ? 82 : 68,
        reasons,
      },
    },
    rows,
    anomalyIndex
  );
}

async function buildDailyActivityReplay({ customerId, vehicleId, activityDate, flagType }) {
  const vehicleResult = await db.execute(sql`
    SELECT v.id AS vehicle_id, v.license_plate, v.model,
      COALESCE(dr.full_name, v.driver_name) AS driver_name
    FROM vehicles v
    LEFT JOIN drivers dr ON dr.id = v.driver_id
    WHERE v.id = ${vehicleId} AND v.customer_id = ${customerId}
    LIMIT 1
  `);
  const vehicle = vehicleResult.rows[0];
  if (!vehicle) return null;

  const siphonResult = await db.execute(sql`
    SELECT id FROM siphon_events
    WHERE vehicle_id = ${vehicleId}
      AND customer_id = ${customerId}
      AND DATE(occurred_at AT TIME ZONE 'Africa/Lagos') = ${activityDate}::date
    ORDER BY occurred_at DESC
    LIMIT 1
  `);
  if (siphonResult.rows[0]?.id) {
    return buildSiphonEventReplay({ customerId, eventId: siphonResult.rows[0].id });
  }

  const rows = await loadTelemetryDay({ vehicleId, customerId, activityDate });
  return buildDailyReplay({ vehicle, rawRows: rows, flagType });
}

function findMaxDropLiters(rows) {
  let maxDrop = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1].fuel_level_liters;
    const curr = rows[i].fuel_level_liters;
    if (prev == null || curr == null) continue;
    maxDrop = Math.max(maxDrop, prev - curr);
  }
  return maxDrop;
}

async function buildSiphonEventReplay({ customerId, eventId }) {
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

  const event = result.rows[0];
  if (!event) return null;

  const { rows } = await loadTelemetryWindow({
    vehicleId: event.vehicle_id,
    customerId,
    centerTime: event.occurred_at,
  });

  return buildSiphonReplay(event, rows);
}

async function buildReceiptEventReplay({ customerId, receiptId }) {
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
      dr.full_name AS driver_name,
      GREATEST(0, (r.difference_liters::numeric * COALESCE(r.price_per_liter, 650)))::int AS estimated_loss_ngn
    FROM fuel_receipts r
    JOIN vehicles v ON v.id = r.vehicle_id
    JOIN drivers dr ON dr.id = r.driver_id
    WHERE r.id = ${receiptId} AND r.customer_id = ${customerId}
    LIMIT 1
  `);

  const receipt = result.rows[0];
  if (!receipt) return null;

  const { rows } = await loadTelemetryWindow({
    vehicleId: receipt.vehicle_id,
    customerId,
    centerTime: receipt.transaction_date,
  });

  return buildReceiptReplay(receipt, rows);
}

module.exports = {
  buildSiphonEventReplay,
  buildReceiptEventReplay,
  buildDailyActivityReplay,
};
