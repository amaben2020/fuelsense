const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { sql } = require('drizzle-orm');
const schema = require('./schema');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const db = drizzle(pool, { schema });

const ensureColumn = async (table, column, definition) => {
  const result = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
  `);
  if (result.rows.length === 0) {
    await db.execute(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`));
  }
};

const initDatabase = async () => {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS customers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      phone VARCHAR(50),
      company_name VARCHAR(255),
      subscription_status VARCHAR(50) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await ensureColumn('customers', 'phone', 'VARCHAR(50)');
  await ensureColumn('customers', 'company_name', 'VARCHAR(255)');
  await ensureColumn('customers', 'updated_at', 'TIMESTAMP DEFAULT NOW()');
  await ensureColumn('customers', 'onboarding_completed', 'BOOLEAN DEFAULT false');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS vehicles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      license_plate VARCHAR(50) NOT NULL,
      make VARCHAR(100),
      model VARCHAR(100),
      year INTEGER,
      tank_capacity_liters INTEGER,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (customer_id, license_plate)
    )
  `);

  await ensureColumn('vehicles', 'tank_capacity_liters', 'INTEGER');
  await ensureColumn('vehicles', 'driver_name', 'VARCHAR(255)');
  await ensureColumn('vehicles', 'updated_at', 'TIMESTAMP DEFAULT NOW()');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS devices (
      imei VARCHAR(20) PRIMARY KEY,
      vehicle_id UUID REFERENCES vehicles(id) ON DELETE SET NULL,
      customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      device_model VARCHAR(50) DEFAULT 'FMC150',
      firmware_version VARCHAR(50),
      is_active BOOLEAN DEFAULT true,
      installed_at TIMESTAMP DEFAULT NOW(),
      last_seen_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await ensureColumn('devices', 'device_model', "VARCHAR(50) DEFAULT 'FMC150'");
  await ensureColumn('devices', 'firmware_version', 'VARCHAR(50)');
  await ensureColumn('devices', 'created_at', 'TIMESTAMP DEFAULT NOW()');
  await ensureColumn('devices', 'updated_at', 'TIMESTAMP DEFAULT NOW()');

  const telemetryExists = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'telemetry' AND column_name = 'customer_id'
  `);

  if (telemetryExists.rows.length === 0) {
    const legacyTelemetry = await db.execute(sql`
      SELECT 1 FROM information_schema.tables WHERE table_name = 'telemetry'
    `);

    if (legacyTelemetry.rows.length > 0) {
      await db.execute(sql`DROP TABLE IF EXISTS alerts CASCADE`);
      await db.execute(sql`DROP TABLE IF EXISTS telemetry CASCADE`);
    }

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS telemetry (
        id BIGSERIAL PRIMARY KEY,
        imei VARCHAR(20) REFERENCES devices(imei),
        customer_id UUID REFERENCES customers(id),
        vehicle_id UUID REFERENCES vehicles(id),
        recorded_at TIMESTAMP NOT NULL DEFAULT NOW(),
        fuel_level_liters DECIMAL(10,2),
        odometer_km INTEGER,
        latitude DECIMAL(10,8),
        longitude DECIMAL(11,8),
        speed_kph INTEGER,
        ignition_on BOOLEAN,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  }

  const alertsExists = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'alerts' AND column_name = 'customer_id'
  `);

  if (alertsExists.rows.length === 0) {
    await db.execute(sql`DROP TABLE IF EXISTS alerts CASCADE`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS alerts (
        id BIGSERIAL PRIMARY KEY,
        imei VARCHAR(20) REFERENCES devices(imei),
        customer_id UUID REFERENCES customers(id),
        vehicle_id UUID REFERENCES vehicles(id),
        alert_type VARCHAR(50) NOT NULL,
        message TEXT NOT NULL,
        fuel_level_liters DECIMAL(10,2),
        is_resolved BOOLEAN DEFAULT false,
        resolved_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  }

  await ensureColumn('alerts', 'is_resolved', 'BOOLEAN DEFAULT false');
  await ensureColumn('alerts', 'resolved_at', 'TIMESTAMP');
  await ensureColumn('alerts', 'latitude', 'DECIMAL(10,8)');
  await ensureColumn('alerts', 'longitude', 'DECIMAL(11,8)');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      plan_name VARCHAR(50) NOT NULL DEFAULT 'basic',
      price_per_vehicle_ngn INTEGER NOT NULL DEFAULT 120000,
      status VARCHAR(50) DEFAULT 'active',
      current_period_start TIMESTAMP DEFAULT NOW(),
      current_period_end TIMESTAMP,
      cancel_at_period_end BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
      amount_ngn INTEGER NOT NULL,
      reference VARCHAR(255) UNIQUE NOT NULL,
      status VARCHAR(50) DEFAULT 'pending',
      payment_method VARCHAR(50),
      paid_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS device_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      order_date TIMESTAMP DEFAULT NOW(),
      status VARCHAR(50) DEFAULT 'pending',
      device_imeis TEXT[] DEFAULT '{}',
      quantity INTEGER NOT NULL DEFAULT 1,
      total_amount_ngn INTEGER NOT NULL,
      shipping_address TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await ensureColumn('device_orders', 'quantity', 'INTEGER NOT NULL DEFAULT 1');

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_telemetry_customer_recorded
      ON telemetry (customer_id, recorded_at DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_telemetry_vehicle_recorded
      ON telemetry (vehicle_id, recorded_at DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_telemetry_imei_recorded
      ON telemetry (imei, recorded_at DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_alerts_customer_created
      ON alerts (customer_id, created_at DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_device_orders_customer
      ON device_orders (customer_id, created_at DESC)
  `);
};

const closePool = async () => {
  await pool.end();
};

module.exports = { db, pool, initDatabase, closePool, schema };
