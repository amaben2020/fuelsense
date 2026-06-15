require('dotenv').config();

const { db, initDatabase, closePool } = require('./db');
const { customers, vehicles, devices, telemetry } = require('./db/schema');
const { eq } = require('drizzle-orm');
const {
  sampleEfficiencyKmL,
  fuelUsedForDistanceKm,
  idleFuelBurnLiters,
} = require('./lib/fuel-metrics');

const DEMO_EMAIL = 'demo@fuelsense.local';
const INTERVAL_MINUTES = 5;
const HISTORY_DAYS = 7;
const RESERVE_LITERS = 12;

const LAGOS_ROUTES = [
  { lat: 6.5244, lng: 3.3792 }, // Victoria Island
  { lat: 6.6018, lng: 3.3515 }, // Ikeja
  { lat: 6.4474, lng: 3.4738 }, // Lekki
  { lat: 6.5789, lng: 3.2802 }, // Agege
  { lat: 6.4969, lng: 3.3346 }, // Surulere
];

function dailyTargetDistanceKm(model) {
  const ranges = {
    Hiace: [280, 450],
    Hilux: [250, 420],
    Camry: [180, 380],
    RAV4: [200, 520],
  };
  const [min, max] = ranges[model] || [200, 400];
  return min + Math.random() * (max - min);
}

function maybeRefuel(fuelLevel, tankCapacity, litersNeeded) {
  if (fuelLevel >= litersNeeded + RESERVE_LITERS) return fuelLevel;
  const topUp = Math.min(tankCapacity, 28 + Math.random() * 18);
  return Math.min(tankCapacity, fuelLevel + topUp);
}

async function generateVehicleHistory(vehicle, device, routeIndex) {
  const efficiencyKmL = sampleEfficiencyKmL(vehicle.model);
  const tankCapacity = Number(vehicle.tankCapacityLiters) || 60;
  let fuelLevel = tankCapacity * (0.65 + Math.random() * 0.25);
  let odometerKm = 8000 + routeIndex * 12000 + Math.floor(Math.random() * 5000);
  let lat = LAGOS_ROUTES[routeIndex % LAGOS_ROUTES.length].lat;
  let lng = LAGOS_ROUTES[routeIndex % LAGOS_ROUTES.length].lng;

  const rows = [];
  const now = Date.now();
  const ticksPerDay = Math.floor((24 * 60) / INTERVAL_MINUTES);
  const totalTicks = ticksPerDay * HISTORY_DAYS;
  const intervalHours = INTERVAL_MINUTES / 60;
  const activeHoursPerDay = 9 + Math.random() * 3;
  const activeTicksPerDay = Math.floor((activeHoursPerDay * 60) / INTERVAL_MINUTES);

  const dailyPlans = Array.from({ length: HISTORY_DAYS + 1 }, () =>
    dailyTargetDistanceKm(vehicle.model)
  );

  for (let tick = totalTicks; tick >= 0; tick -= 1) {
    const recordedAt = new Date(now - tick * INTERVAL_MINUTES * 60 * 1000);
    const dayIndex = Math.floor(tick / ticksPerDay);
    const tickInDay = tick % ticksPerDay;
    const isActive = tickInDay < activeTicksPerDay;
    const dailyDistance = dailyPlans[dayIndex] ?? dailyPlans[0];
    const distancePerActiveTick = dailyDistance / activeTicksPerDay;

    let speedKph = 0;
    let ignitionOn = false;
    let distanceKm = 0;

    if (isActive) {
      ignitionOn = true;
      distanceKm = distancePerActiveTick * (0.92 + Math.random() * 0.16);
      speedKph = Math.round(distanceKm / intervalHours);
      const burn = fuelUsedForDistanceKm(distanceKm, efficiencyKmL);
      fuelLevel = maybeRefuel(fuelLevel, tankCapacity, burn);
      fuelLevel -= burn;
      odometerKm += distanceKm;
      lat += (Math.random() - 0.5) * 0.004;
      lng += (Math.random() - 0.5) * 0.004;
    } else if (Math.random() < 0.12) {
      ignitionOn = true;
      speedKph = 0;
      const idleBurn = idleFuelBurnLiters(intervalHours);
      fuelLevel = maybeRefuel(fuelLevel, tankCapacity, idleBurn);
      fuelLevel -= idleBurn;
    }

    rows.push({
      imei: device.imei,
      customerId: vehicle.customerId,
      vehicleId: vehicle.id,
      recordedAt,
      fuelLevelLiters: fuelLevel.toFixed(2),
      odometerKm: Math.round(odometerKm),
      latitude: lat.toFixed(6),
      longitude: lng.toFixed(6),
      speedKph,
      ignitionOn,
    });
  }

  return rows;
}

/**
 * Seeds 7-day telemetry history for all vehicles belonging to the demo customer.
 * Can be called as a module (pass an open db connection) or as a standalone script.
 */
async function seedTelemetryForCustomer(dbConn, customerId) {
  const fleet = await dbConn
    .select({
      id: vehicles.id,
      customerId: vehicles.customerId,
      licensePlate: vehicles.licensePlate,
      model: vehicles.model,
      tankCapacityLiters: vehicles.tankCapacityLiters,
    })
    .from(vehicles)
    .where(eq(vehicles.customerId, customerId));

  await dbConn.delete(telemetry).where(eq(telemetry.customerId, customerId));

  let totalRows = 0;

  for (let i = 0; i < fleet.length; i += 1) {
    const vehicle = fleet[i];
    const [device] = await dbConn
      .select({ imei: devices.imei })
      .from(devices)
      .where(eq(devices.vehicleId, vehicle.id));

    if (!device) continue;

    const rows = await generateVehicleHistory(vehicle, device, i);
    const batchSize = 500;
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      await dbConn.insert(telemetry).values(rows.slice(offset, offset + batchSize));
    }
    totalRows += rows.length;
    console.log(`  ${vehicle.licensePlate} (${vehicle.model || 'RAV4'}): ${rows.length} readings`);
  }

  console.log(`\nTelemetry seed complete: ${totalRows} rows over ${HISTORY_DAYS} days`);
  return totalRows;
}

module.exports = { seedTelemetryForCustomer };

// Run standalone when invoked directly
if (require.main === module) {
  (async () => {
    await initDatabase();

    const [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.email, DEMO_EMAIL));

    if (!customer) {
      throw new Error('Demo customer not found. Run npm run seed first.');
    }

    await seedTelemetryForCustomer(db, customer.id);
    await closePool();
  })().catch((error) => {
    console.error('Telemetry seed failed:', error);
    process.exit(1);
  });
}
