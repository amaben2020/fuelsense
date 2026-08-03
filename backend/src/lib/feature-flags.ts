// Visibility switches for dashboard areas.
//
// Resolution order, most specific first:
//   1. a row for this customer
//   2. a platform-wide row (customer_id IS NULL)
//   3. the coded default below
//
// An env override (FEATURE_<KEY>=false) short-circuits everything, so a broken
// area can be pulled immediately without a database round trip.
import { db, featureFlags, eq, and, isNull, sql } from './db-helpers';

export interface FeatureDefinition {
  key: string;
  label: string;
  /** Shown to whoever is deciding whether to switch it on. */
  description: string;
  defaultEnabled: boolean;
}

export const FEATURES: FeatureDefinition[] = [
  {
    key: 'live_monitoring',
    label: 'Live monitoring',
    description: 'Real-time map, trails, trip list and stop locations.',
    defaultEnabled: true,
  },
  {
    key: 'vehicle_view',
    label: 'Vehicle view',
    description: 'Per-vehicle gauges, fuel level and 3D model.',
    defaultEnabled: true,
  },
  {
    key: 'trip_history',
    label: 'Trip history',
    description: 'Historical trips with distance, idling and estimated fuel.',
    defaultEnabled: true,
  },
  {
    key: 'driving_behavior',
    label: 'Driving behavior',
    description:
      'Harsh braking, cornering and overspeed events. Needs the tracker scenario IO enabled; stays empty until the vehicle drives.',
    defaultEnabled: true,
  },
  {
    key: 'fuel_analytics',
    label: 'Fuel analytics',
    description:
      'Loss-by-vehicle and anomaly detection. Parts of this depend on tank-level readings that GPS-only vehicles cannot provide.',
    defaultEnabled: false,
  },
  {
    key: 'fuel_estimate',
    label: 'Fuel estimate',
    description: 'Distance and idle based consumption estimates.',
    defaultEnabled: true,
  },
  {
    key: 'receipts',
    label: 'Receipts',
    description: 'Driver-submitted fuel receipts and reconciliation.',
    defaultEnabled: true,
  },
  {
    key: 'replay_events',
    label: 'Replay events',
    description: 'Day-by-day replay of vehicle activity.',
    defaultEnabled: true,
  },
  {
    key: 'alerts',
    label: 'Alerts',
    description: 'Movement, theft, idling and unusual purchase alerts.',
    defaultEnabled: true,
  },
  {
    key: 'fleet_overview',
    label: 'Fleet overview',
    description: 'Headline fleet KPIs and operational snapshot.',
    defaultEnabled: true,
  },
  {
    key: 'settings',
    label: 'Settings',
    description: 'Account, driver and notification settings.',
    defaultEnabled: true,
  },
];

const envKey = (key: string): string => `FEATURE_${key.toUpperCase()}`;

function envOverride(key: string): boolean | null {
  const raw = process.env[envKey(key)];
  if (raw == null || raw === '') return null;
  return raw.toLowerCase() === 'true' || raw === '1';
}

export type FlagMap = Record<string, boolean>;

/** Effective flags for a customer, with reasons for why each is set. */
export async function resolveFeatureFlags(customerId: string): Promise<FlagMap> {
  const rows = await db
    .select({
      flagKey: featureFlags.flagKey,
      enabled: featureFlags.enabled,
      customerId: featureFlags.customerId,
    })
    .from(featureFlags)
    .where(
      and(
        sql`${featureFlags.flagKey} IN ${FEATURES.map((f) => f.key)}`,
        sql`(${featureFlags.customerId} = ${customerId} OR ${featureFlags.customerId} IS NULL)`
      )
    );

  const global = new Map<string, boolean>();
  const scoped = new Map<string, boolean>();
  for (const r of rows) {
    (r.customerId == null ? global : scoped).set(r.flagKey, r.enabled);
  }

  const out: FlagMap = {};
  for (const f of FEATURES) {
    const override = envOverride(f.key);
    out[f.key] =
      override ?? scoped.get(f.key) ?? global.get(f.key) ?? f.defaultEnabled;
  }
  return out;
}

/** Upserts a per-customer override. */
export async function setFeatureFlag(
  customerId: string,
  flagKey: string,
  enabled: boolean,
  note?: string
): Promise<void> {
  const known = FEATURES.some((f) => f.key === flagKey);
  if (!known) throw Object.assign(new Error(`Unknown feature "${flagKey}"`), { status: 400 });

  const [existing] = await db
    .select({ id: featureFlags.id })
    .from(featureFlags)
    .where(and(eq(featureFlags.flagKey, flagKey), eq(featureFlags.customerId, customerId)))
    .limit(1);

  if (existing) {
    await db
      .update(featureFlags)
      .set({ enabled, note: note ?? null, updatedAt: sql`NOW()` })
      .where(eq(featureFlags.id, existing.id));
    return;
  }

  await db.insert(featureFlags).values({ customerId, flagKey, enabled, note: note ?? null });
}

export { isNull };
