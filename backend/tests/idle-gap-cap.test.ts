import { describe, it, expect } from '@jest/globals'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import {
  IDLE_GAP_CAP_SECONDS,
  distanceDeltasCte,
  telemetryDeltasCte,
} from '../src/lib/telemetry-deltas-sql'
import { dailyActivitySql } from '../src/lib/daily-activity-sql'

const dialect = new PgDialect()
/** Renders a fragment to the text and bound values Postgres would receive. */
const render = (fragment: SQL) => dialect.sqlToQuery(fragment)

// A tracker that stops reporting leaves a hole, and both ends of it can read
// "ignition on, not moving". Uncapped, the whole outage becomes idle time: a
// 42.6-hour silence between 18 and 20 August 2026 was shown to the driver as
// 42.7 hours idling on the 20th. Two of the three queries capped the gap; the
// one feeding the driver's history screen did not.
//
// These assert the rule is shared rather than re-typed, because re-typing it
// is how the three drifted apart in the first place.
const args = { customerId: '00000000-0000-0000-0000-000000000000', days: 14 }

const builders: Array<[string, string]> = [
  ['distanceDeltasCte', render(distanceDeltasCte(args)).sql],
  ['telemetryDeltasCte', render(telemetryDeltasCte(args)).sql],
  ['dailyActivitySql', render(dailyActivitySql(args)).sql],
]

describe('idle gap cap', () => {
  it.each(builders)('%s caps each idle hop', (_name, text) => {
    // The cap is bound as a parameter, so what appears inline is the LEAST()
    // around the elapsed-time extraction that applies it.
    expect(text).toContain('LEAST')
    expect(text).toMatch(/LEAST\(\s*EXTRACT\(EPOCH FROM \(recorded_at - prev_recorded_at\)\)/)
  })

  it.each(builders)('%s never converts a raw gap straight to idle hours', (_name, text) => {
    // The exact shape of the original bug — a CASE arm yielding the elapsed
    // seconds as hours with nothing bounding it:
    //   THEN EXTRACT(EPOCH FROM (recorded_at - prev_recorded_at)) / 3600.0
    // Deliberately anchored on THEN. The same division appears legitimately in
    // the distance speed-cap (`speed * elapsed / 3600 * 1.25`), which is not an
    // idle figure and must not trip this.
    expect(text).not.toMatch(
      /THEN\s+EXTRACT\(EPOCH FROM \(recorded_at - prev_recorded_at\)\)\s*\/\s*3600/
    )
  })

  it('binds one cap value for every query', () => {
    for (const [, text] of builders) {
      expect(text).toContain('LEAST')
    }
    expect(IDLE_GAP_CAP_SECONDS).toBe(600)
    // Every builder must carry the cap as a bound parameter — proving they
    // share the constant rather than each spelling out a literal.
    for (const build of [distanceDeltasCte, telemetryDeltasCte, dailyActivitySql]) {
      expect(render(build(args)).params).toContain(IDLE_GAP_CAP_SECONDS)
    }
  })
})
