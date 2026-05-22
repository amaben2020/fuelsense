const express = require('express');
const { authenticateCustomer } = require('../middleware/auth');
const { db, alerts, vehicles, eq, and, desc } = require('../lib/db-helpers');

const router = express.Router();

router.use(authenticateCustomer);

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

module.exports = router;
