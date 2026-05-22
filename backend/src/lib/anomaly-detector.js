const { db, alerts, eq, and } = require('./db-helpers');
const {
  REFUEL_THRESHOLD_LITERS,
  idleFuelBurnLiters,
  IDLE_BURN_LITERS_PER_HOUR,
} = require('./fuel-metrics');

const idleStreakByImei = new Map();
const idleStartFuelByImei = new Map();
const idleWasteAccumByImei = new Map();
const lastFuelByImei = new Map();
const fraudSimulatedFor = new Set();

const TICK_INTERVAL_SEC = Number(process.env.MOCK_INTERVAL_MS || 4000) / 1000;
const IDLE_TICKS_FOR_ALERT = 12;
const DEMO_IDLE_MINUTES_LABEL = 45;

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

async function detectAnomalies(device, row, { licensePlate } = {}) {
  if (!device.customerId || !device.vehicleId) return;

  const imei = device.imei;
  const fuel = row.fuelLevelLiters != null ? Number(row.fuelLevelLiters) : null;
  const ignitionOn = !!row.ignitionOn;
  const speed = row.speedKph != null ? Number(row.speedKph) : 0;
  const lat = row.latitude;
  const lng = row.longitude;
  const pricePerLiter = Number(process.env.FUEL_PRICE_NGN_LITER || 650);

  const prevFuel = lastFuelByImei.get(imei);
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
}

module.exports = { detectAnomalies };
