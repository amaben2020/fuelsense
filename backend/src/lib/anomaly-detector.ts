import { db, alerts, siphonEvents, vehicles, telemetry, eq, and, desc, sql } from './db-helpers';
import {
  REFUEL_THRESHOLD_LITERS,
  idleFuelBurnLiters,
  IDLE_BURN_LITERS_PER_HOUR,
  DEFAULT_FUEL_PRICE_NGN_LITER,
  baselineEfficiencyKmL,
} from './fuel-metrics';
import { recordSiphonEvent } from './siphon-recorder';

const idleStreakByImei = new Map<string, number>();
const idleStartFuelByImei = new Map<string, number>();
const idleWasteAccumByImei = new Map<string, number>();
const lastFuelByImei = new Map<string, number>();
const fraudSimulatedFor = new Set<string>();
const baselineCache = new Map<string, { baseline: VehicleBaseline; expiresAt: number }>();

const TICK_INTERVAL_SEC = Number(process.env.MOCK_INTERVAL_MS || 4000) / 1000;
const IDLE_TICKS_FOR_ALERT = 12;
const DEMO_IDLE_MINUTES_LABEL = 45;
const BASELINE_TTL_MS = 24 * 60 * 60 * 1000;

interface VehicleBaseline {
  avgFuelPerKm: number;
  avgIdleFuelPerHour: number;
  typicalVariance: number;
}

export function resetEngineState(): void {
  idleStreakByImei.clear();
  idleStartFuelByImei.clear();
  idleWasteAccumByImei.clear();
  lastFuelByImei.clear();
  fraudSimulatedFor.clear();
  baselineCache.clear();
}

