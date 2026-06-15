const { db, alerts, siphonEvents, vehicles, telemetry, eq, and, desc, sql } = require('./db-helpers');
const {
  REFUEL_THRESHOLD_LITERS,
  idleFuelBurnLiters,
  IDLE_BURN_LITERS_PER_HOUR,
  DEFAULT_FUEL_PRICE_NGN_LITER,
  baselineEfficiencyKmL,
} = require('./fuel-metrics');
const { recordSiphonEvent } = require('./siphon-recorder');

const idleStreakByImei = new Map();
const idleStartFuelByImei = new Map();
const idleWasteAccumByImei = new Map();
const lastFuelByImei = new Map();
const fraudSimulatedFor = new Set();
const baselineCache = new Map();

const TICK_INTERVAL_SEC = Number(process.env.MOCK_INTERVAL_MS || 4000) / 1000;
const IDLE_TICKS_FOR_ALERT = 12;
const DEMO_IDLE_MINUTES_LABEL = 45;
const BASELINE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function resetEngineState() {
  idleStreakByImei.clear();
  idleStartFuelByImei.clear();
  idleWasteAccumByImei.clear();
  lastFuelByImei.clear();
  fraudSimulatedFor.clear();
  baselineCache.clear();
}

async function hasOpenAlert(customerId, vehicleId, alertType) {
  const [row] = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(
      and(
        eq(alerts.customerId, customerId),
        eq(alerts.vehicleId, vehicleId),
        eq(alerts.alertType, alertType),
        eq(alerts.isResolved, false)
      )
    )
    .limit(1);
  return !!row;
}

/**
 * Rule 8: Learn normal behavior per vehicle.
 * Tracks average fuel consumption per km (driving), idle burn per hour (idling),
 * and typical variance of sensor readings.
 */
