require('dotenv').config();
const { db, vehicles, devices, telemetry, alerts, siphonEvents, eq, and, sql } = require('./lib/db-helpers');
const { detectAnomalies, resetEngineState } = require('./lib/anomaly-detector');

async function cleanTestData(vehicleId) {
  resetEngineState();
  await db.execute(sql`DELETE FROM telemetry WHERE vehicle_id = ${vehicleId}`);
  await db.execute(sql`DELETE FROM siphon_events WHERE vehicle_id = ${vehicleId}`);
  await db.execute(sql`DELETE FROM alerts WHERE vehicle_id = ${vehicleId}`);
}

async function insertTelemetryRow(device, data) {
  const [row] = await db
    .insert(telemetry)
    .values({
      imei: device.imei,
      customerId: device.customerId,
      vehicleId: device.vehicleId,
      fuelLevelLiters: data.fuelLevelLiters.toFixed(2),
      odometerKm: data.odometerKm || 1000,
      latitude: data.latitude || '6.5244',
      longitude: data.longitude || '3.3792',
      speedKph: data.speedKph || 0,
      ignitionOn: data.ignitionOn,
      recordedAt: data.recordedAt,
    })
    .returning();
  return row;
}

async function runTests() {
  console.log('--- STARTING NOISE-PROOF THEFT ENGINE VERIFICATION TESTS ---');

  // Find vehicle LAG-456-CD (our standard mainland/theft simulator vehicle)
  const [vehicle] = await db
    .select()
    .from(vehicles)
    .where(eq(vehicles.licensePlate, 'LAG-456-CD'))
    .limit(1);

  if (!vehicle) {
    console.error('Vehicle LAG-456-CD not found. Please run seed script first.');
    process.exit(1);
  }

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.vehicleId, vehicle.id))
    .limit(1);

  if (!device) {
    console.error('Device for vehicle LAG-456-CD not found. Please run seed script first.');
    process.exit(1);
  }

  const deviceContext = {
    imei: device.imei,
    customerId: device.customerId,
    vehicleId: vehicle.id,
  };

  const baseTime = new Date();

  // Test Case 1: Noise - Single signal drop / Small drop below threshold
  console.log('\nTest Case 1: Drop below threshold (3L)...');
  await cleanTestData(vehicle.id);
  
  // t0: base fuel 45L
  await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 45.0,
    ignitionOn: false,
    speedKph: 0,
    recordedAt: new Date(baseTime.getTime() - 10 * 60 * 1000),
  });
  // t1: fuel 42L (drop of 3L)
  const row1 = await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 42.0,
    ignitionOn: false,
    speedKph: 0,
    recordedAt: new Date(baseTime.getTime() - 5 * 60 * 1000),
  });
  // t2: check validation window (now)
  const row2 = await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 42.0,
    ignitionOn: false,
    speedKph: 0,
    recordedAt: baseTime,
  });

  await detectAnomalies(deviceContext, row2, { licensePlate: vehicle.licensePlate });

  const activeAlerts1 = await db.select().from(alerts).where(eq(alerts.vehicleId, vehicle.id));
  const activeSiphons1 = await db.select().from(siphonEvents).where(eq(siphonEvents.vehicleId, vehicle.id));
  console.log(`-> Alerts: ${activeAlerts1.length}, Siphon events: ${activeSiphons1.length}`);
  if (activeAlerts1.length === 0 && activeSiphons1.length === 0) {
    console.log('✅ PASS: Drop below threshold ignored.');
  } else {
    console.error('❌ FAIL: Small drop triggered alarm/event.');
  }

  // Test Case 2: Noise - Rebounding drop (sensor slosh/noise)
  console.log('\nTest Case 2: Drop with rebound (+8L)...');
  await cleanTestData(vehicle.id);

  // t0: base fuel 45L
  await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 45.0,
    ignitionOn: false,
    speedKph: 0,
    recordedAt: new Date(baseTime.getTime() - 15 * 60 * 1000),
  });
  // t1: drop to 33L (-12L)
  await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 33.0,
    ignitionOn: false,
    speedKph: 0,
    recordedAt: new Date(baseTime.getTime() - 10 * 60 * 1000),
  });
  // t2: rebound to 41L (+8L rebound)
  const rowRebound = await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 41.0,
    ignitionOn: false,
    speedKph: 0,
    recordedAt: baseTime,
  });

  await detectAnomalies(deviceContext, rowRebound, { licensePlate: vehicle.licensePlate });

  const activeAlerts2 = await db.select().from(alerts).where(eq(alerts.vehicleId, vehicle.id));
  console.log(`-> Alerts: ${activeAlerts2.length}`);
  if (activeAlerts2.length === 0) {
    console.log('✅ PASS: Rebound drop correctly ignored.');
  } else {
    console.error('❌ FAIL: Rebound drop triggered an alert.');
  }

  // Test Case 3: Noise - Drop at speed
  console.log('\nTest Case 3: Drop at speed (15L drop while driving at 40 kph)...');
  await cleanTestData(vehicle.id);

  await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 45.0,
    ignitionOn: true,
    speedKph: 40,
    recordedAt: new Date(baseTime.getTime() - 10 * 60 * 1000),
  });
  const rowSpeed = await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 30.0,
    ignitionOn: true,
    speedKph: 40,
    recordedAt: baseTime,
  });

  await detectAnomalies(deviceContext, rowSpeed, { licensePlate: vehicle.licensePlate });

  const activeAlerts3 = await db.select().from(alerts).where(eq(alerts.vehicleId, vehicle.id));
  console.log(`-> Alerts: ${activeAlerts3.length}`);
  if (activeAlerts3.length === 0) {
    console.log('✅ PASS: Drop at speed correctly ignored.');
  } else {
    console.error('❌ FAIL: Drop at speed triggered an alert.');
  }

  // Test Case 4: Noise - Repeated rapid toggling
  console.log('\nTest Case 4: Repeated rapid toggling...');
  await cleanTestData(vehicle.id);

  // insert toggling readings every 1 minute
  for (let m = 15; m >= 0; m--) {
    // toggling between 45 and 42
    const fuelVal = m % 2 === 0 ? 45.0 : 42.0;
    const rowT = await insertTelemetryRow(deviceContext, {
      fuelLevelLiters: fuelVal,
      ignitionOn: false,
      speedKph: 0,
      recordedAt: new Date(baseTime.getTime() - m * 60 * 1000),
    });
    if (m === 0) {
      await detectAnomalies(deviceContext, rowT, { licensePlate: vehicle.licensePlate });
    }
  }

  const activeAlerts4 = await db.select().from(alerts).where(eq(alerts.vehicleId, vehicle.id));
  console.log(`-> Alerts: ${activeAlerts4.length}`);
  if (activeAlerts4.length === 0) {
    console.log('✅ PASS: Rapid toggling noise correctly ignored.');
  } else {
    console.error('❌ FAIL: Rapid toggling triggered an alert.');
  }

  // Test Case 5: Valid Theft - Parked and Ignition OFF (Score 90: Drop 15L)
  console.log('\nTest Case 5: Valid siphoning: Parked, Ignition OFF (Critical Alert)...');
  await cleanTestData(vehicle.id);

  // t0: parked, engine on
  await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 45.0,
    ignitionOn: true,
    speedKph: 0,
    recordedAt: new Date(baseTime.getTime() - 10 * 60 * 1000),
  });
  // t1: engine off, drop starts
  await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 45.0,
    ignitionOn: false,
    speedKph: 0,
    recordedAt: new Date(baseTime.getTime() - 8 * 60 * 1000),
  });
  // t2: fuel 30L (drop of 15L)
  await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 30.0,
    ignitionOn: false,
    speedKph: 0,
    recordedAt: new Date(baseTime.getTime() - 4 * 60 * 1000),
  });
  // t3: check validation window (now)
  const rowTheft = await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 30.0,
    ignitionOn: false,
    speedKph: 0,
    recordedAt: baseTime,
  });

  await detectAnomalies(deviceContext, rowTheft, { licensePlate: vehicle.licensePlate });

  const activeAlerts5 = await db.select().from(alerts).where(eq(alerts.vehicleId, vehicle.id));
  const activeSiphons5 = await db.select().from(siphonEvents).where(eq(siphonEvents.vehicleId, vehicle.id));
  console.log(`-> Alerts: ${activeAlerts5.length}, Siphon events: ${activeSiphons5.length}`);
  if (activeAlerts5.length === 1 && activeSiphons5.length === 1 && activeSiphons5[0].status === 'active') {
    console.log('✅ PASS: Critical alert and active siphon event triggered correctly!');
  } else {
    console.error('❌ FAIL: Valid theft alert/event failed to trigger.');
  }

  // Test Case 6: Valid Theft - Parked and Ignition ON (Score 55: Drop 15L, Review-only)
  console.log('\nTest Case 6: Valid siphoning: Parked, Ignition ON (Review-only Event)...');
  await cleanTestData(vehicle.id);

  // t0: parked, engine on
  await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 45.0,
    ignitionOn: true,
    speedKph: 0,
    recordedAt: new Date(baseTime.getTime() - 10 * 60 * 1000),
  });
  // t1: fuel 30L (drop of 15L, engine still ON)
  await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 30.0,
    ignitionOn: true,
    speedKph: 0,
    recordedAt: new Date(baseTime.getTime() - 5 * 60 * 1000),
  });
  // t2: check validation window
  const rowReview = await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 30.0,
    ignitionOn: true,
    speedKph: 0,
    recordedAt: baseTime,
  });

  await detectAnomalies(deviceContext, rowReview, { licensePlate: vehicle.licensePlate });

  const activeAlerts6 = await db.select().from(alerts).where(eq(alerts.vehicleId, vehicle.id));
  const activeSiphons6 = await db.select().from(siphonEvents).where(eq(siphonEvents.vehicleId, vehicle.id));
  console.log(`-> Alerts: ${activeAlerts6.length}, Siphon events: ${activeSiphons6.length}`);
  if (activeAlerts6.length === 0 && activeSiphons6.length === 1 && activeSiphons6[0].status === 'review') {
    console.log('✅ PASS: Review-only siphon event recorded without generating a critical alert!');
  } else {
    console.error('❌ FAIL: Review-only event failed to trigger or generated critical alert.');
  }

  // Test Case 7: Event Clustering - Multiple drops within 30 minutes
  console.log('\nTest Case 7: Event Clustering (Additional drop within 30 minutes)...');
  // We build on Test Case 5 (Critical alert already exists)
  await cleanTestData(vehicle.id);
  // t0: parked, engine on
  await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 45.0,
    ignitionOn: true,
    speedKph: 0,
    recordedAt: new Date(baseTime.getTime() - 25 * 60 * 1000),
  });
  // t1: engine off, drop starts
  await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 45.0,
    ignitionOn: false,
    speedKph: 0,
    recordedAt: new Date(baseTime.getTime() - 22 * 60 * 1000),
  });
  // t2: fuel 30L (drop of 15L)
  await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 30.0,
    ignitionOn: false,
    speedKph: 0,
    recordedAt: new Date(baseTime.getTime() - 18 * 60 * 1000),
  });
  // t3: check validation window for first drop
  const rowTheftFirst = await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 30.0,
    ignitionOn: false,
    speedKph: 0,
    recordedAt: new Date(baseTime.getTime() - 14 * 60 * 1000),
  });
  await detectAnomalies(deviceContext, rowTheftFirst, { licensePlate: vehicle.licensePlate });

  const activeAlerts7_1 = await db.select().from(alerts).where(eq(alerts.vehicleId, vehicle.id));
  const activeSiphons7_1 = await db.select().from(siphonEvents).where(eq(siphonEvents.vehicleId, vehicle.id));
  console.log(`-> Before cluster: Alerts: ${activeAlerts7_1.length}, Siphon drop: ${activeSiphons7_1[0]?.litersStolen}L`);

  // t4: fuel drops to 25L (additional drop of 5L, cumulative 20L)
  await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 25.0,
    ignitionOn: false,
    speedKph: 0,
    recordedAt: new Date(baseTime.getTime() - 5 * 60 * 1000),
  });
  // t5: check validation window for second drop (now)
  const rowTheftSecond = await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 25.0,
    ignitionOn: false,
    speedKph: 0,
    recordedAt: baseTime,
  });
  await detectAnomalies(deviceContext, rowTheftSecond, { licensePlate: vehicle.licensePlate });

  const activeAlerts7_2 = await db.select().from(alerts).where(eq(alerts.vehicleId, vehicle.id));
  const activeSiphons7_2 = await db.select().from(siphonEvents).where(eq(siphonEvents.vehicleId, vehicle.id));
  console.log(`-> After cluster: Alerts: ${activeAlerts7_2.length}, Siphon drop: ${activeSiphons7_2[0]?.litersStolen}L`);

  if (activeAlerts7_2.length === 1 && Number(activeSiphons7_2[0]?.litersStolen) === 20) {
    console.log('✅ PASS: Event clustering correctly merged multiple drops into a single event.');
  } else {
    console.error('❌ FAIL: Multiple drops created separate events or failed to merge.');
  }

  // Test Case 8: Alert Cooldown - Suppress new alert for 2-4 hours
  console.log('\nTest Case 8: Alert Cooldown (Second drop after 2 hours)...');
  resetEngineState();
  // We have the previous alert from Test Case 7 at baseTime.
  // We simulate another drop at baseTime + 2 hours.
  const futureBaseTime = new Date(baseTime.getTime() + 2 * 60 * 60 * 1000);

  // t0_future: fuel 45L
  await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 45.0,
    ignitionOn: false,
    speedKph: 0,
    recordedAt: new Date(futureBaseTime.getTime() - 10 * 60 * 1000),
  });
  // t1_future: drop to 30L (-15L drop)
  await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 30.0,
    ignitionOn: false,
    speedKph: 0,
    recordedAt: new Date(futureBaseTime.getTime() - 5 * 60 * 1000),
  });
  // t2_future: check validation window for second drop (2 hours later)
  const rowCooldown = await insertTelemetryRow(deviceContext, {
    fuelLevelLiters: 30.0,
    ignitionOn: false,
    speedKph: 0,
    recordedAt: futureBaseTime,
  });
  await detectAnomalies(deviceContext, rowCooldown, { licensePlate: vehicle.licensePlate });

  const activeAlerts8 = await db.select().from(alerts).where(eq(alerts.vehicleId, vehicle.id));
  const activeSiphons8 = await db.select().from(siphonEvents).where(eq(siphonEvents.vehicleId, vehicle.id));
  console.log(`-> Total Alerts after cooldown check: ${activeAlerts8.length}, Siphon events: ${activeSiphons8.length}`);
  
  // Test Case 7 created 1 alert. It should still be 1 alert because the new one was suppressed by cooldown!
  if (activeAlerts8.length === 1 && activeSiphons8.length === 1) {
    console.log('✅ PASS: Cooldown successfully suppressed new alert/siphon event.');
  } else {
    console.error('❌ FAIL: Cooldown failed to suppress new alert/siphon event.');
  }

  // Clean up test data
  await cleanTestData(vehicle.id);
  console.log('\n--- VERIFICATION TESTS COMPLETED ---');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
