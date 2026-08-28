/**
 * Hard ceiling on Google Maps Platform spend.
 *
 * The brief for this file is "never get a Google bill", so it is written to
 * fail closed rather than to be convenient.
 *
 * Google replaced the flat $200 monthly credit in March 2025 with a per-SKU
 * monthly free allowance. That changes what a spend guard has to count: the
 * unit that decides whether an invoice exists is **events per SKU per calendar
 * month**, not calls per day. The allowances that matter here:
 *
 *   Nearby Search (Pro)        5,000 / month   then $32 per 1,000
 *   Geocoding (Essentials)    10,000 / month   then  $5 per 1,000
 *   Directions (Essentials)   10,000 / month   then  $5 per 1,000
 *   Street View metadata           unlimited   free
 *
 * Nearby Search is the one that bites. One vehicle with a cold cache created
 * 210 new places in a single day (2026-08-11), and each new place costs one
 * Nearby call. Nine vehicles doing that would spend the entire monthly free
 * allowance in under three days.
 *
 * Three things were wrong with the previous version, and all three had to go
 * for the guarantee to mean anything:
 *
 *   - Counters were daily. Thirty days under a daily cap still bills.
 *   - Counters were in memory, so a restart reset them to zero. A crash loop
 *     was an unbounded spend.
 *   - A failure to count was treated as permission to proceed.
 *
 * Counters now live in Postgres and the check-and-increment is a single atomic
 * statement, so concurrent callers and multiple instances cannot race past a
 * cap. The cost is one small round trip per billable call, alongside a network
 * call to Google that costs far more.
 */
import { db } from '../db';
import { sql } from 'drizzle-orm';

export type GoogleCallKind =
  | 'geocode'
  | 'places_nearby'
  | 'streetview_meta'
  | 'streetview_image'
  | 'place_photo'
  | 'places_autocomplete'
  | 'static_map'
  | 'directions';

/** Published rates per 1,000 calls, used to report estimated spend. */
const USD_PER_1000: Record<GoogleCallKind, number> = {
  geocode: 5,
  places_nearby: 32,
  streetview_meta: 0,
  streetview_image: 7,
  places_autocomplete: 3,
  place_photo: 7,
  static_map: 2,
  directions: 5,
};

/**
 * Monthly ceilings, set below Google's free allowance rather than at it.
 *
 * The headroom is deliberate: this process is not the only thing that can
 * spend on the key, and a cap set exactly at the allowance turns any
 * discrepancy into an invoice. Stopping at 90% costs a few unresolved place
 * names; stopping at 100% is a bet.
 */
const MONTHLY_CAP: Record<GoogleCallKind, number> = {
  geocode: Number(process.env.GOOGLE_CAP_GEOCODE_MONTH || 9_000), // free 10,000
  places_nearby: Number(process.env.GOOGLE_CAP_NEARBY_MONTH || 4_500), // free 5,000
  directions: Number(process.env.GOOGLE_CAP_DIRECTIONS_MONTH || 9_000), // free 10,000
  places_autocomplete: Number(process.env.GOOGLE_CAP_AUTOCOMPLETE_MONTH || 4_500),
  static_map: Number(process.env.GOOGLE_CAP_STATIC_MAP_MONTH || 9_000),
  place_photo: Number(process.env.GOOGLE_CAP_PLACE_PHOTO_MONTH || 4_500),
  streetview_image: Number(process.env.GOOGLE_CAP_STREETVIEW_MONTH || 4_500),
  streetview_meta: Number.MAX_SAFE_INTEGER, // free and unmetered by Google
};

/**
 * Daily ceilings, so a single bad day cannot consume the month.
 *
 * Roughly a fifth of the monthly allowance: enough that a genuine cold-cache
 * day for the whole fleet still completes, little enough that a runaway loop is
 * caught within hours rather than at month end.
 */
const DAILY_CAP: Record<GoogleCallKind, number> = {
  geocode: Number(process.env.GOOGLE_CAP_GEOCODE_DAY || 1_800),
  places_nearby: Number(process.env.GOOGLE_CAP_NEARBY_DAY || 900),
  directions: Number(process.env.GOOGLE_CAP_DIRECTIONS_DAY || 1_800),
  places_autocomplete: Number(process.env.GOOGLE_CAP_AUTOCOMPLETE_DAY || 900),
  static_map: Number(process.env.GOOGLE_CAP_STATIC_MAP_DAY || 1_800),
  place_photo: Number(process.env.GOOGLE_CAP_PLACE_PHOTO_DAY || 900),
  streetview_image: Number(process.env.GOOGLE_CAP_STREETVIEW_DAY || 900),
  streetview_meta: Number.MAX_SAFE_INTEGER,
};

/** The big red button. Set it and not one billable call leaves this process. */
const DISABLED = process.env.GOOGLE_API_DISABLED === 'true';

const utcDay = (): string => new Date().toISOString().slice(0, 10); // 2026-08-28
const utcMonth = (): string => new Date().toISOString().slice(0, 7); // 2026-08

