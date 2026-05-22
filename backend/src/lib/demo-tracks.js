const { sampleEfficiencyKmL, fuelUsedForDistanceKm, DEFAULT_FUEL_PRICE_NGN_LITER } = require('./fuel-metrics');

const LAGOS_ROUTES = [
  { lat: 6.5244, lng: 3.3792, heading: 0.6 },
  { lat: 6.6018, lng: 3.3515, heading: 1.1 },
  { lat: 6.4474, lng: 3.4738, heading: 2.0 },
  { lat: 6.5789, lng: 3.2802, heading: 0.85 },
  { lat: 6.4969, lng: 3.3346, heading: 1.65 },
  { lat: 6.5355, lng: 3.3087, heading: 2.4 },
  { lat: 6.4698, lng: 3.5852, heading: 0.3 },
];

const MERCHANTS = [
  'TotalEnergies Ikeja',
  'Mobil Ojota',
  'NNPC Apapa',
  'MRS Lekki',
  'Oando VI',
];

/**
 * Physics-based demo GPS path for live map when no telemetry exists yet.
 * Uses the same distance/fuel relationship as the fleet simulator.
 */
function generateDemoTracksForFleet(fleetRows, options = {}) {
  const intervalMinutes = options.intervalMinutes ?? 4;
  const durationMinutes = options.minutes ?? 90;
  const stepCount = Math.max(8, Math.floor(durationMinutes / intervalMinutes));
  const intervalHours = intervalMinutes / 60;
  const pricePerLiter = Number(process.env.FUEL_PRICE_NGN_LITER || DEFAULT_FUEL_PRICE_NGN_LITER);

  const allPoints = [];

  fleetRows.forEach((vehicle, index) => {
    const route = LAGOS_ROUTES[index % LAGOS_ROUTES.length];
    let lat = route.lat + (Math.random() - 0.5) * 0.01;
    let lng = route.lng + (Math.random() - 0.5) * 0.01;
    let heading = route.heading;
    const model = vehicle.model || 'Hiace';
    const efficiencyKmL = sampleEfficiencyKmL(model, (index + 1) / (fleetRows.length + 1));
    let fuelLevel = Number(vehicle.fuel_level_liters) || 35 + Math.random() * 20;
    const tankCapacity = Number(vehicle.tank_capacity_liters) || 60;

    for (let step = stepCount; step >= 0; step -= 1) {
      const recordedAt = new Date(Date.now() - step * intervalMinutes * 60 * 1000);
      let speedKph = 0;
      let ignitionOn = false;

      if (step < stepCount) {
        heading += (Math.random() - 0.5) * 0.35;
        const distanceKm = (40 + Math.random() * 25) * intervalHours;
        lat += Math.cos(heading) * (distanceKm / 111);
        lng += Math.sin(heading) * (distanceKm / (111 * Math.cos((lat * Math.PI) / 180)));
        speedKph = Math.round(distanceKm / intervalHours);
        ignitionOn = speedKph > 5;
        const burn = fuelUsedForDistanceKm(distanceKm, efficiencyKmL);
        fuelLevel = Math.max(10, fuelLevel - burn);
        if (fuelLevel < 18) fuelLevel = Math.min(tankCapacity, fuelLevel + 28);
      } else {
        speedKph = Math.round(20 + Math.random() * 35);
        ignitionOn = true;
      }

      allPoints.push({
        vehicle_id: vehicle.id,
        imei: vehicle.imei ?? `demo-${index}`,
        license_plate: vehicle.license_plate,
        make: vehicle.make ?? 'Toyota',
        model: vehicle.model,
        driver_name: vehicle.driver_name ?? null,
        latitude: lat.toFixed(6),
        longitude: lng.toFixed(6),
        speed_kph: speedKph,
        fuel_level_liters: fuelLevel.toFixed(1),
        ignition_on: ignitionOn,
        recorded_at: recordedAt.toISOString(),
      });
    }
  });

  return allPoints.sort(
    (a, b) =>
      a.vehicle_id.localeCompare(b.vehicle_id) ||
      new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
  );
}

function demoFuelPurchases(fleetRows, options = {}) {
  const days = options.days ?? 14;
  const pricePerLiter = Number(process.env.FUEL_PRICE_NGN_LITER || DEFAULT_FUEL_PRICE_NGN_LITER);
  const purchases = [];
  let seq = 0;

  for (const vehicle of fleetRows) {
    const refuelCount = 2 + Math.floor(Math.random() * 2);
    const isTheftVehicle = vehicle.license_plate === 'LAG-456-CD';

    for (let i = 0; i < refuelCount; i += 1) {
      const daysAgo = 1 + Math.floor(Math.random() * days);
      const litersActual = Math.round(45 + Math.random() * 25);
      const theftLiters = isTheftVehicle && i === 0 ? 15 : 0;
      const litersDeclared = litersActual + theftLiters;
      const differenceLiters = Math.max(0, litersDeclared - litersActual);
      const costPerLiter = pricePerLiter + Math.floor(Math.random() * 30);

      purchases.push({
        id: `demo-p-${seq++}`,
        vehicle_id: vehicle.id,
        license_plate: vehicle.license_plate,
        timestamp: new Date(Date.now() - daysAgo * 86400000).toISOString(),
        liters_declared: litersDeclared,
        liters_actual: litersActual,
        difference_liters: differenceLiters,
        cost_per_liter_ngn: costPerLiter,
        total_cost_ngn: Math.round(litersDeclared * costPerLiter),
        merchant: MERCHANTS[seq % MERCHANTS.length],
        status:
          differenceLiters >= 10 ? 'flagged_theft' : differenceLiters > 0 ? 'pending_receipt' : 'verified',
      });
    }
  }

  return purchases.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

module.exports = { generateDemoTracksForFleet, demoFuelPurchases, LAGOS_ROUTES };
