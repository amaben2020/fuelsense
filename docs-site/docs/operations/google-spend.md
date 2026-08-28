---
id: google-spend
title: Google Maps spend
sidebar_position: 5
---

# Google Maps spend

The goal for this subsystem is not "spend a sensible amount". It is **never
receive an invoice**. Everything below follows from that.

## What changed in March 2025

Google withdrew the flat $200 monthly credit and replaced it with a **per-SKU
monthly free allowance**. The unit that decides whether an invoice exists is
therefore events per SKU per calendar month — not calls per day, and not
dollars.

The allowances that matter here:

| SKU | Tier | Free per month | Then |
| --- | --- | --- | --- |
| Places Nearby Search | Pro | 5,000 | $32 / 1,000 |
| Geocoding | Essentials | 10,000 | $5 / 1,000 |
| Directions | Essentials | 10,000 | $5 / 1,000 |
| Street View metadata | Essentials | unlimited | free |

**Nearby Search is the one that bites.** It costs six times a geocode and has
half the allowance.

## Why this is sized the way it is

One vehicle with a cold cache created **210 new places in a single day**
(2026-08-11). Every new place costs one Nearby call. Nine vehicles doing the
same is roughly 1,890 calls in a day, which would spend the entire monthly free
allowance in under three days — and the rest of the month bills at $32 per
1,000.

So the caps are monthly, set below the free allowance, with a daily ceiling
underneath so a single runaway day cannot consume the month.

| SKU | Monthly cap | Daily cap | Free allowance |
| --- | --- | --- | --- |
| `places_nearby` | 4,500 | 900 | 5,000 |
| `geocode` | 9,000 | 1,800 | 10,000 |
| `directions` | 9,000 | 1,800 | 10,000 |

The headroom is deliberate. This process is not necessarily the only thing
spending on the key, and our count need not agree with Google's to the single
call. Stopping at 90% costs a few unresolved place names; stopping at exactly
100% is a bet.

Every cap is overridable — `GOOGLE_CAP_NEARBY_MONTH`, `GOOGLE_CAP_GEOCODE_DAY`
and so on. `tests/google-usage.test.ts` fails if any monthly cap is raised above
95% of the free allowance, so crossing into billable territory has to break a
test rather than pass review unnoticed.

## Three properties that make it a ceiling rather than a hope

**Counters live in Postgres, not memory.** The previous version kept them in a
module variable and reset to zero on restart, which made a crash loop an
unbounded spend. `google_api_usage` survives restarts and is shared across
instances.

**Check-and-increment is one atomic statement.** The cap is enforced inside the
`INSERT … ON CONFLICT DO UPDATE … WHERE calls < cap`, so two callers arriving at
the boundary together cannot both be admitted. Verified: 200 concurrent
attempts against a cap of 20 admitted exactly 20.

**It fails closed.** Any error — an unreachable database, a malformed row —
returns `false` and the call is skipped. A guard that cannot verify budget must
never be read as permission to spend.

There is also `GOOGLE_API_DISABLED=true`, which refuses every billable call
outright. The big red button.

## The part this cannot do

**An application-side guard is not a guarantee.** It only counts calls that go
through `chargeGoogleCall`. A new code path that calls Google directly, or a
second service sharing the key, is invisible to it.

The only true ceiling is on Google's side:

1. **Google Cloud Console → APIs & Services → Quotas.** Set a per-day request
   quota on each enabled Maps API. This is a hard stop enforced by Google.
2. **Restrict the API key** to the specific APIs in use, so an enabled-by-
   default SKU cannot be called at all.

Do **not** rely on Cloud Billing budgets for this. A budget sends an alert; it
does not stop the spend. That distinction is where surprise Maps bills come
from.

## Watching it

```
GET /api/telemetry/google-usage
```

Returns this month's calls per SKU, refusals, the cap, and estimated spend if
the caps were lifted. A non-zero `refused` count means features are silently
degrading — stops resolving to coordinates instead of names — and is the signal
to either raise a cap deliberately or reduce demand.

## Reducing demand rather than raising caps

The caps are the backstop. The real control is not making the call:

- **`place_cache`** resolves a coordinate once. `GEO_PRECISION` gives ~11 m
  cells — tight enough that GPS wander at one building does not spread across
  cells, coarse enough to collapse repeat visits.
- **Negative caching** stops a coordinate with no nearby place being re-queried.
- Routes repeat. A pilot's first week is the expensive one; a fleet driving the
  same corridors resolves almost everything from cache after that.

If a pilot needs more than the free allowance, the honest answer is to decide
what a place name is worth and raise `GOOGLE_CAP_NEARBY_MONTH` on purpose —
not to discover it on an invoice.

## Related

- [Metrics and logs](/operations/observability) — where refusals show up
- [Troubleshooting](/operations/troubleshooting) — "a stop shows coordinates
  instead of a name" is usually a cap, not a bug
