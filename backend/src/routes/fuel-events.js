const express = require('express');
const { authenticateCustomer } = require('../middleware/auth');
const {
  db,
  siphonEvents,
  fuelReceipts,
  vehicles,
  drivers,
  eq,
  and,
  desc,
  sql,
} = require('../lib/db-helpers');

const {
  buildSiphonEventReplay,
  buildReceiptEventReplay,
} = require('../lib/event-replay');

const router = express.Router();

router.use(authenticateCustomer);

router.get('/', async (req, res) => {
  const customerId = req.user.customerId;

  try {
    const siphonRows = await db
      .select({
        id: siphonEvents.id,
        vehicle_id: siphonEvents.vehicleId,
        vehicle_plate: vehicles.licensePlate,
        driver_name: drivers.fullName,
        occurred_at: siphonEvents.occurredAt,
        liters_stolen: siphonEvents.litersStolen,
        estimated_loss_ngn: siphonEvents.estimatedLossNgn,
        location_name: siphonEvents.locationName,
        latitude: siphonEvents.latitude,
        longitude: siphonEvents.longitude,
        status: siphonEvents.status,
        fuel_level_before: siphonEvents.fuelLevelBefore,
        fuel_level_after: siphonEvents.fuelLevelAfter,
        engine_state_before: siphonEvents.engineStateBefore,
        engine_state_after: siphonEvents.engineStateAfter,
        parked_duration_minutes: siphonEvents.parkedDurationMinutes,
      })
      .from(siphonEvents)
      .innerJoin(vehicles, eq(siphonEvents.vehicleId, vehicles.id))
      .leftJoin(drivers, eq(siphonEvents.driverId, drivers.id))
      .where(eq(siphonEvents.customerId, customerId))
      .orderBy(desc(siphonEvents.occurredAt))
      .limit(30);

    const receiptRows = await db
      .select({
        id: fuelReceipts.id,
        vehicle_plate: vehicles.licensePlate,
        driver_name: drivers.fullName,
        merchant_name: fuelReceipts.merchantName,
        transaction_date: fuelReceipts.transactionDate,
        declared_liters: fuelReceipts.declaredLiters,
        obd_liters_actual: fuelReceipts.obdLitersActual,
        difference_liters: fuelReceipts.differenceLiters,
        estimated_loss_ngn: sql`GREATEST(0, (${fuelReceipts.differenceLiters}::numeric * COALESCE(${fuelReceipts.pricePerLiter}, 650)))::int`,
        reconciliation_status: fuelReceipts.reconciliationStatus,
        receipt_photo_url: fuelReceipts.receiptPhotoUrl,
      })
      .from(fuelReceipts)
      .innerJoin(vehicles, eq(fuelReceipts.vehicleId, vehicles.id))
      .innerJoin(drivers, eq(fuelReceipts.driverId, drivers.id))
      .where(
        and(
          eq(fuelReceipts.customerId, customerId),
          eq(fuelReceipts.reconciliationStatus, 'flagged_theft')
        )
      )
      .orderBy(desc(fuelReceipts.transactionDate))
      .limit(30);

    const totalSiphonLoss = siphonRows
      .filter((r) => r.status !== 'resolved' && r.status !== 'false_alarm')
      .reduce((s, r) => s + (Number(r.estimated_loss_ngn) || 0), 0);

    const totalReceiptLoss = receiptRows
      .filter((r) => r.reconciliation_status === 'flagged_theft')
      .reduce((s, r) => s + (Number(r.estimated_loss_ngn) || 0), 0);

    res.json({
      total_preventable_loss_ngn: totalSiphonLoss + totalReceiptLoss,
      siphon_events: siphonRows.map((row) => ({
        id: row.id,
        vehicle_id: row.vehicle_id,
        vehicle_plate: row.vehicle_plate,
        driver_name: row.driver_name,
        occurred_at: row.occurred_at,
        liters_stolen: Number(row.liters_stolen),
        estimated_loss_ngn: Number(row.estimated_loss_ngn) || 0,
        location_name: row.location_name,
        latitude: row.latitude,
        longitude: row.longitude,
        status: row.status,
        evidence: {
          fuel_level_before: Number(row.fuel_level_before),
          fuel_level_after: Number(row.fuel_level_after),
          engine_state_before: row.engine_state_before,
          engine_state_after: row.engine_state_after,
          parked_duration_minutes: row.parked_duration_minutes,
        },
      })),
      receipt_flags: receiptRows.map((row) => ({
        id: row.id,
        vehicle_plate: row.vehicle_plate,
        driver_name: row.driver_name,
        merchant_name: row.merchant_name,
        transaction_date: row.transaction_date,
        declared_liters: Number(row.declared_liters),
        obd_actual_liters: row.obd_liters_actual != null ? Number(row.obd_liters_actual) : null,
        difference_liters: row.difference_liters != null ? Number(row.difference_liters) : null,
        estimated_loss_ngn: Number(row.estimated_loss_ngn) || 0,
        status: row.reconciliation_status === 'flagged_theft' ? 'flagged' : row.reconciliation_status,
        receipt_photo_url: row.receipt_photo_url,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/siphon-events/:id/replay', async (req, res) => {
  try {
    const replay = await buildSiphonEventReplay({
      customerId: req.user.customerId,
      eventId: req.params.id,
    });
    if (!replay) return res.status(404).json({ error: 'Siphon event not found' });
    res.json(replay);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/receipts/:id/replay', async (req, res) => {
  try {
    const replay = await buildReceiptEventReplay({
      customerId: req.user.customerId,
      receiptId: req.params.id,
    });
    if (!replay) return res.status(404).json({ error: 'Receipt not found' });
    res.json(replay);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/siphon-events/:id/resolve', async (req, res) => {
  try {
    const [updated] = await db
      .update(siphonEvents)
      .set({ status: 'resolved', resolvedAt: new Date() })
      .where(
        and(
          eq(siphonEvents.id, req.params.id),
          eq(siphonEvents.customerId, req.user.customerId)
        )
      )
      .returning({ id: siphonEvents.id });

    if (!updated) return res.status(404).json({ error: 'Siphon event not found' });
    res.json({ ok: true, id: updated.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/receipts/:id/resolve', async (req, res) => {
  try {
    const [updated] = await db
      .update(fuelReceipts)
      .set({ reconciliationStatus: 'resolved', reconciledAt: new Date() })
      .where(
        and(
          eq(fuelReceipts.id, req.params.id),
          eq(fuelReceipts.customerId, req.user.customerId)
        )
      )
      .returning({ id: fuelReceipts.id });

    if (!updated) return res.status(404).json({ error: 'Receipt not found' });
    res.json({ ok: true, id: updated.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
