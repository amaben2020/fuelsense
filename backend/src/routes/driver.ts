import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { signDriverToken, authenticateDriver } from '../middleware/auth';
import {
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
} from '../lib/db-helpers';
import { verifyReceipt } from '../lib/receipt-verification';
import { parseReceiptText } from '../lib/receipt-parser';
import { scanReceiptImage as ocrScanReceiptImage } from '../lib/receipt-ocr';
import { buildPurchaseValuesFromReceipt } from '../lib/driver-receipt-sync';
import { notifyReceiptUploaded } from '../lib/receipt-notifier';
import { DEFAULT_FUEL_PRICE_NGN_LITER } from '../lib/fuel-metrics';
import { creditRefuel } from '../lib/virtual-tank';
import { reconcileFuelPurchase } from '../lib/fuel-calibration';
import { dailyActivitySql } from '../lib/daily-activity-sql';

const router = express.Router();

async function getDriverAssignment(driverId: string, customerId: string) {
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

router.post('/login', async (req: Request, res: Response) => {
  const { driver_code: driverCode, pin } = req.body as {
    driver_code?: string;
    pin?: string;
  };
  if (!driverCode || !pin) {
    res.status(400).json({ error: 'driver_code and pin are required' });
    return;
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
      res.status(401).json({ error: 'Invalid driver credentials' });
      return;
    }

    const valid = driver.pinHash && (await bcrypt.compare(pin, driver.pinHash));
    if (!valid) {
      res.status(401).json({ error: 'Invalid driver credentials' });
      return;
    }

    const assignment = await getDriverAssignment(driver.id, driver.customerId);
    const token = signDriverToken(driver as Parameters<typeof signDriverToken>[0]);

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
    res.status(500).json({ error: (error as Error).message });
  }
});

router.use(authenticateDriver);

router.get('/me', async (req: Request, res: Response) => {
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
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/vehicle/status', async (req: Request, res: Response) => {
  try {
    const assignment = await getDriverAssignment(req.driver.driverId, req.driver.customerId);
    if (!assignment?.vehicle_id) {
      res.status(404).json({ error: 'No vehicle assigned' });
      return;
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

    const row = (latest.rows[0] ?? null) as Record<string, unknown> | null;
    const dev = (device.rows[0] ?? null) as Record<string, unknown> | null;
    const lastSeen = dev?.last_seen_at ? new Date(dev.last_seen_at as string) : null;
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
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/trips', async (req: Request, res: Response) => {
  try {
    const assignment = await getDriverAssignment(req.driver.driverId, req.driver.customerId);
    if (!assignment?.vehicle_id) {
      res.status(404).json({ error: 'No vehicle assigned' });
      return;
    }

    const days = Math.min(Number(req.query.days) || 14, 30);

    const dailyResult = await db.execute(dailyActivitySql({
      customerId: req.driver.customerId,
      days,
    }));

    const vehicleDays = dailyResult.rows.filter(
      (row) => (row as Record<string, unknown>).vehicle_id === assignment.vehicle_id
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
      daily_history: vehicleDays.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          activity_date: r.activity_date,
          distance_km: Math.round(Number(r.distance_km || 0) * 10) / 10,
          fuel_used_liters: Math.round(Number(r.fuel_used_liters || 0) * 10) / 10,
          idle_hours: Math.round(Number(r.idle_hours || 0) * 10) / 10,
          trip_count: Number(r.trip_count || 0),
        };
      }),
      recent_starts: segments.rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          started_at: r.started_at,
          odometer_km: r.odometer_km != null ? Number(r.odometer_km) : null,
          latitude: r.latitude != null ? Number(r.latitude) : null,
          longitude: r.longitude != null ? Number(r.longitude) : null,
        };
      }),
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.post('/receipts/parse', (req: Request, res: Response) => {
  const { ocr_text: ocrText, merchant_hint: merchantHint } = (req.body ?? {}) as {
    ocr_text?: string;
    merchant_hint?: string;
  };
  if (!ocrText || String(ocrText).trim().length < 4) {
    res.status(400).json({ error: 'ocr_text is required for parsing' });
    return;
  }

  const parsed = parseReceiptText(String(ocrText), { merchant_hint: merchantHint });
  res.json(parsed);
});

