const express = require('express');
const { authenticateCustomer } = require('../middleware/auth');
const { getFleetByCustomerId } = require('../db/queries');
const {
  db,
  customers,
  vehicles,
  devices,
  telemetry,
  alerts,
  payments,
  deviceOrders,
  IMEI_PATTERN,
  linkDevice,
  createVehicle,
  customerPublicSelect,
  eq,
  and,
  desc,
  sql,
} = require('../lib/db-helpers');

const router = express.Router();

router.use(authenticateCustomer);

router.get('/fleet', async (req, res) => {
  try {
    const rows = await getFleetByCustomerId(db, req.user.customerId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const rows = await db
      .select({
        id: vehicles.id,
        customer_id: vehicles.customerId,
        license_plate: vehicles.licensePlate,
        make: vehicles.make,
        model: vehicles.model,
        year: vehicles.year,
        tank_capacity_liters: vehicles.tankCapacityLiters,
        created_at: vehicles.createdAt,
        updated_at: vehicles.updatedAt,
      })
      .from(vehicles)
      .where(eq(vehicles.customerId, req.user.customerId))
      .orderBy(desc(vehicles.createdAt));

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  const { licensePlate, make, model, year, tankCapacityLiters, imei, deviceModel } =
    req.body;

  try {
    const result = await db.transaction(async (tx) => {
      const vehicle = await createVehicle(tx, req.user.customerId, {
        licensePlate,
        make,
        model,
        year,
        tankCapacityLiters,
      });

      if (imei) {
        await linkDevice(tx, {
          imei,
          vehicleId: vehicle.id,
          customerId: req.user.customerId,
          deviceModel,
        });
      }

      const fleet = imei ? await getFleetByCustomerId(tx, req.user.customerId) : null;
      const fleetRow = fleet?.find((row) => row.id === vehicle.id) || null;

      return { vehicle, fleetRow };
    });

    res.status(201).json({
      success: true,
      ...result.vehicle,
      imei: imei || null,
      fleetRow: result.fleetRow,
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Vehicle with this license plate already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

router.post('/with-device', async (req, res) => {
  const {
    licensePlate,
    make,
    model,
    year,
    tankCapacityLiters,
    imei,
    deviceModel,
  } = req.body;

  if (!imei) {
    return res.status(400).json({ error: 'IMEI is required' });
  }

  try {
    const result = await db.transaction(async (tx) => {
      const vehicle = await createVehicle(tx, req.user.customerId, {
        licensePlate,
        make,
        model,
        year,
        tankCapacityLiters,
      });

      await linkDevice(tx, {
        imei,
        vehicleId: vehicle.id,
        customerId: req.user.customerId,
        deviceModel,
      });

      const fleet = await getFleetByCustomerId(tx, req.user.customerId);
      const fleetRow = fleet.find((row) => row.id === vehicle.id) || null;

      return { vehicle, fleetRow };
    });

    res.status(201).json({
      success: true,
      message: 'Vehicle and device added. Data will appear once the tracker connects.',
      vehicle: result.vehicle,
      imei,
      fleetRow: result.fleetRow,
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Vehicle with this license plate already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

router.post('/bulk', async (req, res) => {
  const { vehicles: vehicleEntries } = req.body;

  if (!Array.isArray(vehicleEntries) || vehicleEntries.length === 0) {
    return res.status(400).json({ error: 'At least one vehicle is required' });
  }

  if (vehicleEntries.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 vehicles per bulk upload' });
  }

  try {
    const added = await db.transaction(async (tx) => {
      const results = [];

      for (const entry of vehicleEntries) {
        const vehicle = await createVehicle(tx, req.user.customerId, {
          licensePlate: entry.licensePlate,
          make: entry.make,
          model: entry.model,
          year: entry.year,
          tankCapacityLiters: entry.tankCapacityLiters,
        });

        if (entry.imei) {
          await linkDevice(tx, {
            imei: entry.imei,
            vehicleId: vehicle.id,
            customerId: req.user.customerId,
            deviceModel: entry.deviceModel || 'FMC150',
          });
        }

        results.push({ ...vehicle, imei: entry.imei || null });
      }

      await tx
        .update(customers)
        .set({ onboardingCompleted: true, updatedAt: sql`NOW()` })
        .where(eq(customers.id, req.user.customerId));

      return results;
    });

    const fleet = await getFleetByCustomerId(db, req.user.customerId);

    res.status(201).json({
      success: true,
      message: `${added.length} vehicle(s) added successfully`,
      vehicles: added,
      fleet,
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Duplicate license plate in your fleet' });
    }
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
