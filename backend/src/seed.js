require('dotenv').config();

const bcrypt = require('bcryptjs');
const { db, initDatabase, closePool } = require('./db');
const { customers, drivers, vehicles, devices } = require('./db/schema');
const { eq, and } = require('drizzle-orm');

const DEMO_EMAIL = 'demo@fuelsense.local';
const DEMO_PASSWORD = 'demo1234';

const DEMO_DRIVERS = [
  {
    fullName: 'Chidi Okonkwo',
    phone: '+234 803 111 2233',
    licenseNumber: 'LAG/2019/88421',
    vehiclePlate: 'ABC-123',
  },
  {
    fullName: 'Amara Eze',
    phone: '+234 802 445 6677',
    licenseNumber: 'LAG/2020/55210',
    vehiclePlate: 'LAG-456-CD',
  },
  {
    fullName: 'Ngozi Obi',
    phone: '+234 805 778 9900',
    licenseNumber: 'LAG/2018/33102',
    vehiclePlate: 'LAG-789-EF',
  },
  {
    fullName: 'Emeka Nwosu',
    phone: '+234 809 123 4567',
    licenseNumber: 'FCT/2021/10293',
    vehiclePlate: 'ABJ-101-GH',
  },
  {
    fullName: 'Ibrahim Musa',
    phone: '+234 701 555 8899',
    licenseNumber: 'RIV/2022/77104',
    vehiclePlate: 'RIV-202-IJ',
  },
];

const DEMO_FLEET = [
  {
    imei: '356307042441013',
    licensePlate: 'ABC-123',
    make: 'Toyota',
    model: 'Hilux',
    year: 2022,
    tankCapacityLiters: 60,
  },
  {
    imei: '356307042441014',
    licensePlate: 'LAG-456-CD',
    make: 'Toyota',
    model: 'Hiace',
    year: 2020,
    tankCapacityLiters: 55,
  },
  {
    imei: '356307042441015',
    licensePlate: 'LAG-789-EF',
    make: 'Toyota',
    model: 'Hilux',
    year: 2018,
    tankCapacityLiters: 70,
  },
  {
    imei: '356307042441016',
    licensePlate: 'ABJ-101-GH',
    make: 'Toyota',
    model: 'Camry',
    year: 2021,
    tankCapacityLiters: 50,
  },
  {
    imei: '356307042441017',
    licensePlate: 'RIV-202-IJ',
    make: 'Toyota',
    model: 'RAV4',
    year: 2022,
    tankCapacityLiters: 55,
  },
];

const upsertDriver = async (customerId, driver) => {
  const [existing] = await db
    .select({ id: drivers.id })
    .from(drivers)
    .where(
      and(eq(drivers.customerId, customerId), eq(drivers.fullName, driver.fullName))
    );

  if (existing) {
    await db
      .update(drivers)
      .set({
        phone: driver.phone,
        licenseNumber: driver.licenseNumber,
        status: 'active',
      })
      .where(eq(drivers.id, existing.id));
    return existing.id;
  }

  const [created] = await db
    .insert(drivers)
    .values({
      customerId,
      fullName: driver.fullName,
      phone: driver.phone,
      licenseNumber: driver.licenseNumber,
      status: 'active',
    })
    .returning({ id: drivers.id });

  return created.id;
};

const upsertFleetVehicle = async (customerId, entry, driverId, driverName) => {
  const [existingVehicle] = await db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(
      and(
        eq(vehicles.customerId, customerId),
        eq(vehicles.licensePlate, entry.licensePlate)
      )
    );

  let vehicleId = existingVehicle?.id;

  if (vehicleId) {
    await db
      .update(vehicles)
      .set({
        make: entry.make,
        model: entry.model,
        year: entry.year,
        tankCapacityLiters: entry.tankCapacityLiters,
        driverId,
        driverName,
      })
      .where(eq(vehicles.id, vehicleId));
  } else {
    const [vehicle] = await db
      .insert(vehicles)
      .values({
        customerId,
        licensePlate: entry.licensePlate,
        make: entry.make,
        model: entry.model,
        year: entry.year,
        tankCapacityLiters: entry.tankCapacityLiters,
        driverId,
        driverName,
      })
      .returning({ id: vehicles.id });
    vehicleId = vehicle.id;
  }

  const [existingDevice] = await db
    .select({ imei: devices.imei })
    .from(devices)
    .where(eq(devices.imei, entry.imei));

  if (existingDevice) {
    await db
      .update(devices)
      .set({ vehicleId, customerId, isActive: true })
      .where(eq(devices.imei, entry.imei));
  } else {
    await db.insert(devices).values({
      imei: entry.imei,
      vehicleId,
      customerId,
    });
  }

  return entry;
};

const seed = async () => {
  await initDatabase();

  let [customer] = await db
    .select({ id: customers.id, email: customers.email })
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
      })
      .returning({ id: customers.id, email: customers.email });
    console.log('Created demo customer');
  } else {
    console.log('Demo customer exists — syncing fleet');
  }

  const driverByPlate = new Map();
  for (const driver of DEMO_DRIVERS) {
    const driverId = await upsertDriver(customer.id, driver);
    driverByPlate.set(driver.vehiclePlate, { driverId, driverName: driver.fullName });
  }

  for (const entry of DEMO_FLEET) {
    const link = driverByPlate.get(entry.licensePlate);
    await upsertFleetVehicle(
      customer.id,
      entry,
      link?.driverId ?? null,
      link?.driverName ?? null
    );
  }

  await db
    .update(customers)
    .set({ onboardingCompleted: true })
    .where(eq(customers.id, customer.id));

  console.log('\nSeed complete:');
  console.log(`  Email:    ${DEMO_EMAIL}`);
  console.log(`  Password: ${DEMO_PASSWORD}`);
  console.log(`  Drivers:  ${DEMO_DRIVERS.length}`);
  console.log(`  Fleet:    ${DEMO_FLEET.length} vehicles with IMEIs`);
  console.log('\n  Next:');
  console.log('    npm run seed-telemetry');
  console.log('    npm run seed-fuel-purchases');
  console.log('    npm run dev  (auto-starts fleet simulator)');

  await closePool();
};

seed().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