router.post('/receipts/ocr', async (req: Request, res: Response) => {
  const { image_data_url: imageDataUrl, merchant_hint: merchantHint } = (req.body ?? {}) as {
    image_data_url?: string;
    merchant_hint?: string;
  };

  if (!imageDataUrl) {
    res.status(400).json({ error: 'image_data_url is required' });
    return;
  }

  try {
    const result = await ocrScanReceiptImage(String(imageDataUrl), {
      merchant_hint: merchantHint,
    });
    res.json(result);
  } catch (error) {
    const err = error as Error & { status?: number; name?: string };
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || 'Receipt OCR failed',
      code: err.name || 'ocr_failed',
    });
  }
});

router.get('/receipts', async (req: Request, res: Response) => {
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
        verification: fuelReceipts.verification,
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
    res.status(500).json({ error: (error as Error).message });
  }
});

// The device already reports the odometer, so the driver is not asked to read
// it off the dash at the pump. Anchored to the purchase time rather than now,
// because a receipt queued offline can arrive hours and many kilometres later.
async function odometerAtPurchase(
  vehicleId: string,
  customerId: string,
  when: Date
): Promise<number | null> {
  const before = await db.execute(sql`
    SELECT odometer_km
    FROM telemetry
    WHERE vehicle_id = ${vehicleId}
      AND customer_id = ${customerId}
      AND odometer_km IS NOT NULL
      AND recorded_at <= ${when}
    ORDER BY recorded_at DESC
    LIMIT 1
  `);

  // A receipt timed before this vehicle's first reading (clock skew on the
  // phone, or a device fitted after the fill) still deserves the nearest fix.
  const row =
    before.rows[0] ??
    (
      await db.execute(sql`
        SELECT odometer_km
        FROM telemetry
        WHERE vehicle_id = ${vehicleId}
          AND customer_id = ${customerId}
          AND odometer_km IS NOT NULL
        ORDER BY recorded_at ASC
        LIMIT 1
      `)
    ).rows[0];

  const value = (row as Record<string, unknown> | undefined)?.odometer_km;
  return value != null ? Number(value) : null;
}

