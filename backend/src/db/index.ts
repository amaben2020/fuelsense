import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

/**
 * Whether this connection needs TLS.
 *
 * Decided from the host in DATABASE_URL, not from NODE_ENV: the EC2 box runs
 * NODE_ENV=production while talking to a Postgres on its own loopback, so
 * keying off the environment would demand TLS from a server that does not
 * offer it. A local server refuses the handshake outright, so getting this
 * wrong is a hard startup failure rather than a degraded connection.
 *
 * DATABASE_SSL=disable|require overrides, for the remote-server-without-TLS
 * and tunnelled cases that the host alone cannot distinguish.
 */
function needsSsl(url: string | undefined): boolean {
  const override = process.env.DATABASE_SSL;
  if (override === 'disable') return false;
  if (override === 'require') return true;
  if (!url) return false;

  try {
    const host = new URL(url).hostname;
    return !['localhost', '127.0.0.1', '::1', ''].includes(host);
  } catch {
    // Unparseable URL (unescaped password is the usual cause) — assume remote,
    // since a needless TLS attempt fails more loudly than a silently plaintext
    // connection to something that expected encryption.
    return true;
  }
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
  // Neon closes idle connections aggressively and cold-starts after a pause.
  // Recycling before it does is cheaper than discovering it mid-query.
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  max: 10,
});

// Without this, pg emits 'error' on the pool when an *idle* connection drops
// and Node treats an unhandled 'error' event as fatal — the process exits.
// On 2026-08-09 a single Neon connection drop crash-looped the service 61
// times, and each restart opened another pool until Neon refused new
// connections entirely (SQLSTATE 53000). A dropped idle connection is routine;
// the pool replaces it on the next checkout.
pool.on('error', (err) => {
  console.error('[db] idle client error (pool will recover):', err.message);
});

export const db = drizzle(pool, { schema });

const ensureColumn = async (table: string, column: string, definition: string): Promise<void> => {
  const result = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
  `);
  if (result.rows.length === 0) {
    await db.execute(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`));
  }
};

