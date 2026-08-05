import { describe, it, expect } from '@jest/globals'
import { tripConfidence } from '../src/lib/trip-segmentation'

// Fuel here is modelled from movement, never measured from a tank, so the
// score exists to say how much weight a given trip's figure can carry.
describe('tripConfidence', () => {
  it('never reaches 100, however clean the trip', () => {
    const { score, notes } = tripConfidence({
      durationMinutes: 60,
      idleMinutes: 2,
      points: 240,
      longestGapSeconds: 30,
      distanceKm: 42,
    })

    expect(score).toBe(99)
    expect(notes).toEqual([])
  })

  it('drops hard on a trip spent crawling in gridlock', () => {
    // Three hours out, two of them stationary with the engine running.
    const { score, notes } = tripConfidence({
      durationMinutes: 180,
      idleMinutes: 120,
      points: 700,
      longestGapSeconds: 60,
      distanceKm: 14,
    })

    expect(score).toBeLessThan(85)
    expect(notes[0]).toContain('stationary with the engine')
    expect(notes[0]).toContain('67%')
  })

  it('explains a tracker that went quiet', () => {
    const { score, notes } = tripConfidence({
      durationMinutes: 60,
      idleMinutes: 3,
      points: 200,
      longestGapSeconds: 20 * 60,
      distanceKm: 30,
    })

    expect(score).toBeLessThan(95)
    expect(notes.join(' ')).toContain('went quiet for 20 minutes')
  })

  it('flags a route drawn from too few fixes', () => {
    const { score, notes } = tripConfidence({
      durationMinutes: 90,
      idleMinutes: 0,
      points: 12,
      longestGapSeconds: 120,
      distanceKm: 55,
    })

    expect(score).toBeLessThan(95)
    expect(notes.join(' ')).toContain('Few position fixes')
  })

  it('never falls below the floor, even when everything is wrong at once', () => {
    const { score } = tripConfidence({
      durationMinutes: 240,
      idleMinutes: 235,
      points: 4,
      longestGapSeconds: 200 * 60,
      distanceKm: 1,
    })

    expect(score).toBe(35)
  })

  it('tolerates a short trip without dividing by zero', () => {
    const { score } = tripConfidence({
      durationMinutes: 0,
      idleMinutes: 0,
      points: 2,
      longestGapSeconds: 0,
      distanceKm: 0.4,
    })

    expect(Number.isFinite(score)).toBe(true)
    expect(score).toBeGreaterThanOrEqual(35)
  })
})