async function getOrComputeVehicleBaseline(vehicleId, model, nowTime = new Date()) {
  const cached = baselineCache.get(vehicleId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.baseline;
  }

  const defaultKmL = baselineEfficiencyKmL(model || 'Hiace');
  const defaultIdlePerHour = IDLE_BURN_LITERS_PER_HOUR;
  const defaultBaseline = {
    avgFuelPerKm: 1 / defaultKmL,
    avgIdleFuelPerHour: defaultIdlePerHour,
    typicalVariance: 0.5,
  };

  try {
    const sevenDaysAgo = new Date(nowTime.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = await db
      .select({
        recordedAt: telemetry.recordedAt,
        fuelLevelLiters: telemetry.fuelLevelLiters,
        odometerKm: telemetry.odometerKm,
        speedKph: telemetry.speedKph,
        ignitionOn: telemetry.ignitionOn,
      })
      .from(telemetry)
      .where(
        and(
          eq(telemetry.vehicleId, vehicleId),
          sql`recorded_at >= ${sevenDaysAgo}::timestamp`
        )
      )
      .orderBy(telemetry.recordedAt);

    if (rows.length < 50) {
      baselineCache.set(vehicleId, {
        baseline: defaultBaseline,
        expiresAt: Date.now() + BASELINE_TTL_MS,
      });
      return defaultBaseline;
    }

    let totalDrivingFuel = 0;
    let totalDrivingDistance = 0;
    let totalIdleFuel = 0;
    let totalIdleTimeHours = 0;
    let differences = [];

    for (let i = 0; i < rows.length - 1; i++) {
      const curr = rows[i];
      const next = rows[i + 1];
      if (curr.fuelLevelLiters == null || next.fuelLevelLiters == null) continue;

      const fCurr = Number(curr.fuelLevelLiters);
      const fNext = Number(next.fuelLevelLiters);
      const deltaF = fCurr - fNext;
      const deltaT = (new Date(next.recordedAt) - new Date(curr.recordedAt)) / 3600000;

      if (deltaF < -REFUEL_THRESHOLD_LITERS || deltaF > 15) continue;

      if (curr.ignitionOn && curr.speedKph > 2) {
        const oCurr = curr.odometerKm;
        const oNext = next.odometerKm;
        if (oCurr != null && oNext != null) {
          const deltaO = oNext - oCurr;
          if (deltaO > 0 && deltaF > 0) {
            totalDrivingFuel += deltaF;
            totalDrivingDistance += deltaO;
          }
        }
      } else if (curr.ignitionOn && curr.speedKph <= 2) {
        if (deltaT > 0 && deltaF > 0) {
          totalIdleFuel += deltaF;
          totalIdleTimeHours += deltaT;
        }
      } else if (!curr.ignitionOn) {
        differences.push(Math.abs(deltaF));
      }
    }

    const learnedKmL = totalDrivingDistance > 10 ? totalDrivingDistance / totalDrivingFuel : defaultKmL;
    const learnedIdlePerHour = totalIdleTimeHours > 0.5 ? totalIdleFuel / totalIdleTimeHours : defaultIdlePerHour;

    let typicalVariance = 0.5;
    if (differences.length > 0) {
      const sum = differences.reduce((a, b) => a + b, 0);
      typicalVariance = Math.max(0.1, sum / differences.length);
    }

    const baseline = {
      avgFuelPerKm: 1 / learnedKmL,
      avgIdleFuelPerHour: learnedIdlePerHour,
      typicalVariance,
    };

    baselineCache.set(vehicleId, {
      baseline,
      expiresAt: Date.now() + BASELINE_TTL_MS,
    });
    return baseline;
  } catch (error) {
    console.error('Error computing baseline for vehicle', vehicleId, error);
    return defaultBaseline;
  }
}

async function detectAnomalies(device, row, { licensePlate } = {}) {
  if (!device.customerId || !device.vehicleId) return;

  const imei = device.imei;
  const fuel = row.fuelLevelLiters != null ? Number(row.fuelLevelLiters) : null;
  const ignitionOn = !!row.ignitionOn;
  const speed = row.speedKph != null ? Number(row.speedKph) : 0;
  const lat = row.latitude;
  const lng = row.longitude;
  const pricePerLiter = Number(process.env.FUEL_PRICE_NGN_LITER || DEFAULT_FUEL_PRICE_NGN_LITER);

  const prevFuel = lastFuelByImei.get(imei);

  // 1. Refuel classification and Receipt Fraud Simulation (demo support)
  if (fuel != null) {
    if (prevFuel != null && fuel - prevFuel >= REFUEL_THRESHOLD_LITERS) {
      const actualAdded = fuel - prevFuel;
      const fraudKey = `${device.vehicleId}-fraud`;

      if (
        licensePlate === 'LAG-456-CD' &&
        !fraudSimulatedFor.has(fraudKey) &&
        !(await hasOpenAlert(device.customerId, device.vehicleId, 'receipt_fraud'))
      ) {
        const declared = Math.round(actualAdded + 15);
        const difference = declared - actualAdded;
        const loss = Math.round(difference * pricePerLiter);
        fraudSimulatedFor.add(fraudKey);

        await db.insert(alerts).values({
          imei,
          customerId: device.customerId,
          vehicleId: device.vehicleId,
          alertType: 'receipt_fraud',
          message: `Receipt mismatch at Mobil Ojota: claimed ${declared}L but OBD recorded ${actualAdded.toFixed(1)}L added (−${difference}L). Est. loss ₦${loss.toLocaleString('en-NG')}.`,
          fuelLevelLiters: fuel.toString(),
          fuelDropLiters: difference.toFixed(2),
          estimatedLossNgn: loss,
          latitude: lat,
          longitude: lng,
        });
      }
    }
    lastFuelByImei.set(imei, fuel);
  }

  // 2. Excessive Idling Engine
  const isIdle = ignitionOn && speed < 2;
  if (isIdle) {
    const streak = (idleStreakByImei.get(imei) || 0) + 1;
    idleStreakByImei.set(imei, streak);

    if (streak === 1 && fuel != null) {
      idleStartFuelByImei.set(imei, fuel);
      idleWasteAccumByImei.set(imei, 0);
    }

    if (fuel != null && prevFuel != null && fuel < prevFuel) {
      const tickWaste = prevFuel - fuel;
      idleWasteAccumByImei.set(imei, (idleWasteAccumByImei.get(imei) || 0) + tickWaste);
    } else if (fuel != null) {
      const intervalHours = TICK_INTERVAL_SEC / 3600;
      const tickWaste = idleFuelBurnLiters(intervalHours);
      idleWasteAccumByImei.set(imei, (idleWasteAccumByImei.get(imei) || 0) + tickWaste);
    }

    if (
      streak === IDLE_TICKS_FOR_ALERT &&
      !(await hasOpenAlert(device.customerId, device.vehicleId, 'excessive_idle'))
    ) {
      const measuredWaste = idleWasteAccumByImei.get(imei) || 0;
      const startFuel = idleStartFuelByImei.get(imei);
      const fuelDeltaWaste =
        startFuel != null && fuel != null ? Math.max(0, startFuel - fuel) : 0;
      const labeledWaste =
        (DEMO_IDLE_MINUTES_LABEL / 60) * IDLE_BURN_LITERS_PER_HOUR;
      const wastedLiters = Math.max(measuredWaste, fuelDeltaWaste, labeledWaste);

      await db.insert(alerts).values({
        imei,
        customerId: device.customerId,
        vehicleId: device.vehicleId,
        alertType: 'excessive_idle',
        message: `Excessive idling on ${licensePlate ?? 'vehicle'}: engine ON with zero speed for ~${DEMO_IDLE_MINUTES_LABEL} minutes (~${wastedLiters.toFixed(1)}L wasted at ${IDLE_BURN_LITERS_PER_HOUR} L/h).`,
        fuelLevelLiters: fuel?.toString() ?? null,
        fuelDropLiters: wastedLiters.toFixed(2),
        latitude: lat,
        longitude: lng,
      });
    }
  } else {
    idleStreakByImei.set(imei, 0);
    idleStartFuelByImei.delete(imei);
    idleWasteAccumByImei.delete(imei);
  }

  // 3. Noise-Proof Fuel Theft Detection Engine (Rules 1-10)
  try {
    // Reference base time is the recorded timestamp of the current telemetry row
    const nowTime = row.recordedAt instanceof Date ? row.recordedAt : new Date(row.recordedAt);
    const sixtyMinAgo = new Date(nowTime.getTime() - 60 * 60 * 1000);

    // Fetch telemetry history of last 60 minutes relative to the telemetry timestamp
    const history = await db
      .select({
        id: telemetry.id,
        recordedAt: telemetry.recordedAt,
        fuelLevelLiters: telemetry.fuelLevelLiters,
        odometerKm: telemetry.odometerKm,
        latitude: telemetry.latitude,
        longitude: telemetry.longitude,
        speedKph: telemetry.speedKph,
        ignitionOn: telemetry.ignitionOn,
      })
      .from(telemetry)
      .where(
        and(
          eq(telemetry.vehicleId, device.vehicleId),
          sql`recorded_at >= ${sixtyMinAgo.toISOString()}::timestamp`
        )
      )
      .orderBy(telemetry.recordedAt);

    if (history.length < 2) return;

    // Fetch vehicle configurations for thresholds
    const [vehicle] = await db
      .select({
        tankCapacityLiters: vehicles.tankCapacityLiters,
        model: vehicles.model,
      })
      .from(vehicles)
      .where(eq(vehicles.id, device.vehicleId))
      .limit(1);

    const tankCapacity = vehicle?.tankCapacityLiters || 60;
    // Rule 2: Minimum drop threshold of 5L or 5% of tank capacity
    const dropThreshold = Math.max(5, tankCapacity * 0.05);

    // Scan history for the best drop candidate (maximized drop within 30 min window)
    let bestDrop = null;
    let maxDropLiters = 0;

    for (let i = 0; i < history.length; i++) {
      const startPoint = history[i];
      if (startPoint.fuelLevelLiters == null) continue;
      const fStart = Number(startPoint.fuelLevelLiters);

      for (let j = i + 1; j < history.length; j++) {
        const lowPoint = history[j];
        if (lowPoint.fuelLevelLiters == null) continue;
        const fLow = Number(lowPoint.fuelLevelLiters);

        const timeDiffMin = (new Date(lowPoint.recordedAt) - new Date(startPoint.recordedAt)) / 60000;
        if (timeDiffMin > 30) break; // Rule 6/History search: group drops within 30 min window

        const drop = fStart - fLow;
        if (drop > maxDropLiters) {
          maxDropLiters = drop;
          bestDrop = { startPoint, lowPoint, dropLiters: drop };
        }
      }
    }

    if (!bestDrop || bestDrop.dropLiters < dropThreshold) {
      // Discard below threshold drops (Rule 2)
      return;
    }

    // Rule 3: Time validation window (Wait 3–10 minutes before confirming any drop)
    const tLast = new Date(history[history.length - 1].recordedAt);
    const tLow = new Date(bestDrop.lowPoint.recordedAt);
    const timeSinceLowMin = (tLast - tLow) / 60000;

    if (timeSinceLowMin < 3) {
      // Still in validation window, wait for more telemetry packets
      return;
    }

    // Rule 3: Rebound check (ignore if fuel level rebounds due to sensor slosh/noise)
    const lowIndex = history.findIndex(p => p.id === bestDrop.lowPoint.id);
    let rebounded = false;
    for (let k = lowIndex + 1; k < history.length; k++) {
      const p = history[k];
      if (p.fuelLevelLiters == null) continue;
      const f = Number(p.fuelLevelLiters);
      const fStart = Number(bestDrop.startPoint.fuelLevelLiters);
      const fLow = Number(bestDrop.lowPoint.fuelLevelLiters);
      const rise = f - fLow;
      if (f >= fStart - 1.5 || rise >= 0.5 * bestDrop.dropLiters) {
        rebounded = true;
        break;
      }
    }
    if (rebounded) {
      // Fuel rebounded, ignore noise (Rule 3)
      return;
    }

    // Rule 5: Physical impossibility rules (Reject unrealistic patterns)
    // - Drop while driving at speed
    const startIndex = history.findIndex(p => p.id === bestDrop.startPoint.id);
    let speedSum = 0;
    let speedPointsCount = 0;
    for (let k = startIndex; k <= lowIndex; k++) {
      const p = history[k];
      if (p.speedKph != null) {
        speedSum += Number(p.speedKph);
        speedPointsCount++;
      }
    }
    const avgSpeed = speedPointsCount > 0 ? speedSum / speedPointsCount : 0;
    if (avgSpeed > 15) {
      // Large drop while driving at speed is invalid siphoning behavior
      return;
    }

    // - Repeated rapid toggling in the last 30 minutes
    const thirtyMinAgo = new Date(nowTime.getTime() - 30 * 60 * 1000);
    const recentHistory = history.filter(p => new Date(p.recordedAt) >= thirtyMinAgo && p.fuelLevelLiters != null);
    let directionChanges = 0;
    let lastDirection = 0;
    for (let k = 0; k < recentHistory.length - 1; k++) {
      const diff = Number(recentHistory[k+1].fuelLevelLiters) - Number(recentHistory[k].fuelLevelLiters);
      if (Math.abs(diff) > 0.3) {
        const dir = diff > 0 ? 1 : -1;
        if (lastDirection !== 0 && dir !== lastDirection) {
          directionChanges++;
        }
        lastDirection = dir;
      }
    }
    if (directionChanges > 4) {
      // Repeated rapid toggling -> ignore as sensor noise/slosh
      return;
    }

    // Rule 7: Confidence score calculation (Assign weights)
    let score = 40; // Fuel drop detected

    // Check ignition state at the stabilized low point
    const isIgnitionOff = !bestDrop.lowPoint.ignitionOn;
    if (isIgnitionOff) {
      score += 20; // Ignition OFF
      score += 15; // No engine activity
    }

    // Check vehicle stationary (speed < 2 kph) at the stabilized low point
    const isStationary = bestDrop.lowPoint.speedKph === null || Number(bestDrop.lowPoint.speedKph) < 2;
    if (isStationary) {
      score += 15; // Vehicle stationary
    }

    // Check repeated pattern history (Rule 8: Statistical deviations / past records)
    const sevenDaysAgo = new Date(nowTime.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const pastAlerts = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(
        and(
          eq(alerts.vehicleId, device.vehicleId),
          eq(alerts.alertType, 'fuel_theft'),
          sql`created_at >= ${sevenDaysAgo}::timestamp`
        )
      )
      .limit(1);
    if (pastAlerts.length > 0) {
      score += 10; // Repeated pattern history
    }

    // Decision Logic
    if (score < 50) {
      // Score < 50: ignore/noise (Rule 7)
      return;
    }

    // Rule 6: Group events into clusters (Merge related fuel changes within 30-60 min)
    // Rule 10: Suppress alerts for same vehicle for 2-4 hours (Alert Cooldown)
    const fourHoursAgo = new Date(nowTime.getTime() - 4 * 60 * 60 * 1000).toISOString();
    const [latestSiphon] = await db
      .select()
      .from(siphonEvents)
      .where(
        and(
          eq(siphonEvents.vehicleId, device.vehicleId),
          sql`occurred_at >= ${fourHoursAgo}::timestamp`
        )
      )
      .orderBy(desc(siphonEvents.occurredAt))
      .limit(1);

    if (latestSiphon) {
      const minutesAgo = (nowTime.getTime() - new Date(latestSiphon.occurredAt).getTime()) / 60000;
      if (minutesAgo <= 60) {
        // Merge into existing cluster event
        const originalFuelBefore = Number(latestSiphon.fuelLevelBefore);
        const newFuelAfter = Number(bestDrop.lowPoint.fuelLevelLiters);
        const cumulativeDrop = originalFuelBefore - newFuelAfter;

        if (cumulativeDrop > 0) {
          const estimatedLossNgn = Math.round(cumulativeDrop * pricePerLiter);

          // Update siphon event fields
          await db
            .update(siphonEvents)
            .set({
              litersStolen: cumulativeDrop.toFixed(2),
              estimatedLossNgn,
              fuelLevelAfter: newFuelAfter.toFixed(2),
              occurredAt: new Date(bestDrop.lowPoint.recordedAt),
            })
            .where(eq(siphonEvents.id, latestSiphon.id));

          // Update related alert fields
          if (latestSiphon.alertId) {
            const tempLat = bestDrop.lowPoint.latitude;
            const tempLng = bestDrop.lowPoint.longitude;
            const locationHint = tempLat && tempLng ? ` near ${Number(tempLat).toFixed(5)}, ${Number(tempLng).toFixed(5)}` : '';

            await db
              .update(alerts)
              .set({
                fuelLevelLiters: newFuelAfter.toString(),
                fuelDropLiters: cumulativeDrop.toFixed(2),
                estimatedLossNgn,
                latitude: tempLat,
                longitude: tempLng,
                message: `Fuel theft detected${locationHint}! Cumulative level dropped ${cumulativeDrop.toFixed(1)}L while parked (${originalFuelBefore.toFixed(1)}L → ${newFuelAfter.toFixed(1)}L). Estimated loss ${estimatedLossNgn.toLocaleString('en-NG')} NGN. (Merged cluster)`,
              })
              .where(eq(alerts.id, latestSiphon.alertId));
          }
          console.log(`[Theft Engine] Merged cluster drop for vehicle ${device.vehicleId}: cumulative drop ${cumulativeDrop.toFixed(1)}L`);
        }
        return;
      } else {
        // Cooldown period: Suppress new alerts for 2-4 hours
        console.log(`[Theft Engine] Suppressed new alert for vehicle ${device.vehicleId} due to cooldown`);
        return;
      }
    }

    // Raise new Alert & Siphon Event
    const drop = bestDrop.dropLiters;
    const estimatedLossNgn = Math.round(drop * pricePerLiter);
    const locationHint = lat && lng ? ` near ${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}` : '';

    let alertId = null;
    const status = score >= 80 ? 'active' : 'review';

    if (score >= 80) {
      const [alertRow] = await db
        .insert(alerts)
        .values({
          imei: device.imei,
          customerId: device.customerId,
          vehicleId: device.vehicleId,
          alertType: 'fuel_theft',
          message: `Fuel theft detected${locationHint}! Level dropped ${drop.toFixed(1)}L while parked (${Number(bestDrop.startPoint.fuelLevelLiters).toFixed(1)}L → ${Number(bestDrop.lowPoint.fuelLevelLiters).toFixed(1)}L). Estimated loss ${estimatedLossNgn.toLocaleString('en-NG')} NGN.`,
          fuelLevelLiters: bestDrop.lowPoint.fuelLevelLiters.toString(),
          fuelDropLiters: drop.toFixed(2),
          estimatedLossNgn,
          latitude: lat,
          longitude: lng,
        })
        .returning({ id: alerts.id });
      alertId = alertRow.id;
      console.log(`⚠️ [Theft Engine] Generated new fuel theft alert for ${device.imei}: -${drop.toFixed(1)}L`);
    } else {
      console.log(`🔍 [Theft Engine] Generated review-only siphon event for ${device.imei}: -${drop.toFixed(1)}L (Confidence score: ${score})`);
    }

    await recordSiphonEvent({
      customerId: device.customerId,
      vehicleId: device.vehicleId,
      alertId,
      occurredAt: new Date(bestDrop.lowPoint.recordedAt),
      litersStolen: drop,
      estimatedLossNgn,
      fuelLevelBefore: bestDrop.startPoint.fuelLevelLiters,
      fuelLevelAfter: bestDrop.lowPoint.fuelLevelLiters,
      engineStateBefore: bestDrop.startPoint.ignitionOn,
      engineStateAfter: bestDrop.lowPoint.ignitionOn,
      latitude: lat,
      longitude: lng,
      locationName: lat && lng ? `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}` : null,
      status,
    });

  } catch (error) {
    console.error('[Theft Engine] Error processing fuel theft detection rules:', error);
  }
}

module.exports = { detectAnomalies, getOrComputeVehicleBaseline, resetEngineState };
