import { db } from '../db';
import {
  customers,
  drivers,
  vehicles,
  devices,
  telemetry,
  alerts,
  fuelPurchases,
  fuelReceipts,
  siphonEvents,
  payments,
  deviceOrders,
} from '../db/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { serializeForApi } from './serialize';

export const IMEI_PATTERN = /^\d{15}$/;

interface LinkDeviceParams {
  imei: string;
  vehicleId: string;
  customerId: string;
  deviceModel?: string;
}

type AnyTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const linkDevice = async (tx: AnyTx, { imei, vehicleId, customerId, deviceModel = 'FMC150' }: LinkDeviceParams): Promise<void> => {
  if (!IMEI_PATTERN.test(imei || '')) {
    throw Object.assign(new Error('IMEI must be exactly 15 digits'), { status: 400 });
  }

  const [existingDevice] = await (tx as typeof db)
    .select({ customerId: devices.customerId })
    .from(devices)
    .where(eq(devices.imei, imei))
    .for('update');

  if (existingDevice) {
    if (existingDevice.customerId !== customerId) {
      throw Object.assign(new Error('Device is registered to another account'), { status: 409 });
    }

    await (tx as typeof db)
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

  await (tx as typeof db).insert(devices).values({
    imei,
    vehicleId,
    customerId,
    deviceModel,
  });
};

interface CreateVehicleParams {
  licensePlate: string;
  make?: string;
  model?: string;
  year?: number;
  tankCapacityLiters?: number;
}

export const createVehicle = async (
  tx: AnyTx,
  customerId: string,
  { licensePlate, make, model, year, tankCapacityLiters }: CreateVehicleParams
): Promise<{
  id: string;
  license_plate: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  tank_capacity_liters: number | null;
}> => {
  if (!licensePlate?.trim()) {
    throw Object.assign(new Error('License plate is required'), { status: 400 });
  }

  const [vehicle] = await (tx as typeof db)
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

export const customerPublicSelect = {
  id: customers.id,
  name: customers.name,
  email: customers.email,
  company_name: customers.companyName,
  subscription_status: customers.subscriptionStatus,
  onboarding_completed: customers.onboardingCompleted,
  created_at: customers.createdAt,
};

export {
  serializeForApi,
  db,
  customers,
  drivers,
  vehicles,
  devices,
  telemetry,
  alerts,
  fuelPurchases,
  fuelReceipts,
  siphonEvents,
  payments,
  deviceOrders,
  eq,
  and,
  desc,
  sql,
};