/**
 * Reserve one call against a window, atomically.
 *
 * The cap is enforced inside the statement rather than by reading and then
 * writing, so two concurrent callers at the boundary cannot both be admitted.
 * No row returned means the cap is reached.
 */
const reserve = async (
  periodKind: 'day' | 'month',
  period: string,
  kind: GoogleCallKind,
  cap: number
): Promise<boolean> => {
  const rows = await db.execute(sql`
    INSERT INTO google_api_usage (period_kind, period, call_kind, calls)
    VALUES (${periodKind}, ${period}, ${kind}, 1)
    ON CONFLICT (period_kind, period, call_kind) DO UPDATE
      SET calls = google_api_usage.calls + 1
      WHERE google_api_usage.calls < ${cap}
    RETURNING calls
  `);
  return rows.rows.length > 0;
};

const noteRefusal = async (kind: GoogleCallKind): Promise<void> => {
  try {
    await db.execute(sql`
      INSERT INTO google_api_usage (period_kind, period, call_kind, calls, refused)
      VALUES ('month', ${utcMonth()}, ${kind}, 0, 1)
      ON CONFLICT (period_kind, period, call_kind) DO UPDATE
        SET refused = google_api_usage.refused + 1
    `);
  } catch {
    // Never let bookkeeping about a refusal turn into a second failure.
  }
};

/**
 * Reserve one billable call. `false` means the caller must skip the request —
 * not retry it, and not degrade into a loop.
 *
 * Every path that cannot prove there is allowance left returns false. A
 * database that is unreachable is not permission to spend.
 */
export async function chargeGoogleCall(kind: GoogleCallKind): Promise<boolean> {
  if (DISABLED) return false;

  // Free and unmetered at Google's end, so it needs no ceiling and should not
  // pay a round trip for one.
  if (USD_PER_1000[kind] === 0) return true;

  try {
    const monthOk = await reserve('month', utcMonth(), kind, MONTHLY_CAP[kind]);
    if (!monthOk) {
      console.warn(
        `[google-usage] MONTHLY cap ${MONTHLY_CAP[kind]} reached for ${kind} — refusing. ` +
          `Free allowance protects against a bill; raise GOOGLE_CAP_* only with intent to pay.`
      );
      await noteRefusal(kind);
      return false;
    }

    // The month is already spent at this point if the day refuses. That is the
    // conservative direction to be wrong in — it under-serves rather than
    // over-spends — and a day-capped kind is in a runaway anyway.
    const dayOk = await reserve('day', utcDay(), kind, DAILY_CAP[kind]);
    if (!dayOk) {
      console.warn(`[google-usage] daily cap ${DAILY_CAP[kind]} reached for ${kind} — refusing`);
      await noteRefusal(kind);
      return false;
    }

    return true;
  } catch (err) {
    // Fail closed. The whole point of this file is that there is no path where
    // "we could not tell" results in a call to a billable API.
    console.error(`[google-usage] cannot verify budget for ${kind} — refusing:`, err);
    return false;
  }
}

export interface GoogleUsageRow {
  call_kind: GoogleCallKind;
  calls: number;
  refused: number;
  monthly_cap: number;
  free_allowance_note: string;
  estimated_usd: number;
}

/** This month's usage per SKU, with what it would cost if the caps were lifted. */
export async function googleUsageSnapshot(): Promise<{
  month: string;
  disabled: boolean;
  total_estimated_usd: number;
  kinds: GoogleUsageRow[];
}> {
  const month = utcMonth();
  const result = await db.execute(sql`
    SELECT call_kind, calls, refused
    FROM google_api_usage
    WHERE period_kind = 'month' AND period = ${month}
    ORDER BY calls DESC
  `);

  const kinds = (result.rows as unknown as Array<{
    call_kind: GoogleCallKind;
    calls: number;
    refused: number;
  }>).map((r) => ({
    call_kind: r.call_kind,
    calls: Number(r.calls),
    refused: Number(r.refused),
    monthly_cap: MONTHLY_CAP[r.call_kind] ?? 0,
    free_allowance_note:
      r.call_kind === 'places_nearby'
        ? '5,000/month free, then $32 per 1,000'
        : r.call_kind === 'geocode' || r.call_kind === 'directions'
          ? '10,000/month free, then $5 per 1,000'
          : 'see Google Maps Platform pricing',
    estimated_usd:
      Math.round(((USD_PER_1000[r.call_kind] ?? 0) * Number(r.calls)) / 10) / 100,
  }));

  return {
    month,
    disabled: DISABLED,
    total_estimated_usd:
      Math.round(kinds.reduce((s, k) => s + k.estimated_usd, 0) * 100) / 100,
    kinds,
  };
}

/** Test helper. Clears counters for the current day and month. */
export async function resetGoogleUsage(): Promise<void> {
  await db.execute(sql`
    DELETE FROM google_api_usage
    WHERE (period_kind = 'month' AND period = ${utcMonth()})
       OR (period_kind = 'day' AND period = ${utcDay()})
  `);
}

export const GOOGLE_CAPS = { monthly: MONTHLY_CAP, daily: DAILY_CAP, disabled: DISABLED };
