import 'dotenv/config';

import bcrypt from 'bcryptjs';
import { db, initDatabase, closePool } from './db';
import { customers, drivers, vehicles, devices } from './db/schema';
import { eq, and } from 'drizzle-orm';

const DEMO_EMAIL = 'demo@fuelsense.local';
const DEMO_PASSWORD = 'demo1234';
const DRIVER_PIN = '1234';

const seed = async (): Promise<void> => {
  await initDatabase();

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
  } else {
    await db
      .update(customers)
      .set({ onboardingCompleted: true })
      .where(eq(customers.id, customer.id));
    console.log('Demo customer exists');
  }

  const vehiclePlate = process.env.REAL_DEVICE_PLATE || 'LAG-001-FS';
  const deviceImei = process.env.REAL_DEVICE_IMEI || '862129084847783';

  let [vehicle] = await db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(and(eq(vehicles.customerId, customer.id), eq(vehicles.licensePlate, vehiclePlate)));

  if (!vehicle) {
    [vehicle] = await db
      .insert(vehicles)
      .values({
        customerId: customer.id,
        licensePlate: vehiclePlate,
        make: 'Toyota',
        model: 'RAV4',
        year: 2022,
        tankCapacityLiters: 60,
      })
      .returning({ id: vehicles.id });
    console.log(`Created vehicle ${vehiclePlate}`);
  } else {
    console.log(`Vehicle ${vehiclePlate} exists`);
  }

  const pinHash = await bcrypt.hash(DRIVER_PIN, 12);

  let [driver] = await db
    .select({ id: drivers.id })
    .from(drivers)
    .where(and(eq(drivers.customerId, customer.id), eq(drivers.driverCode, 'BENNETH-001')));

  if (!driver) {
    [driver] = await db
      .insert(drivers)
      .values({
        customerId: customer.id,
        fullName: 'Benneth Uzochukwu',
        phone: '+234 806 100 0001',
        licenseNumber: 'LAG/2023/10001',
        driverCode: 'BENNETH-001',
        pinHash,
        status: 'active',
      })
      .returning({ id: drivers.id });
    console.log('Created driver: Benneth Uzochukwu');
  } else {
    console.log('Driver Benneth Uzochukwu exists');
  }

  await db
    .update(vehicles)
    .set({ driverId: driver.id, driverName: 'Benneth Uzochukwu' })
    .where(eq(vehicles.id, vehicle.id));

  const [existingDevice] = await db
    .select({ imei: devices.imei })
    .from(devices)
    .where(eq(devices.imei, deviceImei));

  const devicePatch: {
    vehicleId: string;
    customerId: string;
    isActive: boolean;
    deviceModel: string;
    firmwareVersion?: string;
  } = {
    vehicleId: vehicle.id,
    customerId: customer.id,
    isActive: true,
    deviceModel: 'FMC150',
    ...(process.env.REAL_DEVICE_CCID
      ? { firmwareVersion: `CCID:${process.env.REAL_DEVICE_CCID}` }
      : {}),
  };

  if (existingDevice) {
    await db.update(devices).set(devicePatch).where(eq(devices.imei, deviceImei));
    console.log(`Updated device ${deviceImei}`);
  } else {
    await db.insert(devices).values({ imei: deviceImei, ...devicePatch });
    console.log(`Created device ${deviceImei}`);
  }

  console.log('\nSeed complete:');
  console.log(`  Login:   ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`  Driver:  Benneth Uzochukwu (PIN: ${DRIVER_PIN}, code: BENNETH-001)`);
  console.log(`  Vehicle: ${vehiclePlate} (Toyota RAV4 2022)`);
  console.log(`  Device:  ${deviceImei}`);
  console.log('\n  To add more vehicles and drivers, use the dashboard UI or API.');

  await closePool();
};

seed().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
