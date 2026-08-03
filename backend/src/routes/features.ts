import express, { Request, Response } from 'express';
import { authenticateCustomer } from '../middleware/auth';
import { FEATURES, resolveFeatureFlags, setFeatureFlag } from '../lib/feature-flags';
import { VEHICLE_TYPE_PRESETS, CALIBRATION_MIN_PURCHASES, SPEED_BUCKETS } from '../lib/fuel-metrics';
import { ALERT_CATALOGUE } from '../lib/alert-catalogue';
import { db, notificationPreferences, eq, and, sql } from '../lib/db-helpers';

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

/** Everything the Documentation page renders — alerts, how estimates work, and
 *  the limits worth being honest about. Generated from the same constants the
 *  engines use, so the docs cannot drift from the behaviour. */
router.get('/documentation', async (req: Request, res: Response) => {
  try {
    const prefs = await db
      .select({
        alertType: notificationPreferences.alertType,
        emailEnabled: notificationPreferences.emailEnabled,
        emailAddress: notificationPreferences.emailAddress,
      })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.customerId, req.user.customerId));

    const prefBy = new Map(prefs.map((p) => [p.alertType, p]));

    res.json({
      alerts: ALERT_CATALOGUE.map((a) => ({
        ...a,
        email_enabled: prefBy.get(a.type)?.emailEnabled ?? false,
        email_address: prefBy.get(a.type)?.emailAddress ?? null,
      })),
      fuel: {
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
      },
      limitations: [
        'Fuel level is calculated from movement and logged purchases, not read from a tank sensor. It is an estimate that improves as fill-ups are logged.',
        'Siphoning while parked cannot be detected in real time. What the platform catches is consumption that does not match distance, and fuel claims that do not match the vehicle’s real rate.',
        'Device scenario alerts — overspeeding, towing, crash, jamming, geofences — only fire if those scenarios are enabled on the tracker itself.',
      ],
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/** Opt in or out of email for a given alert type. */
router.patch('/notifications/:alertType', async (req: Request, res: Response) => {
  const alertType = String(req.params.alertType);
  const { emailEnabled, emailAddress } = req.body as {
    emailEnabled?: boolean;
    emailAddress?: string | null;
  };

  if (typeof emailEnabled !== 'boolean') {
    res.status(400).json({ error: 'emailEnabled must be a boolean' });
    return;
  }
  if (!ALERT_CATALOGUE.some((a) => a.type === alertType)) {
    res.status(400).json({ error: `Unknown alert type "${alertType}"` });
    return;
  }

  try {
    const [existing] = await db
      .select({ id: notificationPreferences.id })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.customerId, req.user.customerId),
          eq(notificationPreferences.alertType, alertType)
        )
      )
      .limit(1);

    if (existing) {
      await db
        .update(notificationPreferences)
        .set({ emailEnabled, emailAddress: emailAddress ?? null, updatedAt: sql`NOW()` })
        .where(eq(notificationPreferences.id, existing.id));
    } else {
      await db.insert(notificationPreferences).values({
        customerId: req.user.customerId,
        alertType,
        emailEnabled,
        emailAddress: emailAddress ?? null,
      });
    }

    res.json({ success: true, alert_type: alertType, email_enabled: emailEnabled });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
