/**
 * Register the physical FMC150 on the demo customer — safe to run on EC2 production DB.
 * Usage: node src/seed-real-device.js
 */
require('dotenv').config();

const bcrypt = require('bcryptjs');
const { db, initDatabase, closePool } = require('./db');
const { customers, vehicles, devices } = require('./db/schema');
const { eq } = require('drizzle-orm');

const DEMO_EMAIL = 'demo@fuelsense.local';
const DEMO_PASSWORD = 'demo1234';

const REAL_DEVICE = {
  imei: process.env.REAL_DEVICE_IMEI || '862129084847783',
  simCcid: process.env.REAL_DEVICE_CCID || '89234010006276368382',
  licensePlate: process.env.REAL_DEVICE_PLATE || 'LIVE-FMC150',
  make: 'Toyota',
  model: 'RAV4',
  year: 2014,
  tankCapacityLiters: 60,
};

async function ensureCustomer() {
  let [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.email, DEMO_EMAIL));

  if (!customer) {
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
    [customer] = await db
      .insert(customers)
      .values({
        name: 'Demo Fleet Ltd',
        email: DEMO_EMAIL,
        passwordHash,
        companyName: 'Demo Fleet Ltd',
        onboardingCompleted: true,
      })
      .returning({ id: customers.id });
    console.log('Created demo customer');
  }

  return customer.id;
}

async function upsertRealDevice(customerId) {
  const { imei, licensePlate, make, model, year, tankCapacityLiters, simCcid } = REAL_DEVICE;

  let [vehicle] = await db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(eq(vehicles.licensePlate, licensePlate));

  if (vehicle) {
    await db
      .update(vehicles)
      .set({ make, model, year, tankCapacityLiters, customerId })
      .where(eq(vehicles.id, vehicle.id));
  } else {
    [vehicle] = await db
      .insert(vehicles)
      .values({
        customerId,
        licensePlate,
        make,
        model,
        year,
        tankCapacityLiters,
      })
      .returning({ id: vehicles.id });
  }

  const [existing] = await db
    .select({ imei: devices.imei })
    .from(devices)
    .where(eq(devices.imei, imei));

  if (existing) {
    await db
      .update(devices)
      .set({
        vehicleId: vehicle.id,
        customerId,
        isActive: true,
        deviceModel: 'FMC150',
        firmwareVersion: simCcid ? `CCID:${simCcid}` : undefined,
      })
      .where(eq(devices.imei, imei));
    console.log('Updated existing device row');
  } else {
    await db.insert(devices).values({
      imei,
      vehicleId: vehicle.id,
      customerId,
      deviceModel: 'FMC150',
      firmwareVersion: simCcid ? `CCID:${simCcid}` : null,
      isActive: true,
    });
    console.log('Inserted new device row');
  }

  console.log('\nReal device registered:');
  console.log(`  IMEI:  ${imei}`);
  console.log(`  CCID:  ${simCcid}`);
  console.log(`  Plate: ${licensePlate}`);
  console.log(`  Vehicle id: ${vehicle.id}`);
}

async function main() {
  await initDatabase();
  const customerId = await ensureCustomer();
  await upsertRealDevice(customerId);
  await closePool();
}

main().catch((err) => {
  console.error('seed-real-device failed:', err);
  process.exit(1);
});
