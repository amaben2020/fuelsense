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
} = require('../lib/db-helpers');
const { findObdRefuelLiters, reconcileReceipt } = require('../lib/receipt-reconciliation');
const { DEFAULT_FUEL_PRICE_NGN_LITER } = require('../lib/fuel-metrics');

const router = express.Router();

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

    const [assignment] = await db
      .select({
        vehicle_id: vehicles.id,
        license_plate: vehicles.licensePlate,
        model: vehicles.model,
      })
      .from(vehicles)
      .where(
        and(eq(vehicles.driverId, driver.id), eq(vehicles.customerId, driver.customerId))
      )
      .limit(1);

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

    const [assignment] = await db
      .select({
        vehicle_id: vehicles.id,
        license_plate: vehicles.licensePlate,
        model: vehicles.model,
      })
      .from(vehicles)
      .where(
        and(
          eq(vehicles.driverId, req.driver.driverId),
          eq(vehicles.customerId, req.driver.customerId)
        )
      )
      .limit(1);

    res.json({ ...driver, ...assignment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/receipts', async (req, res) => {
  try {
    const rows = await db
      .select({
        id: fuelReceipts.id,
        merchant_name: fuelReceipts.merchantName,
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

    const obdLitersActual = await findObdRefuelLiters({
      vehicleId,
      customerId: req.driver.customerId,
      transactionDate: when,
    });

    const reconciliation = reconcileReceipt({
      declaredLiters: declared,
      obdLitersActual,
      pricePerLiter: price,
    });

    const [receipt] = await db
      .insert(fuelReceipts)
      .values({
        customerId: req.driver.customerId,
        driverId: req.driver.driverId,
        vehicleId,
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
        reconciliationStatus: reconciliation.reconciliationStatus,
        receiptLatitude: receiptLatitude?.toString() ?? null,
        receiptLongitude: receiptLongitude?.toString() ?? null,
        reconciledAt: reconciliation.obdLitersActual != null ? new Date() : null,
      })
      .returning({ id: fuelReceipts.id });

    await db.insert(fuelPurchases).values({
      customerId: req.driver.customerId,
      vehicleId,
      purchasedAt: when,
      merchant: merchantName.trim(),
      receiptReference: `DRV-${receipt.id.slice(0, 8).toUpperCase()}`,
      litersDeclared: declared.toFixed(2),
      litersActual:
        reconciliation.obdLitersActual != null
          ? reconciliation.obdLitersActual.toFixed(2)
          : null,
      costPerLiterNgn: Math.round(price),
      odometerKm: odometerKm ? Number(odometerKm) : null,
      status:
        reconciliation.reconciliationStatus === 'flagged_theft'
          ? 'flagged_theft'
          : reconciliation.reconciliationStatus === 'matched'
            ? 'verified'
            : 'pending_receipt',
      source: 'driver_upload',
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
