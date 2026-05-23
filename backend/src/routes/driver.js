const express = require('express');
const bcrypt = require('bcryptjs');
const { signDriverToken, authenticateDriver } = require('../middleware/auth');
const {
  db,
  drivers,
  vehicles,
  fuelReceipts,
  fuelPurchases,
  alerts,
  eq,
  and,
  desc,
  sql,
} = require('../lib/db-helpers');
const { findObdRefuelMatch, reconcileReceipt } = require('../lib/receipt-reconciliation');
const { parseReceiptText } = require('../lib/receipt-parser');
const { scanReceiptImage: ocrScanReceiptImage } = require('../lib/receipt-ocr');
const {
  buildPurchaseValuesFromReceipt,
} = require('../lib/driver-receipt-sync');
const { DEFAULT_FUEL_PRICE_NGN_LITER } = require('../lib/fuel-metrics');
const { dailyActivitySql } = require('../lib/daily-activity-sql');

const router = express.Router();

async function getDriverAssignment(driverId, customerId) {
  const [assignment] = await db
    .select({
      vehicle_id: vehicles.id,
      license_plate: vehicles.licensePlate,
      model: vehicles.model,
      make: vehicles.make,
      tank_capacity_liters: vehicles.tankCapacityLiters,
    })
    .from(vehicles)
    .where(and(eq(vehicles.driverId, driverId), eq(vehicles.customerId, customerId)))
    .limit(1);
  return assignment ?? null;
}