async function hasOpenAlert(customerId: string, vehicleId: string, alertType: string): Promise<boolean> {
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

export async function getOrComputeVehicleBaseline(vehicleId: string, model: string | null, nowTime = new Date()): Promise<VehicleBaseline> {
  const cached = baselineCache.get(vehicleId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.baseline;
  }

  const defaultKmL = baselineEfficiencyKmL(model || 'Hiace');
  const defaultIdlePerHour = IDLE_BURN_LITERS_PER_HOUR;
  const defaultBaseline: VehicleBaseline = {
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
    const differences: number[] = [];

    for (let i = 0; i < rows.length - 1; i++) {
      const curr = rows[i];
      const next = rows[i + 1];
      if (curr.fuelLevelLiters == null || next.fuelLevelLiters == null) continue;

      const fCurr = Number(curr.fuelLevelLiters);
      const fNext = Number(next.fuelLevelLiters);
      const deltaF = fCurr - fNext;
      const deltaT = (new Date(next.recordedAt).getTime() - new Date(curr.recordedAt).getTime()) / 3600000;

      if (deltaF < -REFUEL_THRESHOLD_LITERS || deltaF > 15) continue;

      if (curr.ignitionOn && (curr.speedKph ?? 0) > 2) {
        const oCurr = curr.odometerKm;
        const oNext = next.odometerKm;
        if (oCurr != null && oNext != null) {
          const deltaO = oNext - oCurr;
          if (deltaO > 0 && deltaF > 0) {
            totalDrivingFuel += deltaF;
            totalDrivingDistance += deltaO;
          }
        }
      } else if (curr.ignitionOn && (curr.speedKph ?? 0) <= 2) {
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

    const baseline: VehicleBaseline = {
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

interface DeviceInfo {
  imei: string;
  customerId: string;
  vehicleId: string;
}

interface TelemetryRow {
  fuelLevelLiters?: string | number | null;
  ignitionOn?: boolean | null;
  speedKph?: number | null;
  latitude?: string | number | null;
  longitude?: string | number | null;
  recordedAt: Date | string;
}

export async function detectAnomalies(device: DeviceInfo, row: TelemetryRow, { licensePlate }: { licensePlate?: string } = {}): Promise<void> {
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
          latitude: lat?.toString() ?? null,
          longitude: lng?.toString() ?? null,
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
        latitude: lat?.toString() ?? null,
        longitude: lng?.toString() ?? null,
      });
    }
  } else {
    idleStreakByImei.set(imei, 0);
    idleStartFuelByImei.delete(imei);
    idleWasteAccumByImei.delete(imei);
  }

  // 3. Noise-Proof Fuel Theft Detection Engine (Rules 1-10)
  try {
    const nowTime = row.recordedAt instanceof Date ? row.recordedAt : new Date(row.recordedAt);
    const sixtyMinAgo = new Date(nowTime.getTime() - 60 * 60 * 1000);

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

    const [vehicle] = await db
      .select({
        tankCapacityLiters: vehicles.tankCapacityLiters,
        model: vehicles.model,
      })
      .from(vehicles)
      .where(eq(vehicles.id, device.vehicleId))
      .limit(1);

    const tankCapacity = vehicle?.tankCapacityLiters || 60;
    const dropThreshold = Math.max(5, tankCapacity * 0.05);

    let bestDrop: { startPoint: typeof history[0]; lowPoint: typeof history[0]; dropLiters: number } | null = null;
    let maxDropLiters = 0;

    for (let i = 0; i < history.length; i++) {
      const startPoint = history[i];
      if (startPoint.fuelLevelLiters == null) continue;
      const fStart = Number(startPoint.fuelLevelLiters);

      for (let j = i + 1; j < history.length; j++) {
        const lowPoint = history[j];
        if (lowPoint.fuelLevelLiters == null) continue;
        const fLow = Number(lowPoint.fuelLevelLiters);

        const timeDiffMin = (new Date(lowPoint.recordedAt).getTime() - new Date(startPoint.recordedAt).getTime()) / 60000;
        if (timeDiffMin > 30) break;

        const drop = fStart - fLow;
        if (drop > maxDropLiters) {
          maxDropLiters = drop;
          bestDrop = { startPoint, lowPoint, dropLiters: drop };
        }
      }
    }

    if (!bestDrop || bestDrop.dropLiters < dropThreshold) return;

    const tLast = new Date(history[history.length - 1].recordedAt);
    const tLow = new Date(bestDrop.lowPoint.recordedAt);
    const timeSinceLowMin = (tLast.getTime() - tLow.getTime()) / 60000;

    if (timeSinceLowMin < 3) return;

    const lowIndex = history.findIndex(p => p.id === bestDrop!.lowPoint.id);
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
    if (rebounded) return;

    const startIndex = history.findIndex(p => p.id === bestDrop!.startPoint.id);
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
    if (avgSpeed > 15) return;

    const thirtyMinAgo = new Date(nowTime.getTime() - 30 * 60 * 1000);
    const recentHistory = history.filter(p => new Date(p.recordedAt) >= thirtyMinAgo && p.fuelLevelLiters != null);
    let directionChanges = 0;
    let lastDirection = 0;
    for (let k = 0; k < recentHistory.length - 1; k++) {
      const diff = Number(recentHistory[k + 1].fuelLevelLiters) - Number(recentHistory[k].fuelLevelLiters);
      if (Math.abs(diff) > 0.3) {
        const dir = diff > 0 ? 1 : -1;
        if (lastDirection !== 0 && dir !== lastDirection) {
          directionChanges++;
        }
        lastDirection = dir;
      }
    }
    if (directionChanges > 4) return;

    let score = 40;

    const isIgnitionOff = !bestDrop.lowPoint.ignitionOn;
    if (isIgnitionOff) {
      score += 20;
      score += 15;
    }

    const isStationary = bestDrop.lowPoint.speedKph === null || Number(bestDrop.lowPoint.speedKph) < 2;
    if (isStationary) {
      score += 15;
    }

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
      score += 10;
    }

    if (score < 50) return;

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
        const originalFuelBefore = Number(latestSiphon.fuelLevelBefore);
        const newFuelAfter = Number(bestDrop.lowPoint.fuelLevelLiters);
        const cumulativeDrop = originalFuelBefore - newFuelAfter;

        if (cumulativeDrop > 0) {
          const estimatedLossNgn = Math.round(cumulativeDrop * pricePerLiter);

          await db
            .update(siphonEvents)
            .set({
              litersStolen: cumulativeDrop.toFixed(2),
              estimatedLossNgn,
              fuelLevelAfter: newFuelAfter.toFixed(2),
              occurredAt: new Date(bestDrop.lowPoint.recordedAt),
            })
            .where(eq(siphonEvents.id, latestSiphon.id));

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
        console.log(`[Theft Engine] Suppressed new alert for vehicle ${device.vehicleId} due to cooldown`);
        return;
      }
    }

    const drop = bestDrop.dropLiters;
    const estimatedLossNgn = Math.round(drop * pricePerLiter);
    const locationHint = lat && lng ? ` near ${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}` : '';

    let alertId: number | null = null;
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
          fuelLevelLiters: bestDrop.lowPoint.fuelLevelLiters!.toString(),
          fuelDropLiters: drop.toFixed(2),
          estimatedLossNgn,
          latitude: lat?.toString() ?? null,
          longitude: lng?.toString() ?? null,
        })
        .returning({ id: alerts.id });
      alertId = alertRow.id;
      console.log(`[Theft Engine] Generated new fuel theft alert for ${device.imei}: -${drop.toFixed(1)}L`);
    } else {
      console.log(`[Theft Engine] Generated review-only siphon event for ${device.imei}: -${drop.toFixed(1)}L (Confidence score: ${score})`);
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
      latitude: lat?.toString() ?? null,
      longitude: lng?.toString() ?? null,
      locationName: lat && lng ? `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}` : null,
      status,
    });

  } catch (error) {
    console.error('[Theft Engine] Error processing fuel theft detection rules:', error);
  }
}
