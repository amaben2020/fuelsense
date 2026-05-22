const express = require('express');
const { authenticateCustomer } = require('../middleware/auth');
const { db, alerts, vehicles, eq, and, desc } = require('../lib/db-helpers');

const router = express.Router();

router.use(authenticateCustomer);

const ANOMALY_META = {
  fuel_theft: {
    type: 'theft',
    severity: 'critical',
    title: 'Fuel theft detected',
  },
  receipt_fraud: {
    type: 'fraud',
    severity: 'critical',
    title: 'Receipt mismatch detected',
  },
  excessive_idle: {
    type: 'idle',
    severity: 'warning',
    title: 'Excessive idling',
  },
  poor_efficiency: {
    type: 'efficiency',
    severity: 'warning',
    title: 'Poor fuel efficiency',
  },
};

function mapAlertToAnomaly(row) {
  const meta = ANOMALY_META[row.alert_type] ?? {
    type: 'theft',
    severity: 'warning',
    title: row.alert_type,
  };

  return {
    id: String(row.id),
    vehicle_id: row.vehicle_id,
    vehicle_plate: row.license_plate,
    type: meta.type,
    severity: meta.severity,
    message: meta.title,
    details: row.message,
    liters_lost:
      row.fuel_drop_liters != null ? Number(row.fuel_drop_liters) : undefined,
    amount_lost_ngn:
      row.estimated_loss_ngn != null ? Number(row.estimated_loss_ngn) : undefined,
    timestamp: row.created_at,
    latitude: row.latitude,
    longitude: row.longitude,
    acknowledged: !!row.is_resolved,
  };
}

router.get('/anomalies', async (req, res) => {
  try {
    const rows = await db
      .select({
        id: alerts.id,
        imei: alerts.imei,
        customer_id: alerts.customerId,
        vehicle_id: alerts.vehicleId,
        alert_type: alerts.alertType,
        message: alerts.message,
        fuel_level_liters: alerts.fuelLevelLiters,
        fuel_drop_liters: alerts.fuelDropLiters,
        estimated_loss_ngn: alerts.estimatedLossNgn,
        latitude: alerts.latitude,
        longitude: alerts.longitude,
        is_resolved: alerts.isResolved,
        created_at: alerts.createdAt,
        license_plate: vehicles.licensePlate,
      })
      .from(alerts)
      .leftJoin(vehicles, eq(alerts.vehicleId, vehicles.id))
      .where(eq(alerts.customerId, req.user.customerId))
      .orderBy(desc(alerts.createdAt))
      .limit(30);

    res.json(rows.map(mapAlertToAnomaly));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const rows = await db
      .select({
        id: alerts.id,
        imei: alerts.imei,
        customer_id: alerts.customerId,
        vehicle_id: alerts.vehicleId,
        alert_type: alerts.alertType,
        message: alerts.message,
        fuel_level_liters: alerts.fuelLevelLiters,
        fuel_drop_liters: alerts.fuelDropLiters,
        estimated_loss_ngn: alerts.estimatedLossNgn,
        latitude: alerts.latitude,
        longitude: alerts.longitude,
        is_resolved: alerts.isResolved,
        resolved_at: alerts.resolvedAt,
        created_at: alerts.createdAt,
        license_plate: vehicles.licensePlate,
      })
      .from(alerts)
      .leftJoin(vehicles, eq(alerts.vehicleId, vehicles.id))
      .where(
        and(eq(alerts.customerId, req.user.customerId), eq(alerts.isResolved, false))
      )
      .orderBy(desc(alerts.createdAt))
      .limit(20);

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/:id/acknowledge', async (req, res) => {
  try {
    const alertId = Number(req.params.id);
    if (!Number.isFinite(alertId)) {
      return res.status(400).json({ error: 'Invalid alert id' });
    }

    const [updated] = await db
      .update(alerts)
      .set({ isResolved: true, resolvedAt: new Date() })
      .where(
        and(eq(alerts.id, alertId), eq(alerts.customerId, req.user.customerId))
      )
      .returning({ id: alerts.id });

    if (!updated) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    res.json({ ok: true, id: updated.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
