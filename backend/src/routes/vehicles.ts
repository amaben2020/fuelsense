import express, { Request, Response } from 'express';
import { authenticateCustomer } from '../middleware/auth';
import { getFleetByCustomerId } from '../db/queries';
import {
  db,
  customers,
  vehicles,
  telemetry,
  IMEI_PATTERN,
  linkDevice,
  createVehicle,
  customerPublicSelect,
  eq,
  and,
  desc,
  sql,
} from '../lib/db-helpers';
import { withCache, invalidate, cacheKey } from '../lib/redis';
import { getVirtualTank, calibrateTank } from '../lib/virtual-tank';
import { CATALOGUE_MIN_YEAR, VEHICLE_CATALOGUE } from '../lib/vehicle-catalogue';
import { engageImmobilizer, getImmobilizerStatus, releaseImmobilizer } from '../lib/immobilizer';
import {
  ECONOMY_UNIT_LABELS,
  baselineEfficiencyL100km,
  economyToL100km,
  isEconomyUnit,
  l100kmToKmL,
  kmLToMpg,
} from '../lib/fuel-metrics';

const router = express.Router();

router.use(authenticateCustomer);

router.get('/fleet', async (req: Request, res: Response) => {
  try {
    const key = cacheKey(req.user.customerId, 'fleet');
    const rows = await withCache(key, 5, () => getFleetByCustomerId(db, req.user.customerId));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/', async (req: Request, res: Response) => {
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
    res.status(500).json({ error: (error as Error).message });
  }
});

const serializeTank = (tank: NonNullable<Awaited<ReturnType<typeof getVirtualTank>>>) => ({
  vehicle_id: tank.vehicleId,
  capacity_liters: tank.capacityLiters,
  level_liters: Number((tank.levelMl / 1000).toFixed(2)),
  level_percent:
    tank.capacityLiters > 0
      ? Math.round((tank.levelMl / 1000 / tank.capacityLiters) * 100)
      : null,
  confidence: tank.confidence,
  calibrated_at: tank.calibratedAt,
  calibration_source: tank.calibrationSource,
  consumed_since_calibration_liters: Number(
    (tank.consumedSinceCalibrationMl / 1000).toFixed(2)
  ),
  learned_idle_lph: tank.learnedIdleLph,
  last_reading_at: tank.lastReadingAt,
});

const ownedVehicle = async (vehicleId: string, customerId: string) => {
  const [row] = await db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.customerId, customerId)))
    .limit(1);
  return row ?? null;
};

