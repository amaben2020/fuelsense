import { describe, it, expect } from '@jest/globals'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  DEFAULT_OFFLINE_MINUTES,
  OFFLINE_THRESHOLD_CHOICES,
  REALERT_AFTER_HOURS,
  alreadyAlertedGuard,
} from '../src/lib/device-offline-watchdog'

// A parked FMC150 checks in once an hour. Against a 30-minute threshold the
// alert was raised at :59, auto-resolved at :29 when the ping landed, and
// raised again an hour later — 112 alerts for a van that was sitting still and
// reporting perfectly well. Two things caused it, and both are asserted here.
const rendered = new PgDialect().sqlToQuery(alreadyAlertedGuard)

describe('device offline re-alerting', () => {
  it('does not free the slot the moment an alert resolves', () => {
    // The original guard was `is_resolved = false` alone. Keeping only that
    // clause is what let the next quiet spell raise a fresh alert immediately.
    expect(rendered.sql).toContain('is_resolved = false')
    expect(rendered.sql).toMatch(/OR\s+a\.created_at\s*>\s*NOW\(\)/)
  })

  it('spaces repeat alerts by the configured window', () => {
    expect(rendered.params).toContain(REALERT_AFTER_HOURS)
    expect(rendered.sql).toContain("' hours')::INTERVAL")
  })

  it('says it at most once a day by default', () => {
    expect(REALERT_AFTER_HOURS).toBe(24)
  })

  it('waits longer than the device takes to check in when parked', () => {
    // Measured on the live tracker: 60.0 minutes between pings while parked.
    // A threshold at or below that cannot do anything except oscillate, so
    // this is the invariant that keeps the default honest.
    const PARKED_CHECK_IN_MINUTES = 60
    expect(DEFAULT_OFFLINE_MINUTES).toBeGreaterThan(PARKED_CHECK_IN_MINUTES)
  })

  it('still offers the impatient thresholds as a deliberate choice', () => {
    // Shorter windows remain available — they are just no longer the default
    // that every fleet silently inherits.
    expect(OFFLINE_THRESHOLD_CHOICES).toContain(15)
    expect(OFFLINE_THRESHOLD_CHOICES).toContain(30)
    expect(OFFLINE_THRESHOLD_CHOICES).toContain(DEFAULT_OFFLINE_MINUTES)
  })
})
