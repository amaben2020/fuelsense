require('dotenv').config();

const bcrypt = require('bcryptjs');
const { db, initDatabase, closePool } = require('./db');
const { customers, vehicles, devices } = require('./db/schema');
const { eq, and } = require('drizzle-orm');

const DEMO_EMAIL = 'demo@fuelsense.local';
const DEMO_PASSWORD = 'demo1234';

const DEMO_FLEET = [
  {
    imei: '356307042441013',
    licensePlate: 'ABC-123',
    make: 'Toyota',
    model: 'Hilux',
    year: 2022,
    tankCapacityLiters: 60,
    driverName: 'Chidi Okonkwo',
  },
  {
    imei: '356307042441014',
    licensePlate: 'LAG-456-CD',
    make: 'Toyota',
    model: 'Hiace',
    year: 2020,
    tankCapacityLiters: 55,
    driverName: 'Amara Eze',
  },
  {
    imei: '356307042441015',
    licensePlate: 'LAG-789-EF',
    make: 'Toyota',
    model: 'Hilux',
    year: 2018,
    tankCapacityLiters: 70,
    driverName: 'Ngozi Obi',
  },
  {
    imei: '356307042441016',
    licensePlate: 'ABJ-101-GH',
    make: 'Toyota',
    model: 'Camry',
    year: 2021,
    tankCapacityLiters: 50,
    driverName: 'Emeka Nwosu',
  },
  {
    imei: '356307042441017',
    licensePlate: 'RIV-202-IJ',
    make: 'Toyota',
    model: 'RAV4',
    year: 2022,
    tankCapacityLiters: 55,
    driverName: 'Test Vehicle',
  },
];

const upsertFleetVehicle = async (customerId, entry) => {
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
        driverName: entry.driverName,
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
        driverName: entry.driverName,
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

  for (const entry of DEMO_FLEET) {
    await upsertFleetVehicle(customer.id, entry);
  }

  await db
    .update(customers)
    .set({ onboardingCompleted: true })
    .where(eq(customers.id, customer.id));

  console.log('\nSeed complete:');
  console.log(`  Email:    ${DEMO_EMAIL}`);
  console.log(`  Password: ${DEMO_PASSWORD}`);
  console.log(`  Fleet:    ${DEMO_FLEET.length} vehicles with IMEIs`);
  console.log('\n  Run fleet simulation:');
  console.log('    npm run simulate-fleet');
  DEMO_FLEET.forEach((v) => {
    console.log(`    ${v.licensePlate} → ${v.imei} (${v.driverName})`);
  });

  await closePool();
};

seed().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
