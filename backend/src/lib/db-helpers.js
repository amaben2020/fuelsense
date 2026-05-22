const { db } = require('../db');
const {
  customers,
  vehicles,
  devices,
  telemetry,
  alerts,
  payments,
  deviceOrders,
} = require('../db/schema');
const { eq, and, desc, sql } = require('drizzle-orm');
const { serializeForApi } = require('./serialize');

const IMEI_PATTERN = /^\d{15}$/;

const linkDevice = async (tx, { imei, vehicleId, customerId, deviceModel = 'FMC150' }) => {
  if (!IMEI_PATTERN.test(imei || '')) {
    throw Object.assign(new Error('IMEI must be exactly 15 digits'), { status: 400 });
  }

  const [existingDevice] = await tx
    .select({ customerId: devices.customerId })
    .from(devices)
    .where(eq(devices.imei, imei))
    .for('update');

  if (existingDevice) {
    if (existingDevice.customerId !== customerId) {
      throw Object.assign(new Error('Device is registered to another account'), { status: 409 });
    }

    await tx
      .update(devices)
      .set({
        vehicleId,
        customerId,
        isActive: true,
        deviceModel,
        updatedAt: sql`NOW()`,
      })
      .where(eq(devices.imei, imei));
    return;
  }

  await tx.insert(devices).values({
    imei,
    vehicleId,
    customerId,
    deviceModel,
  });
};

const createVehicle = async (
  tx,
  customerId,
  { licensePlate, make, model, year, tankCapacityLiters }
) => {
  if (!licensePlate?.trim()) {
    throw Object.assign(new Error('License plate is required'), { status: 400 });
  }

  const [vehicle] = await tx
    .insert(vehicles)
    .values({
      customerId,
      licensePlate: licensePlate.trim().toUpperCase(),
      make: make?.trim() || null,
      model: model?.trim() || null,
      year: year ? Number(year) : null,
      tankCapacityLiters: tankCapacityLiters ? Number(tankCapacityLiters) : null,
    })
    .returning({
      id: vehicles.id,
      license_plate: vehicles.licensePlate,
      make: vehicles.make,
      model: vehicles.model,
      year: vehicles.year,
      tank_capacity_liters: vehicles.tankCapacityLiters,
    });

  return vehicle;
};

const customerPublicSelect = {
  id: customers.id,
  name: customers.name,
  email: customers.email,
  company_name: customers.companyName,
  subscription_status: customers.subscriptionStatus,
  onboarding_completed: customers.onboardingCompleted,
  created_at: customers.createdAt,
};

module.exports = {
  IMEI_PATTERN,
  linkDevice,
  createVehicle,
  customerPublicSelect,
  serializeForApi,
  db,
  customers,
  vehicles,
  devices,
  telemetry,
  alerts,
  payments,
  deviceOrders,
  eq,
  and,
  desc,
  sql,
};
