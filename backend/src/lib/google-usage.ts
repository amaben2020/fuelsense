// Spend guard for the Google Maps Platform key.
//
// Every billable call goes through `chargeGoogleCall`, which refuses once the
// daily cap is reached. This is a backstop, not the primary control — the real
// protections are caching (a given place is resolved once) and restricting the
// public image routes to coordinates we have already paid to resolve. This
// exists so that if those are ever bypassed, the bill still stops.
//
// Counters live in memory: a restart resets them. That is an accepted trade —
// a single long-running instance makes this accurate in practice, and the
// alternative (a DB write per call) would add latency to every lookup.

export type GoogleCallKind =
  | 'geocode'
  | 'places_nearby'
  | 'streetview_meta'
  | 'streetview_image'
  | 'place_photo';

// Rough published rates per 1000 calls, used only to report estimated spend.
const USD_PER_1000: Record<GoogleCallKind, number> = {
  geocode: 5,
  places_nearby: 32,
  streetview_meta: 0,
  streetview_image: 7,
  place_photo: 7,
};

const DAILY_CALL_CAP = Number(process.env.GOOGLE_API_DAILY_CAP || 1500);
// Nearby Search is by far the most expensive call, so it gets its own ceiling.
const DAILY_NEARBY_CAP = Number(process.env.GOOGLE_NEARBY_DAILY_CAP || 300);

interface DayUsage {
  day: string;
  total: number;
  byKind: Partial<Record<GoogleCallKind, number>>;
  refused: number;
}

const utcDay = (): string => new Date().toISOString().slice(0, 10);

let usage: DayUsage = { day: utcDay(), total: 0, byKind: {}, refused: 0 };

const rollDay = (): void => {
  const today = utcDay();
  if (usage.day !== today) usage = { day: today, total: 0, byKind: {}, refused: 0 };
};

/**
 * Reserve one billable call. Returns false when a cap is hit, in which case the
 * caller must skip the request rather than degrade into a retry loop.
 */
export function chargeGoogleCall(kind: GoogleCallKind): boolean {
  rollDay();

  // Metadata is free; count it for visibility but never let it block.
  const billable = USD_PER_1000[kind] > 0;
  const used = usage.byKind[kind] ?? 0;

  if (billable && usage.total >= DAILY_CALL_CAP) {
    usage.refused += 1;
    console.warn(`[google-usage] daily cap ${DAILY_CALL_CAP} reached — refusing ${kind}`);
    return false;
  }
  if (kind === 'places_nearby' && used >= DAILY_NEARBY_CAP) {
    usage.refused += 1;
    console.warn(`[google-usage] nearby-search cap ${DAILY_NEARBY_CAP} reached — refusing`);
    return false;
  }

  usage.byKind[kind] = used + 1;
  if (billable) usage.total += 1;
  return true;
}

export function googleUsageSnapshot(): DayUsage & { estimated_usd: number; cap: number } {
  rollDay();
  const estimated_usd = (Object.entries(usage.byKind) as Array<[GoogleCallKind, number]>).reduce(
    (sum, [kind, n]) => sum + (USD_PER_1000[kind] * n) / 1000,
    0
  );
  return {
    ...usage,
    estimated_usd: Math.round(estimated_usd * 100) / 100,
    cap: DAILY_CALL_CAP,
  };
}

export function resetGoogleUsage(): void {
  usage = { day: utcDay(), total: 0, byKind: {}, refused: 0 };
}