router.post('/receipts', async (req: Request, res: Response) => {
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
  } = req.body as {
    vehicle_id?: string;
    client_receipt_id?: string;
    receipt_photo?: string;
    merchant_name?: string;
    merchant_address?: string;
    declared_liters?: number;
    price_per_liter?: number;
    total_amount?: number;
    odometer_km?: number;
    receipt_latitude?: number | string;
    receipt_longitude?: number | string;
    transaction_date?: string;
  };

  if (!vehicleId || !declaredLiters || !merchantName) {
    res.status(400).json({
      error: 'vehicle_id, merchant_name, and declared_liters are required',
    });
    return;
  }

  try {
    if (clientReceiptId) {
      const existing = await db
        .select({ id: fuelReceipts.id })
        .from(fuelReceipts)
        .where(eq(fuelReceipts.clientReceiptId, String(clientReceiptId)))
        .limit(1);
      if (existing[0]) {
        res.status(200).json({
          success: true,
          receipt_id: existing[0].id,
          duplicate: true,
          message: 'Receipt already synced.',
        });
        return;
      }
    }

    const [vehicle] = await db
      .select({
        id: vehicles.id,
        licensePlate: vehicles.licensePlate,
        tankCapacityLiters: vehicles.tankCapacityLiters,
      })
      .from(vehicles)
      .where(
        and(
          eq(vehicles.id, vehicleId),
          eq(vehicles.customerId, req.driver.customerId),
          eq(vehicles.driverId, req.driver.driverId)
        )
      );

    if (!vehicle) {
      res.status(403).json({ error: 'Vehicle not assigned to this driver' });
      return;
    }

    const when = transactionDate ? new Date(transactionDate) : new Date();
    const price = Number(pricePerLiter) || DEFAULT_FUEL_PRICE_NGN_LITER;
    const typedLiters = Number(declaredLiters);
    const total =
      totalAmount != null ? Number(totalAmount) : Math.round(typedLiters * price);

    // Drivers here buy by naira, not by litre — "₦15,000 of petrol" — and the
    // amount paid is the hard fact: it left the account and it is printed on
    // the slip. When the typed litres disagree with total ÷ price by more than
    // a rounding error (a mis-scanned digit, usually), the money wins and the
    // litres are derived, so the fleet's spend always matches its receipts.
    const impliedLiters = price > 0 ? total / price : typedLiters;
    const declared =
      Math.abs(impliedLiters - typedLiters) > Math.max(0.05, typedLiters * 0.01)
        ? Math.round(impliedLiters * 100) / 100
        : typedLiters;

    // A hand-typed value still wins when one arrives (older app builds, or a
    // receipt queued before this endpoint stopped asking for it).
    const odometer =
      odometerKm != null && Number(odometerKm) > 0
        ? Number(odometerKm)
        : await odometerAtPurchase(vehicleId, req.driver.customerId, when);

    // No tank sensor on this hardware, so the receipt is judged on where the
    // vehicle was and whether the volume could physically fit — see
    // receipt-verification.ts for why the old litres comparison could not work.
    const verification = await verifyReceipt({
      vehicleId,
      customerId: req.driver.customerId,
      transactionDate: when,
      declaredLiters: declared,
      pricePerLiter: price,
      receiptLatitude: receiptLatitude ?? null,
      receiptLongitude: receiptLongitude ?? null,
      tankCapacityLiters: vehicle.tankCapacityLiters ?? null,
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
          odometerKm: odometer,
          // Left null: nothing on this vehicle measures litres entering the
          // tank. The verification column carries the evidence instead.
          obdLitersActual: null,
          differenceLiters:
            verification.overclaimedLiters != null
              ? verification.overclaimedLiters.toFixed(2)
              : null,
          reconciliationStatus: verification.status,
          verification,
          receiptLatitude: receiptLatitude?.toString() ?? null,
          receiptLongitude: receiptLongitude?.toString() ?? null,
          reconciledAt: verification.status === 'pending' ? null : new Date(),
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
          totalAmount: total,
          odometerKm: odometer ?? undefined,
          reconciliationStatus: verification.status,
        })
      );

      return [insertedReceipt];
    });

    // Credit the virtual tank with the declared litres so the modelled level
    // steps up. A flagged receipt still credits what could physically have
    // gone in — the tank is a physical model, not a judgement.
    await creditRefuel(
      vehicleId,
      req.driver.customerId,
      verification.overclaimedLiters != null
        ? Math.max(0, declared - verification.overclaimedLiters)
        : declared,
      { pricePerLiter: price }
    ).catch((err) => console.error('[virtual_tank] refuel credit failed:', err));

    // Reconcile this fill against the previous one and refresh the vehicle's
    // measured consumption rate.
    const purchaseRow = await db
      .select({ id: fuelPurchases.id })
      .from(fuelPurchases)
      .where(eq(fuelPurchases.vehicleId, vehicleId))
      .orderBy(desc(fuelPurchases.purchasedAt))
      .limit(1);
    if (purchaseRow[0]) {
      await reconcileFuelPurchase(purchaseRow[0].id).catch((err) =>
        console.error('[calibration] failed:', err)
      );
    }

    // Tell the fleet manager a receipt has landed — in-app always, email when
    // opted in. Awaited so a failure is logged against this request, but the
    // notifier swallows its own errors: the receipt is already committed and
    // must not be lost to a notification fault.
    await notifyReceiptUploaded({
      customerId: req.driver.customerId,
      vehicleId,
      licensePlate: vehicle.licensePlate,
      driverName: req.driver.name ?? null,
      merchantName: merchantName.trim(),
      merchantAddress: merchantAddress?.trim() ?? null,
      liters: declared,
      pricePerLiter: price,
      totalAmount: total,
      odometerKm: odometer,
      transactionDate: when,
      latitude: receiptLatitude?.toString() ?? null,
      longitude: receiptLongitude?.toString() ?? null,
      reconciliationStatus: verification.status,
    });

    if (verification.status === 'flagged_theft') {
      await db.insert(alerts).values({
        customerId: req.driver.customerId,
        vehicleId,
        alertType: 'receipt_fraud',
        message: `Receipt problem on ${vehicle.licensePlate}: ${declared}L claimed at ${merchantName}. ${verification.summary} Est. exposure ₦${verification.estimatedLossNgn.toLocaleString('en-NG')}.`,
        fuelDropLiters: (verification.overclaimedLiters ?? declared).toFixed(2),
        estimatedLossNgn: verification.estimatedLossNgn,
        latitude: receiptLatitude?.toString() ?? null,
        longitude: receiptLongitude?.toString() ?? null,
      });
    }

    res.status(201).json({
      success: true,
      receipt_id: receipt.id,
      reconciliation_status: verification.status,
      obd_liters_actual: null,
      difference_liters: verification.overclaimedLiters,
      actual_from: 'tracker_evidence',
      verification,
      message:
        verification.status === 'flagged_theft'
          ? 'Flagged for fleet review — the tracker does not support this receipt.'
          : verification.status === 'matched'
            ? 'Verified against the tracker — the vehicle was at the station and the volume fits.'
            : 'Receipt saved. Waiting on tracker data to verify it.',
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