export const initDatabase = async (): Promise<void> => {
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
  await ensureColumn('customers', 'logo_url', 'TEXT');
  await ensureColumn('customers', 'brand_color', 'VARCHAR(9)');

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
    CREATE TABLE IF NOT EXISTS drivers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      full_name VARCHAR(255) NOT NULL,
      phone VARCHAR(50),
      license_number VARCHAR(80),
      status VARCHAR(30) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await ensureColumn('vehicles', 'driver_id', 'UUID REFERENCES drivers(id) ON DELETE SET NULL');

  await ensureColumn('drivers', 'email', 'VARCHAR(255)');
  await ensureColumn('drivers', 'driver_code', 'VARCHAR(50)');
  await ensureColumn('drivers', 'pin_hash', 'VARCHAR(255)');

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_code
      ON drivers (driver_code)
      WHERE driver_code IS NOT NULL
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS fuel_receipts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      receipt_photo_url TEXT,
      merchant_name VARCHAR(255),
      merchant_address TEXT,
      transaction_date TIMESTAMP NOT NULL,
      declared_liters DECIMAL(10,2) NOT NULL,
      price_per_liter DECIMAL(10,2),
      total_amount DECIMAL(12,2),
      odometer_km INTEGER,
      obd_liters_actual DECIMAL(10,2),
      difference_liters DECIMAL(10,2),
      reconciliation_status VARCHAR(30) DEFAULT 'pending',
      receipt_latitude DECIMAL(10,8),
      receipt_longitude DECIMAL(11,8),
      uploaded_at TIMESTAMP DEFAULT NOW(),
      reconciled_at TIMESTAMP
    )
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_receipts_vehicle_time
      ON fuel_receipts (vehicle_id, transaction_date DESC)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS siphon_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
      alert_id BIGINT,
      occurred_at TIMESTAMP NOT NULL,
      liters_stolen DECIMAL(10,2) NOT NULL,
      estimated_loss_ngn INTEGER,
      fuel_level_before DECIMAL(10,2),
      fuel_level_after DECIMAL(10,2),
      engine_state_before BOOLEAN,
      engine_state_after BOOLEAN,
      parked_duration_minutes INTEGER,
      latitude DECIMAL(10,8),
      longitude DECIMAL(11,8),
      location_name VARCHAR(255),
      status VARCHAR(30) DEFAULT 'active',
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      resolved_at TIMESTAMP
    )
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_siphon_events_vehicle
      ON siphon_events (vehicle_id, occurred_at DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_siphon_events_status
      ON siphon_events (customer_id, status)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS fuel_purchases (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      purchased_at TIMESTAMP NOT NULL DEFAULT NOW(),
      merchant VARCHAR(255),
      receipt_reference VARCHAR(120),
      liters_declared DECIMAL(10,2) NOT NULL,
      liters_actual DECIMAL(10,2),
      cost_per_liter_ngn INTEGER,
      odometer_km INTEGER,
      status VARCHAR(30) DEFAULT 'verified',
      source VARCHAR(30) DEFAULT 'receipt',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_fuel_purchases_customer_purchased
      ON fuel_purchases (customer_id, purchased_at DESC)
  `);
  // --- route detour detection ---------------------------------------------
  // A planned route for a vehicle. Corridor width lives here because what
  // counts as "off route" differs between a tight urban round and a highway
  // haul, and a single global tolerance would be wrong for one of them.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS route_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      name VARCHAR(160),
      waypoints JSONB NOT NULL,
      corridor_width_m INTEGER,
      effective_from TIMESTAMP,
      effective_to TIMESTAMP,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_route_assignments_vehicle
      ON route_assignments (vehicle_id, active)
  `);

  // One verdict per trip, keyed by the trip's start — trips are derived from
  // telemetry rather than stored, so this is their only stable identity.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS route_checks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      trip_start_at TIMESTAMP NOT NULL,
      trip_end_at TIMESTAMP NOT NULL,
      verdict VARCHAR(20) NOT NULL,
      detour_km NUMERIC(10,2),
      extra_liters NUMERIC(10,2),
      extra_cost_ngn INTEGER,
      evidence JSONB,
      reconciled_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (vehicle_id, trip_start_at)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_route_checks_verdict
      ON route_checks (customer_id, verdict, trip_start_at DESC)
  `);

  // Directions responses, cached across restarts: the sweep retries the same
  // trip for up to a fortnight and must not re-bill the same road lookup.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS route_cache (
      route_key TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      cached_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // One row per report actually delivered, so a redeploy at 6am cannot send
  // the same morning's report twice.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS report_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      report_date DATE NOT NULL,
      report_type VARCHAR(20) NOT NULL DEFAULT 'daily',
      sent_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (customer_id, report_date, report_type)
    )
  `);

  await ensureColumn('fuel_purchases', 'total_amount_ngn', 'INTEGER');
  await ensureColumn('fuel_purchases', 'obd_refuel_detected_at', 'TIMESTAMP');
  await ensureColumn('fuel_purchases', 'ignition_on_at', 'TIMESTAMP');
  await ensureColumn('fuel_receipts', 'obd_refuel_detected_at', 'TIMESTAMP');
  await ensureColumn('fuel_receipts', 'ignition_on_at', 'TIMESTAMP');
  await ensureColumn('fuel_receipts', 'client_receipt_id', 'VARCHAR(64)');
  await ensureColumn('fuel_receipts', 'verification', 'JSONB');
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fuel_receipts_client_receipt_id
      ON fuel_receipts (client_receipt_id)
      WHERE client_receipt_id IS NOT NULL
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_drivers_customer
      ON drivers (customer_id)
  `);

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

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS place_cache (
      geo_key VARCHAR(32) PRIMARY KEY,
      latitude DECIMAL(10,6) NOT NULL,
      longitude DECIMAL(11,6) NOT NULL,
      formatted_address TEXT,
      place_name VARCHAR(255),
      place_id VARCHAR(255),
      photo_reference TEXT,
      looked_up_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await ensureColumn('fuel_purchases', 'odometer_photo_url', 'TEXT');
  await ensureColumn('fuel_purchases', 'odometer_delta_km', 'INTEGER');
  await ensureColumn('fuel_purchases', 'gps_distance_km', 'DECIMAL(10,1)');
  await ensureColumn('fuel_purchases', 'real_consumption_l_per_100km', 'DECIMAL(6,2)');
  await ensureColumn('fuel_purchases', 'distance_mismatch', 'BOOLEAN DEFAULT false');
  await ensureColumn('fuel_purchases', 'implausible_odometer', 'BOOLEAN DEFAULT false');
  await ensureColumn('fuel_purchases', 'unusual_purchase', 'BOOLEAN DEFAULT false');
  await ensureColumn('fuel_purchases', 'flag_reason', 'TEXT');

  await ensureColumn('vehicles', 'vehicle_type', 'VARCHAR(20)');
  await ensureColumn('vehicles', 'consumption_rate_l_per_100km', 'DECIMAL(6,2)');
  await ensureColumn('vehicles', 'idle_burn_rate_l_per_hour', 'DECIMAL(5,2)');
  await ensureColumn('vehicles', 'rate_source', "VARCHAR(12) DEFAULT 'preset'");

  // The speed the fleet considers too fast for this vehicle, in km/h.
  //
  // Mirrors the limit set in the Teltonika Configurator so overspeeding can be
  // reported from the measured GPS speed we already store. The device only
  // emits AVL 255 when its Overspeeding *scenario* is switched on — setting a
  // limit alone is not enough — and until now nothing in the app knew what
  // "too fast" meant, so overspeed could not be shown at all without inventing
  // a threshold. NULL means the fleet has not declared one and no overspeed is
  // reported for that vehicle.
  await ensureColumn('vehicles', 'speed_limit_kph', 'INTEGER');

  // Vehicles created before the class presets existed have no rate at all, so
  // every estimate for them would fall back to a hardcoded guess. Seed them
  // with the default class; a manager can correct the type, and calibration
  // overwrites the numbers once real fill-ups are logged either way.
  {
    const { VEHICLE_TYPE_PRESETS, DEFAULT_VEHICLE_TYPE } = await import('../lib/fuel-metrics');
    const preset = VEHICLE_TYPE_PRESETS[DEFAULT_VEHICLE_TYPE];
    await db.execute(sql`
      UPDATE vehicles
      SET vehicle_type = COALESCE(vehicle_type, ${DEFAULT_VEHICLE_TYPE}),
          consumption_rate_l_per_100km =
            COALESCE(consumption_rate_l_per_100km, ${preset.consumptionL100km}),
          idle_burn_rate_l_per_hour =
            COALESCE(idle_burn_rate_l_per_hour, ${preset.idleBurnLph}),
          rate_source = COALESCE(rate_source, 'preset')
      WHERE vehicle_type IS NULL
         OR consumption_rate_l_per_100km IS NULL
         OR idle_burn_rate_l_per_hour IS NULL
    `);
  }

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS notification_preferences (
      id BIGSERIAL PRIMARY KEY,
      customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      alert_type VARCHAR(40) NOT NULL,
      email_enabled BOOLEAN NOT NULL DEFAULT false,
      email_address VARCHAR(255),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (customer_id, alert_type)
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS feature_flags (
      id BIGSERIAL PRIMARY KEY,
      customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
      flag_key VARCHAR(60) NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      note TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // A partial unique index, because NULL customer_id (the platform-wide row)
  // would otherwise never collide with itself under a plain UNIQUE constraint.
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_flags_global
      ON feature_flags (flag_key) WHERE customer_id IS NULL
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_flags_customer
      ON feature_flags (customer_id, flag_key) WHERE customer_id IS NOT NULL
  `);

  await ensureColumn('place_cache', 'street_view_pano_id', 'VARCHAR(255)');
  await ensureColumn('place_cache', 'street_view_date', 'VARCHAR(16)');

  await ensureColumn('vehicles', 'odometer_baseline_km', 'INTEGER');
  await ensureColumn('vehicles', 'odometer_baseline_device_km', 'INTEGER');
  await ensureColumn('vehicles', 'odometer_baseline_at', 'TIMESTAMP');

  await ensureColumn('telemetry', 'fuel_source', 'VARCHAR(12)');
  await ensureColumn('telemetry', 'fuel_used_gps_ml', 'BIGINT');
  await ensureColumn('telemetry', 'fuel_rate_lph', 'DECIMAL(8,2)');
  await ensureColumn('telemetry', 'burn_ml', 'BIGINT');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS virtual_tanks (
      vehicle_id UUID PRIMARY KEY REFERENCES vehicles(id) ON DELETE CASCADE,
      customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      capacity_liters DECIMAL(10,2) NOT NULL,
      level_ml BIGINT NOT NULL,
      last_fuel_used_ml BIGINT,
      last_reading_at TIMESTAMP,
      calibrated_at TIMESTAMP,
      calibration_source VARCHAR(30),
      consumed_since_calibration_ml BIGINT NOT NULL DEFAULT 0,
      learned_idle_lph DECIMAL(6,3),
      confidence INTEGER NOT NULL DEFAULT 30,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // The modelled-burn counter the tank level is computed from. Added here
  // rather than left to `drizzle-kit push` (which is how the earlier anchor
  // columns arrived) so a deploy that only restarts the service still gets them.
  await ensureColumn('virtual_tanks', 'modelled_burn_ml', 'BIGINT NOT NULL DEFAULT 0');
  await ensureColumn('virtual_tanks', 'anchor_modelled_ml', 'BIGINT');
  await ensureColumn('virtual_tanks', 'last_odometer_m', 'BIGINT');

  await ensureColumn('alerts', 'is_resolved', 'BOOLEAN DEFAULT false');
  await ensureColumn('alerts', 'resolved_at', 'TIMESTAMP');
  await ensureColumn('alerts', 'latitude', 'DECIMAL(10,8)');
  await ensureColumn('alerts', 'longitude', 'DECIMAL(11,8)');
  await ensureColumn('alerts', 'fuel_drop_liters', 'DECIMAL(10,2)');
  await ensureColumn('alerts', 'estimated_loss_ngn', 'INTEGER');

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
    CREATE TABLE IF NOT EXISTS device_events (
      id BIGSERIAL PRIMARY KEY,
      imei VARCHAR(20) REFERENCES devices(imei),
      customer_id UUID REFERENCES customers(id),
      vehicle_id UUID REFERENCES vehicles(id),
      event_type VARCHAR(40) NOT NULL,
      severity VARCHAR(10) NOT NULL DEFAULT 'info',
      value DECIMAL(12,3),
      unit VARCHAR(12),
      speed_kph INTEGER,
      latitude DECIMAL(10,8),
      longitude DECIMAL(11,8),
      occurred_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_device_events_customer_occurred
      ON device_events (customer_id, occurred_at DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_device_events_vehicle_occurred
      ON device_events (vehicle_id, occurred_at DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_device_events_type
      ON device_events (customer_id, event_type, occurred_at DESC)
  `);

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

  const { backfillDriverReceiptPurchases } = await import('../lib/driver-receipt-sync');
  await backfillDriverReceiptPurchases(db);

  const { syncDemoVehicleDrivers } = await import('../lib/sync-vehicle-drivers');
  await syncDemoVehicleDrivers(db);
};

export const closePool = async (): Promise<void> => {
  await pool.end();
};

export { schema };
