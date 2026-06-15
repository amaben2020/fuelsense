import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  boolean,
  timestamp,
  integer,
  bigserial,
  numeric,
  text,
  unique,
} from 'drizzle-orm/pg-core';

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 50 }),
  companyName: varchar('company_name', { length: 255 }),
  subscriptionStatus: varchar('subscription_status', { length: 50 }).default('active'),
  onboardingCompleted: boolean('onboarding_completed').default(false),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const drivers = pgTable('drivers', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  fullName: varchar('full_name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  licenseNumber: varchar('license_number', { length: 80 }),
  driverCode: varchar('driver_code', { length: 50 }),
  pinHash: varchar('pin_hash', { length: 255 }),
  status: varchar('status', { length: 30 }).default('active'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const vehicles = pgTable(
  'vehicles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    licensePlate: varchar('license_plate', { length: 50 }).notNull(),
    make: varchar('make', { length: 100 }),
    model: varchar('model', { length: 100 }),
    year: integer('year'),
    tankCapacityLiters: integer('tank_capacity_liters'),
    driverId: uuid('driver_id').references(() => drivers.id, { onDelete: 'set null' }),
    driverName: varchar('driver_name', { length: 255 }),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [unique().on(table.customerId, table.licensePlate)]
);

export const fuelReceipts = pgTable('fuel_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  driverId: uuid('driver_id')
    .notNull()
    .references(() => drivers.id, { onDelete: 'cascade' }),
  vehicleId: uuid('vehicle_id')
    .notNull()
    .references(() => vehicles.id, { onDelete: 'cascade' }),
  receiptPhotoUrl: text('receipt_photo_url'),
  merchantName: varchar('merchant_name', { length: 255 }),
  merchantAddress: text('merchant_address'),
  transactionDate: timestamp('transaction_date').notNull(),
  declaredLiters: numeric('declared_liters', { precision: 10, scale: 2 }).notNull(),
  pricePerLiter: numeric('price_per_liter', { precision: 10, scale: 2 }),
  totalAmount: numeric('total_amount', { precision: 12, scale: 2 }),
  odometerKm: integer('odometer_km'),
  obdLitersActual: numeric('obd_liters_actual', { precision: 10, scale: 2 }),
  differenceLiters: numeric('difference_liters', { precision: 10, scale: 2 }),
  obdRefuelDetectedAt: timestamp('obd_refuel_detected_at'),
  ignitionOnAt: timestamp('ignition_on_at'),
  reconciliationStatus: varchar('reconciliation_status', { length: 30 }).default('pending'),
  receiptLatitude: numeric('receipt_latitude', { precision: 10, scale: 8 }),
  receiptLongitude: numeric('receipt_longitude', { precision: 11, scale: 8 }),
  clientReceiptId: varchar('client_receipt_id', { length: 64 }),
  uploadedAt: timestamp('uploaded_at').defaultNow(),
  reconciledAt: timestamp('reconciled_at'),
});

export const siphonEvents = pgTable('siphon_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  vehicleId: uuid('vehicle_id')
    .notNull()
    .references(() => vehicles.id, { onDelete: 'cascade' }),
  driverId: uuid('driver_id').references(() => drivers.id, { onDelete: 'set null' }),
  alertId: integer('alert_id'),
  occurredAt: timestamp('occurred_at').notNull(),
  litersStolen: numeric('liters_stolen', { precision: 10, scale: 2 }).notNull(),
  estimatedLossNgn: integer('estimated_loss_ngn'),
  fuelLevelBefore: numeric('fuel_level_before', { precision: 10, scale: 2 }),
  fuelLevelAfter: numeric('fuel_level_after', { precision: 10, scale: 2 }),
  engineStateBefore: boolean('engine_state_before'),
  engineStateAfter: boolean('engine_state_after'),
  parkedDurationMinutes: integer('parked_duration_minutes'),
  latitude: numeric('latitude', { precision: 10, scale: 8 }),
  longitude: numeric('longitude', { precision: 11, scale: 8 }),
  locationName: varchar('location_name', { length: 255 }),
  status: varchar('status', { length: 30 }).default('active'),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow(),
  resolvedAt: timestamp('resolved_at'),
});

export const fuelPurchases = pgTable('fuel_purchases', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  vehicleId: uuid('vehicle_id')
    .notNull()
    .references(() => vehicles.id, { onDelete: 'cascade' }),
  purchasedAt: timestamp('purchased_at').notNull().defaultNow(),
  merchant: varchar('merchant', { length: 255 }),
  receiptReference: varchar('receipt_reference', { length: 120 }),
  litersDeclared: numeric('liters_declared', { precision: 10, scale: 2 }).notNull(),
  litersActual: numeric('liters_actual', { precision: 10, scale: 2 }),
  obdRefuelDetectedAt: timestamp('obd_refuel_detected_at'),
  ignitionOnAt: timestamp('ignition_on_at'),
  costPerLiterNgn: integer('cost_per_liter_ngn'),
  odometerKm: integer('odometer_km'),
  status: varchar('status', { length: 30 }).default('verified'),
  source: varchar('source', { length: 30 }).default('receipt'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const devices = pgTable('devices', {
  imei: varchar('imei', { length: 20 }).primaryKey(),
  vehicleId: uuid('vehicle_id').references(() => vehicles.id, { onDelete: 'set null' }),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  deviceModel: varchar('device_model', { length: 50 }).default('FMC150'),
  firmwareVersion: varchar('firmware_version', { length: 50 }),
  isActive: boolean('is_active').default(true),
  installedAt: timestamp('installed_at').defaultNow(),
  lastSeenAt: timestamp('last_seen_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const telemetry = pgTable('telemetry', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  imei: varchar('imei', { length: 20 }).references(() => devices.imei),
  customerId: uuid('customer_id').references(() => customers.id),
  vehicleId: uuid('vehicle_id').references(() => vehicles.id),
  recordedAt: timestamp('recorded_at').notNull().defaultNow(),
  fuelLevelLiters: numeric('fuel_level_liters', { precision: 10, scale: 2 }),
  odometerKm: integer('odometer_km'),
  latitude: numeric('latitude', { precision: 10, scale: 8 }),
  longitude: numeric('longitude', { precision: 11, scale: 8 }),
  speedKph: integer('speed_kph'),
  ignitionOn: boolean('ignition_on'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const alerts = pgTable('alerts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  imei: varchar('imei', { length: 20 }).references(() => devices.imei),
  customerId: uuid('customer_id').references(() => customers.id),
  vehicleId: uuid('vehicle_id').references(() => vehicles.id),
  alertType: varchar('alert_type', { length: 50 }).notNull(),
  message: text('message').notNull(),
  fuelLevelLiters: numeric('fuel_level_liters', { precision: 10, scale: 2 }),
  fuelDropLiters: numeric('fuel_drop_liters', { precision: 10, scale: 2 }),
  estimatedLossNgn: integer('estimated_loss_ngn'),
  latitude: numeric('latitude', { precision: 10, scale: 8 }),
  longitude: numeric('longitude', { precision: 11, scale: 8 }),
  isResolved: boolean('is_resolved').default(false),
  resolvedAt: timestamp('resolved_at'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  planName: varchar('plan_name', { length: 50 }).notNull().default('basic'),
  pricePerVehicleNgn: integer('price_per_vehicle_ngn').notNull().default(120000),
  status: varchar('status', { length: 50 }).default('active'),
  currentPeriodStart: timestamp('current_period_start').defaultNow(),
  currentPeriodEnd: timestamp('current_period_end'),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').default(false),
  createdAt: timestamp('created_at').defaultNow(),
});

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
    onDelete: 'set null',
  }),
  amountNgn: integer('amount_ngn').notNull(),
  reference: varchar('reference', { length: 255 }).notNull().unique(),
  status: varchar('status', { length: 50 }).default('pending'),
  paymentMethod: varchar('payment_method', { length: 50 }),
  paidAt: timestamp('paid_at'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const deviceOrders = pgTable('device_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  orderDate: timestamp('order_date').defaultNow(),
  status: varchar('status', { length: 50 }).default('pending'),
  deviceImeis: text('device_imeis').array().default(sql`ARRAY[]::text[]`),
  quantity: integer('quantity').notNull().default(1),
  totalAmountNgn: integer('total_amount_ngn').notNull(),
  shippingAddress: text('shipping_address'),
  createdAt: timestamp('created_at').defaultNow(),
});
