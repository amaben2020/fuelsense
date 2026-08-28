import { describe, it, expect } from '@jest/globals'
import { GOOGLE_CAPS } from '../src/lib/google-usage'

// The brief is "never get a Google bill", so what matters is the relationship
// between the caps in this file and Google's per-SKU monthly free allowances.
// Those allowances replaced the flat $200 credit in March 2025:
//
//   Nearby Search (Pro)        5,000 / month, then $32 per 1,000
//   Geocoding (Essentials)    10,000 / month, then  $5 per 1,000
//   Directions (Essentials)   10,000 / month, then  $5 per 1,000
//
// A cap above the allowance is an invoice. A cap exactly at it is a bet that
// nothing else on the account spends and that Google's count agrees with ours
// to the call. These assertions exist so raising a cap past the free tier has
// to be a deliberate act that breaks a test, rather than a one-character edit
// nobody reviews.
const FREE_ALLOWANCE = {
  places_nearby: 5_000,
  geocode: 10_000,
  directions: 10_000,
} as const

describe('google spend ceiling', () => {
  it('keeps every metered SKU under its free allowance', () => {
    for (const [kind, free] of Object.entries(FREE_ALLOWANCE)) {
      const cap = GOOGLE_CAPS.monthly[kind as keyof typeof FREE_ALLOWANCE]
      expect(cap).toBeLessThan(free)
    }
  })

  it('leaves headroom rather than stopping exactly at the allowance', () => {
    // Something other than this process can spend on the same key, and our
    // count and Google's need not agree to the single call.
    for (const [kind, free] of Object.entries(FREE_ALLOWANCE)) {
      const cap = GOOGLE_CAPS.monthly[kind as keyof typeof FREE_ALLOWANCE]
      expect(cap).toBeLessThanOrEqual(free * 0.95)
    }
  })

  it('rations Nearby Search hardest, because it costs six times a geocode', () => {
    expect(GOOGLE_CAPS.monthly.places_nearby).toBeLessThan(GOOGLE_CAPS.monthly.geocode)
  })

  it('caps a single day well below the month', () => {
    // One runaway day must not be able to consume the monthly allowance —
    // otherwise the monthly cap only tells you afterwards.
    for (const kind of Object.keys(FREE_ALLOWANCE) as Array<keyof typeof FREE_ALLOWANCE>) {
      expect(GOOGLE_CAPS.daily[kind]).toBeLessThan(GOOGLE_CAPS.monthly[kind] / 2)
    }
  })

  it('does not meter the SKU Google gives away', () => {
    // Street View metadata is free and unlimited; a ceiling on it would only
    // break features for nothing.
    expect(GOOGLE_CAPS.monthly.streetview_meta).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('measured pilot demand exceeds the daily cap, so the cap is load-bearing', () => {
    // One vehicle with a cold cache created 210 new places in a day
    // (2026-08-11). Each new place is one Nearby call. Nine vehicles is ~1,890,
    // which must be refused rather than billed.
    const NINE_VEHICLE_COLD_DAY = 210 * 9
    expect(NINE_VEHICLE_COLD_DAY).toBeGreaterThan(GOOGLE_CAPS.daily.places_nearby)
  })
})
