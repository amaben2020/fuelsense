import express, { Request, Response } from 'express';
import { authenticateCustomer } from '../middleware/auth';
import { FEATURES, resolveFeatureFlags, setFeatureFlag } from '../lib/feature-flags';
import { VEHICLE_TYPE_PRESETS, CALIBRATION_MIN_PURCHASES, SPEED_BUCKETS } from '../lib/fuel-metrics';

const router = express.Router();

router.use(authenticateCustomer);

/** Effective flags plus the catalogue, so Settings can render toggles without
 *  duplicating the feature list on the client. */
router.get('/', async (req: Request, res: Response) => {
  try {
    const flags = await resolveFeatureFlags(req.user.customerId);
    res.json({
      flags,
      catalogue: FEATURES.map((f) => ({
        key: f.key,
        label: f.label,
        description: f.description,
        default_enabled: f.defaultEnabled,
        enabled: flags[f.key],
      })),
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.patch('/:key', async (req: Request, res: Response) => {
  const { enabled, note } = req.body as { enabled?: boolean; note?: string };

  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }

  try {
    await setFeatureFlag(req.user.customerId, String(req.params.key), enabled, note);
    res.json({ success: true, flags: await resolveFeatureFlags(req.user.customerId) });
  } catch (error) {
    const err = error as Error & { status?: number };
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

/** The tuning constants behind fuel estimates, exposed so the calibration and
 *  features pages can describe the live configuration instead of hardcoding it. */
router.get('/fuel-config', async (_req: Request, res: Response) => {
  res.json({
    vehicle_types: Object.entries(VEHICLE_TYPE_PRESETS).map(([key, p]) => ({
      key,
      label: p.label,
      consumption_l_per_100km: p.consumptionL100km,
      idle_burn_l_per_hour: p.idleBurnLph,
    })),
    speed_buckets: SPEED_BUCKETS.map((b) => ({
      label: b.label,
      up_to_kph: b.maxKph === Infinity ? null : b.maxKph,
      multiplier: b.multiplier,
    })),
    calibration_min_purchases: CALIBRATION_MIN_PURCHASES,
  });
});

export default router;