router.get('/:id/virtual-tank', async (req: Request, res: Response) => {
  const vehicleId = String(req.params.id);
  try {
    if (!(await ownedVehicle(vehicleId, req.user.customerId))) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }
    const tank = await getVirtualTank(vehicleId);
    res.json(tank ? serializeTank(tank) : null);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Anchor the virtual tank to a known level. Body: { liters?: number } —
// omitted/null means "driver filled the tank" (level = capacity).
router.post('/:id/virtual-tank/calibrate', async (req: Request, res: Response) => {
  const { liters } = req.body as { liters?: number | null };

  if (liters != null && (!Number.isFinite(Number(liters)) || Number(liters) < 0)) {
    res.status(400).json({ error: 'liters must be a non-negative number' });
    return;
  }

  const vehicleId = String(req.params.id);
  try {
    if (!(await ownedVehicle(vehicleId, req.user.customerId))) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }

    const tank = await calibrateTank(
      vehicleId,
      req.user.customerId,
      liters != null ? Number(liters) : null,
      liters != null ? 'manual_partial' : 'manual_full'
    );

    await invalidate(req.user.customerId, 'fleet', 'summary');
    res.json({ success: true, tank: serializeTank(tank) });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * The vehicle's own economy figure, as read off its dashboard.
 *
 * Body: `{ value: number, unit: 'mpg_us'|'mpg_imp'|'km_l'|'l_100km' }`, or
 * `{ value: null }` to clear it and hand the vehicle back to the class preset
 * and fill-to-fill calibration.
 *
 * Until now the benchmark every economy figure is judged against came from a
 * table keyed on model name — a RAV4 was assumed to do 7 km/L whatever its age,
 * engine or condition. The vehicle's own trip computer is better evidence than
 * our guess, so a manager who has one can put it in. `rate_source = 'manual'`
 * makes it stick: `recalculateVehicleRate` returns early rather than resetting
 * it on the next receipt.
 *
 * The unit is required, never inferred — see `economyToL100km`.
 */
router.post('/:id/economy', async (req: Request, res: Response) => {
  const { value, unit } = req.body as { value?: number | null; unit?: unknown };
  const vehicleId = String(req.params.id);

  try {
    if (!(await ownedVehicle(vehicleId, req.user.customerId))) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }

    const [vehicle] = await db
      .select({ model: vehicles.model, vehicleType: vehicles.vehicleType })
      .from(vehicles)
      .where(eq(vehicles.id, vehicleId))
      .limit(1);

    // Clearing: fall back to the class preset and let calibration resume.
    if (value == null) {
      const presetL100km = baselineEfficiencyL100km(vehicle?.model ?? '');
      await db
        .update(vehicles)
        .set({
          consumptionRateL100km: presetL100km.toFixed(2),
          rateSource: 'preset',
          updatedAt: sql`NOW()`,
        })
        .where(eq(vehicles.id, vehicleId));

      await invalidate(req.user.customerId, 'fleet', 'summary');
      res.json({
        success: true,
        rate_source: 'preset',
        consumption_l_per_100km: presetL100km,
        km_per_liter: l100kmToKmL(presetL100km),
      });
      return;
    }

    if (!isEconomyUnit(unit)) {
      res.status(400).json({
        error: `unit must be one of ${Object.keys(ECONOMY_UNIT_LABELS).join(', ')}`,
      });
      return;
    }

    const l100km = economyToL100km(Number(value), unit);
    if (l100km == null) {
      res.status(400).json({
        error:
          `${value} ${ECONOMY_UNIT_LABELS[unit]} is not a plausible vehicle economy ` +
          '(expected between 1 and 50 km/L). Check the figure and the unit.',
      });
      return;
    }

    await db
      .update(vehicles)
      .set({
        consumptionRateL100km: l100km.toFixed(2),
        rateSource: 'manual',
        updatedAt: sql`NOW()`,
      })
      .where(eq(vehicles.id, vehicleId));

    await invalidate(req.user.customerId, 'fleet', 'summary');

    const kmL = l100kmToKmL(l100km);
    res.json({
      success: true,
      rate_source: 'manual',
      entered: { value: Number(value), unit, label: ECONOMY_UNIT_LABELS[unit] },
      consumption_l_per_100km: l100km,
      km_per_liter: kmL,
      mpg_us: kmLToMpg(kmL),
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Anchor the vehicle's true mileage to the dashboard reading. The tracker only
// counts distance since it was fitted, so we store the manager's reading plus
// the device's counter at that instant and report the sum from then on.
router.post('/:id/odometer', async (req: Request, res: Response) => {
  const vehicleId = String(req.params.id);
  const { odometerKm } = req.body as { odometerKm?: number };
  const reading = Number(odometerKm);

  if (!Number.isFinite(reading) || reading < 0) {
    res.status(400).json({ error: 'odometerKm must be a non-negative number' });
    return;
  }

  try {
    if (!(await ownedVehicle(vehicleId, req.user.customerId))) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }

    const [latest] = await db
      .select({ odometer_km: telemetry.odometerKm })
      .from(telemetry)
      .where(and(eq(telemetry.vehicleId, vehicleId), sql`odometer_km IS NOT NULL`))
      .orderBy(desc(telemetry.recordedAt))
      .limit(1);

    const deviceKm = latest?.odometer_km ?? 0;

    const [row] = await db
      .update(vehicles)
      .set({
        odometerBaselineKm: Math.round(reading),
        odometerBaselineDeviceKm: deviceKm,
        odometerBaselineAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      })
      .where(eq(vehicles.id, vehicleId))
      .returning({
        baseline_km: vehicles.odometerBaselineKm,
        baseline_device_km: vehicles.odometerBaselineDeviceKm,
      });

    await invalidate(req.user.customerId, 'fleet', 'summary');
    res.json({
      success: true,
      total_odometer_km: row.baseline_km,
      baseline_km: row.baseline_km,
      device_km_at_baseline: row.baseline_device_km,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Declare the speed above which this vehicle is overspeeding, in km/h.
 *
 * Set it to whatever limit is configured on the tracker. The device only emits
 * AVL 255 when its Overspeeding scenario is enabled, and a limit typed into the
 * Configurator without that scenario produces no events at all — so the figure
 * is stored here too and overspeeding is derived from the GPS speed already on
 * every fix. That also means history can be re-scanned, which a device-side
 * event never allows.
 *
 * Body: `{ speedLimitKph: number | null }`. Null clears it, and no overspeeding
 * is reported for the vehicle rather than a default being assumed.
 */
router.post('/:id/speed-limit', async (req: Request, res: Response) => {
  const vehicleId = String(req.params.id);
  const { speedLimitKph } = req.body as { speedLimitKph?: number | null };

  const limit =
    speedLimitKph === null || speedLimitKph === undefined ? null : Number(speedLimitKph);

  // A limit under 20 km/h would flag a car park as a motorway; over 200 is
  // beyond anything these vehicles do and is more likely a typo than a policy.
  if (limit !== null && (!Number.isFinite(limit) || limit < 20 || limit > 200)) {
    res.status(400).json({ error: 'speedLimitKph must be between 20 and 200, or null' });
    return;
  }

  try {
    if (!(await ownedVehicle(vehicleId, req.user.customerId))) {
      res.status(404).json({ error: 'Vehicle not found' });
      return;
    }

    await db
      .update(vehicles)
      .set({ speedLimitKph: limit === null ? null : Math.round(limit), updatedAt: sql`NOW()` })
      .where(eq(vehicles.id, vehicleId));

    await invalidate(req.user.customerId, 'fleet', 'summary');
    res.json({ success: true, speed_limit_kph: limit === null ? null : Math.round(limit) });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * The make / model / year catalogue behind the Add Vehicle form.
 *
 * Served whole rather than as three chained lookups: it is a few kilobytes,
 * it never changes between requests, and a form that has it in hand can
 * narrow models and years instantly instead of showing a spinner between
 * every dropdown.
 *
 * Each model carries the figures a new vehicle is seeded with, so the form can
 * show the manager what picking it will do — "60 L tank, 11.8 L/100 km to
 * start" — rather than applying it silently.
 */
router.get('/catalogue', async (_req: Request, res: Response) => {
  res.json({
    min_year: CATALOGUE_MIN_YEAR,
    max_year: new Date().getFullYear() + 1,
    makes: VEHICLE_CATALOGUE.map((entry) => ({
      make: entry.make,
      models: entry.models.map((spec) => ({
        model: spec.model,
        type: spec.type,
        tank_liters: spec.tankLiters,
        consumption_l_per_100km: spec.consumptionL100km,
        idle_burn_l_per_hour: spec.idleBurnLph,
        year_from: spec.years[0],
        year_to: Math.min(spec.years[1], new Date().getFullYear() + 1),
        note: spec.note ?? null,
      })),
    })),
  });
});

router.post('/', async (req: Request, res: Response) => {
  const { licensePlate, make, model, year, tankCapacityLiters, odometerBaselineKm, imei, deviceModel } =
    req.body as {
      licensePlate?: string;
      make?: string;
      model?: string;
      year?: number;
      tankCapacityLiters?: number;
      odometerBaselineKm?: number;
      imei?: string;
      deviceModel?: string;
    };

  try {
    const result = await db.transaction(async (tx) => {
      const vehicle = await createVehicle(tx, req.user.customerId, {
        licensePlate,
        make,
        model,
        year,
        tankCapacityLiters,
        odometerBaselineKm,
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
      const fleetRow = fleet?.find((row: { id: string }) => row.id === vehicle.id) ?? null;

      return { vehicle, fleetRow };
    });

    await invalidate(req.user.customerId, 'fleet', 'summary', 'alerts');
    res.status(201).json({
      success: true,
      ...result.vehicle,
      imei: imei || null,
      fleetRow: result.fleetRow,
    });
  } catch (error) {
    const err = error as Error & { status?: number; code?: string };
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err.code === '23505') {
      res.status(409).json({ error: 'Vehicle with this license plate already exists' });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/with-device', async (req: Request, res: Response) => {
  const {
    licensePlate,
    make,
    model,
    year,
    tankCapacityLiters,
    odometerBaselineKm,
    imei,
    deviceModel,
  } = req.body as {
    licensePlate?: string;
    make?: string;
    model?: string;
    year?: number;
    tankCapacityLiters?: number;
      odometerBaselineKm?: number;
    imei?: string;
    deviceModel?: string;
  };

  if (!imei) {
    res.status(400).json({ error: 'IMEI is required' });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const vehicle = await createVehicle(tx, req.user.customerId, {
        licensePlate,
        make,
        model,
        year,
        tankCapacityLiters,
        odometerBaselineKm,
      });

      await linkDevice(tx, {
        imei,
        vehicleId: vehicle.id,
        customerId: req.user.customerId,
        deviceModel,
      });

      const fleet = await getFleetByCustomerId(tx, req.user.customerId);
      const fleetRow = fleet.find((row: { id: string }) => row.id === vehicle.id) ?? null;

      return { vehicle, fleetRow };
    });

    await invalidate(req.user.customerId, 'fleet', 'summary', 'alerts');
    res.status(201).json({
      success: true,
      message: 'Vehicle and device added. Data will appear once the tracker connects.',
      vehicle: result.vehicle,
      imei,
      fleetRow: result.fleetRow,
    });
  } catch (error) {
    const err = error as Error & { status?: number; code?: string };
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err.code === '23505') {
      res.status(409).json({ error: 'Vehicle with this license plate already exists' });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/bulk', async (req: Request, res: Response) => {
  const { vehicles: vehicleEntries } = req.body as {
    vehicles?: Array<{
      licensePlate?: string;
      make?: string;
      model?: string;
      year?: number;
      tankCapacityLiters?: number;
      odometerBaselineKm?: number;
      imei?: string;
      deviceModel?: string;
    }>;
  };

  if (!Array.isArray(vehicleEntries) || vehicleEntries.length === 0) {
    res.status(400).json({ error: 'At least one vehicle is required' });
    return;
  }

  if (vehicleEntries.length > 20) {
    res.status(400).json({ error: 'Maximum 20 vehicles per bulk upload' });
    return;
  }

  try {
    const added = await db.transaction(async (tx) => {
      const results: Array<Record<string, unknown>> = [];

      for (const entry of vehicleEntries) {
        const vehicle = await createVehicle(tx, req.user.customerId, {
          licensePlate: entry.licensePlate,
          make: entry.make,
          model: entry.model,
          year: entry.year,
          tankCapacityLiters: entry.tankCapacityLiters,
          odometerBaselineKm: entry.odometerBaselineKm,
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
    const err = error as Error & { status?: number; code?: string };
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err.code === '23505') {
      res.status(409).json({ error: 'Duplicate license plate in your fleet' });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/immobilizer', async (req: Request, res: Response) => {
  try {
    const status = await getImmobilizerStatus(String(req.params.id), req.user.customerId);
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.post('/:id/immobilizer/engage', async (req: Request, res: Response) => {
  try {
    const result = await engageImmobilizer(
      String(req.params.id),
      req.user.customerId,
      req.user.name ?? req.user.email
    );
    if (!result.ok) {
      res.status(409).json({ error: result.error });
      return;
    }
    res.json(result.status);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.post('/:id/immobilizer/release', async (req: Request, res: Response) => {
  try {
    const result = await releaseImmobilizer(
      String(req.params.id),
      req.user.customerId,
      req.user.name ?? req.user.email
    );
    if (!result.ok) {
      res.status(409).json({ error: result.error });
      return;
    }
    res.json(result.status);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