router.post('/login', async (req, res) => {
  const { driver_code: driverCode, pin } = req.body;
  if (!driverCode || !pin) {
    return res.status(400).json({ error: 'driver_code and pin are required' });
  }

  try {
    const [driver] = await db
      .select({
        id: drivers.id,
        customerId: drivers.customerId,
        fullName: drivers.fullName,
        driverCode: drivers.driverCode,
        pinHash: drivers.pinHash,
        status: drivers.status,
      })
      .from(drivers)
      .where(eq(drivers.driverCode, String(driverCode).trim().toUpperCase()));

    if (!driver || driver.status !== 'active') {
      return res.status(401).json({ error: 'Invalid driver credentials' });
    }

    const valid = driver.pinHash && (await bcrypt.compare(pin, driver.pinHash));
    if (!valid) {
      return res.status(401).json({ error: 'Invalid driver credentials' });
    }

    const assignment = await getDriverAssignment(driver.id, driver.customerId);
    const token = signDriverToken(driver);

    res.json({
      token,
      driver: {
        id: driver.id,
        name: driver.fullName,
        driver_code: driver.driverCode,
        vehicle_id: assignment?.vehicle_id ?? null,
        license_plate: assignment?.license_plate ?? null,
        model: assignment?.model ?? null,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.use(authenticateDriver);

router.get('/me', async (req, res) => {
  try {
    const [driver] = await db
      .select({
        id: drivers.id,
        name: drivers.fullName,
        driver_code: drivers.driverCode,
        phone: drivers.phone,
      })
      .from(drivers)
      .where(eq(drivers.id, req.driver.driverId));

    const assignment = await getDriverAssignment(req.driver.driverId, req.driver.customerId);
    res.json({ ...driver, ...assignment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/vehicle/status', async (req, res) => {
  try {
    const assignment = await getDriverAssignment(req.driver.driverId, req.driver.customerId);
    if (!assignment?.vehicle_id) {
      return res.status(404).json({ error: 'No vehicle assigned' });
    }

    const latest = await db.execute(sql`
      SELECT
        t.recorded_at,
        t.fuel_level_liters,
        t.odometer_km,
        t.speed_kph,
        t.ignition_on,
        t.latitude,
        t.longitude
      FROM telemetry t
      WHERE t.vehicle_id = ${assignment.vehicle_id}
        AND t.customer_id = ${req.driver.customerId}
      ORDER BY t.recorded_at DESC
      LIMIT 1
    `);

    const device = await db.execute(sql`
      SELECT last_seen_at, imei
      FROM devices
      WHERE vehicle_id = ${assignment.vehicle_id}
        AND customer_id = ${req.driver.customerId}
      LIMIT 1
    `);

    const row = latest.rows[0];
    const dev = device.rows[0];
    const lastSeen = dev?.last_seen_at ? new Date(dev.last_seen_at) : null;
    const online =
      lastSeen != null && Date.now() - lastSeen.getTime() < 3 * 60 * 1000;

    res.json({
      vehicle_id: assignment.vehicle_id,
      license_plate: assignment.license_plate,
      model: assignment.model,
      make: assignment.make,
      tank_capacity_liters: assignment.tank_capacity_liters,
      connection_status: online ? 'online' : 'offline',
      last_seen_at: lastSeen?.toISOString() ?? null,
      recorded_at: row?.recorded_at ?? null,
      fuel_level_liters: row?.fuel_level_liters != null ? Number(row.fuel_level_liters) : null,
      odometer_km: row?.odometer_km != null ? Number(row.odometer_km) : null,
      speed_kph: row?.speed_kph != null ? Number(row.speed_kph) : null,
      ignition_on: row?.ignition_on ?? null,
      latitude: row?.latitude != null ? Number(row.latitude) : null,
      longitude: row?.longitude != null ? Number(row.longitude) : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/trips', async (req, res) => {
  try {
    const assignment = await getDriverAssignment(req.driver.driverId, req.driver.customerId);
    if (!assignment?.vehicle_id) {
      return res.status(404).json({ error: 'No vehicle assigned' });
    }

    const days = Math.min(Number(req.query.days) || 14, 30);

    const dailyResult = await db.execute(dailyActivitySql({
      customerId: req.driver.customerId,
      days,
    }));

    const vehicleDays = dailyResult.rows.filter(
      (row) => row.vehicle_id === assignment.vehicle_id
    );

    const segments = await db.execute(sql`
      WITH readings AS (
        SELECT
          recorded_at,
          ignition_on,
          speed_kph,
          odometer_km,
          fuel_level_liters,
          latitude,
          longitude,
          LAG(ignition_on) OVER (ORDER BY recorded_at) AS prev_ignition
        FROM telemetry
        WHERE vehicle_id = ${assignment.vehicle_id}
          AND customer_id = ${req.driver.customerId}
          AND recorded_at > NOW() - (${days} || ' days')::INTERVAL
        ORDER BY recorded_at ASC
      ),
      starts AS (
        SELECT recorded_at AS started_at, odometer_km, latitude, longitude
        FROM readings
        WHERE ignition_on IS TRUE AND COALESCE(prev_ignition, FALSE) IS FALSE
      )
      SELECT started_at, odometer_km, latitude, longitude
      FROM starts
      ORDER BY started_at DESC
      LIMIT 20
    `);

    res.json({
      vehicle_id: assignment.vehicle_id,
      license_plate: assignment.license_plate,
      daily_history: vehicleDays.map((row) => ({
        activity_date: row.activity_date,
        distance_km: Math.round(Number(row.distance_km || 0) * 10) / 10,
        fuel_used_liters: Math.round(Number(row.fuel_used_liters || 0) * 10) / 10,
        idle_hours: Math.round(Number(row.idle_hours || 0) * 10) / 10,
        trip_count: Number(row.trip_count || 0),
      })),
      recent_starts: segments.rows.map((row) => ({
        started_at: row.started_at,
        odometer_km: row.odometer_km != null ? Number(row.odometer_km) : null,
        latitude: row.latitude != null ? Number(row.latitude) : null,
        longitude: row.longitude != null ? Number(row.longitude) : null,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/receipts/parse', (req, res) => {
  const { ocr_text: ocrText, merchant_hint: merchantHint } = req.body ?? {};
  if (!ocrText || String(ocrText).trim().length < 4) {
    return res.status(400).json({ error: 'ocr_text is required for parsing' });
  }

  const parsed = parseReceiptText(String(ocrText), { merchant_hint: merchantHint });
  res.json(parsed);
});

router.post('/receipts/ocr', async (req, res) => {
  const { image_data_url: imageDataUrl, merchant_hint: merchantHint } = req.body ?? {};

  if (!imageDataUrl) {
    return res.status(400).json({ error: 'image_data_url is required' });
  }

  try {
    const result = await ocrScanReceiptImage(String(imageDataUrl), {
      merchant_hint: merchantHint,
    });
    res.json(result);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({
      error: error.message || 'Receipt OCR failed',
      code: error.name || 'ocr_failed',
    });
  }
});

router.get('/receipts', async (req, res) => {
  try {
    const rows = await db
      .select({
        id: fuelReceipts.id,
        merchant_name: fuelReceipts.merchantName,
        merchant_address: fuelReceipts.merchantAddress,
        transaction_date: fuelReceipts.transactionDate,
        declared_liters: fuelReceipts.declaredLiters,
        obd_liters_actual: fuelReceipts.obdLitersActual,
        difference_liters: fuelReceipts.differenceLiters,
        reconciliation_status: fuelReceipts.reconciliationStatus,
        total_amount: fuelReceipts.totalAmount,
        uploaded_at: fuelReceipts.uploadedAt,
        license_plate: vehicles.licensePlate,
      })
      .from(fuelReceipts)
      .innerJoin(vehicles, eq(fuelReceipts.vehicleId, vehicles.id))
      .where(
        and(
          eq(fuelReceipts.driverId, req.driver.driverId),
          eq(fuelReceipts.customerId, req.driver.customerId)
        )
      )
      .orderBy(desc(fuelReceipts.uploadedAt))
      .limit(20);

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/receipts', async (req, res) => {
  const {
    vehicle_id: vehicleId,
    client_receipt_id: clientReceiptId,
    receipt_photo: receiptPhoto,
    merchant_name: merchantName,
    merchant_address: merchantAddress,
    declared_liters: declaredLiters,
    price_per_liter: pricePerLiter,
    total_amount: totalAmount,
    odometer_km: odometerKm,
    receipt_latitude: receiptLatitude,
    receipt_longitude: receiptLongitude,
    transaction_date: transactionDate,
  } = req.body;

  if (!vehicleId || !declaredLiters || !merchantName) {
    return res.status(400).json({
      error: 'vehicle_id, merchant_name, and declared_liters are required',
    });
  }

  try {
    if (clientReceiptId) {
      const existing = await db
        .select({ id: fuelReceipts.id })
        .from(fuelReceipts)
        .where(eq(fuelReceipts.clientReceiptId, String(clientReceiptId)))
        .limit(1);
      if (existing[0]) {
        return res.status(200).json({
          success: true,
          receipt_id: existing[0].id,
          duplicate: true,
          message: 'Receipt already synced.',
        });
      }
    }

    const [vehicle] = await db
      .select({ id: vehicles.id, licensePlate: vehicles.licensePlate })
      .from(vehicles)
      .where(
        and(
          eq(vehicles.id, vehicleId),
          eq(vehicles.customerId, req.driver.customerId),
          eq(vehicles.driverId, req.driver.driverId)
        )
      );

    if (!vehicle) {
      return res.status(403).json({ error: 'Vehicle not assigned to this driver' });
    }

    const when = transactionDate ? new Date(transactionDate) : new Date();
    const price = Number(pricePerLiter) || DEFAULT_FUEL_PRICE_NGN_LITER;
    const declared = Number(declaredLiters);
    const total =
      totalAmount != null ? Number(totalAmount) : Math.round(declared * price);

    const obdMatch = await findObdRefuelMatch({
      vehicleId,
      customerId: req.driver.customerId,
      transactionDate: when,
    });

    const reconciliation = reconcileReceipt({
      declaredLiters: declared,
      obdLitersActual: obdMatch.liters,
      pricePerLiter: price,
    });

    const [receipt] = await db.transaction(async (tx) => {
      const [insertedReceipt] = await tx
        .insert(fuelReceipts)
        .values({
          customerId: req.driver.customerId,
          driverId: req.driver.driverId,
          vehicleId,
          clientReceiptId: clientReceiptId ? String(clientReceiptId) : null,
          receiptPhotoUrl: receiptPhoto?.slice(0, 500_000) ?? null,
          merchantName: merchantName.trim(),
          merchantAddress: merchantAddress?.trim() ?? null,
          transactionDate: when,
          declaredLiters: declared.toFixed(2),
          pricePerLiter: price.toFixed(2),
          totalAmount: total.toFixed(2),
          odometerKm: odometerKm ? Number(odometerKm) : null,
          obdLitersActual:
            reconciliation.obdLitersActual != null
              ? reconciliation.obdLitersActual.toFixed(2)
              : null,
          differenceLiters:
            reconciliation.differenceLiters != null
              ? reconciliation.differenceLiters.toFixed(2)
              : null,
          obdRefuelDetectedAt: obdMatch.obdRefuelDetectedAt,
          ignitionOnAt: obdMatch.ignitionOnAt,
          reconciliationStatus: reconciliation.reconciliationStatus,
          receiptLatitude: receiptLatitude?.toString() ?? null,
          receiptLongitude: receiptLongitude?.toString() ?? null,
          reconciledAt: reconciliation.obdLitersActual != null ? new Date() : null,
        })
        .returning({ id: fuelReceipts.id });

      await tx.insert(fuelPurchases).values(
        buildPurchaseValuesFromReceipt({
          id: insertedReceipt.id,
          customerId: req.driver.customerId,
          vehicleId,
          merchantName: merchantName.trim(),
          transactionDate: when,
          declaredLiters: declared.toFixed(2),
          pricePerLiter: price.toFixed(2),
          obdLitersActual: reconciliation.obdLitersActual,
          obdRefuelDetectedAt: obdMatch.obdRefuelDetectedAt,
          ignitionOnAt: obdMatch.ignitionOnAt,
          odometerKm: odometerKm ? Number(odometerKm) : null,
          reconciliationStatus: reconciliation.reconciliationStatus,
        })
      );

      return [insertedReceipt];
    });

    if (reconciliation.reconciliationStatus === 'flagged_theft') {
      const diff = reconciliation.differenceLiters ?? 0;
      await db.insert(alerts).values({
        customerId: req.driver.customerId,
        vehicleId,
        alertType: 'receipt_fraud',
        message: `Receipt fraud: ${vehicle.licensePlate} claimed ${declared}L at ${merchantName} but OBD recorded ${reconciliation.obdLitersActual?.toFixed(1)}L (−${diff}L). Est. loss ₦${reconciliation.estimatedLossNgn.toLocaleString('en-NG')}.`,
        fuelDropLiters: diff.toFixed(2),
        estimatedLossNgn: reconciliation.estimatedLossNgn,
        latitude: receiptLatitude?.toString() ?? null,
        longitude: receiptLongitude?.toString() ?? null,
      });
    }

    res.status(201).json({
      success: true,
      receipt_id: receipt.id,
      reconciliation_status: reconciliation.reconciliationStatus,
      obd_liters_actual: reconciliation.obdLitersActual,
      difference_liters: reconciliation.differenceLiters,
      actual_from: reconciliation.obdLitersActual != null ? 'obd_sensor' : 'pending_obd_match',
      message:
        reconciliation.reconciliationStatus === 'flagged_theft'
          ? 'Discrepancy detected. Flagged for fleet review.'
          : reconciliation.obdLitersActual != null
            ? `Verified — OBD sensor recorded ${reconciliation.obdLitersActual.toFixed(1)}L added.`
            : 'Receipt saved. OBD match pending (refuel within ±2h).',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
