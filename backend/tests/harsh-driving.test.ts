import { describe, it, expect } from '@jest/globals'
import {
  detectHarshEvents,
  headingDeltaDeg,
  type DrivingSample,
} from '../src/lib/harsh-driving'

const at = (second: number): Date => new Date(`2026-08-06T12:00:${String(second).padStart(2, '0')}Z`)

const sample = (
  second: number,
  speedKph: number,
  headingDeg: number | null = 90
): DrivingSample => ({
  at: at(second),
  speedKph,
  headingDeg,
  lat: 8.9946,
  lng: 7.6168,
})

/** Steady cruise — nothing here should ever be reported. */
const cruising = (from = 0, count = 6, speed = 50): DrivingSample[] =>
  Array.from({ length: count }, (_, i) => sample(from + i, speed))

describe('headingDeltaDeg', () => {
  it('measures the short way round the compass', () => {
    expect(headingDeltaDeg(350, 10)).toBe(20)
    expect(headingDeltaDeg(10, 350)).toBe(20)
    expect(headingDeltaDeg(90, 180)).toBe(90)
  })
})

describe('detectHarshEvents', () => {
  it('finds nothing in a steady cruise', () => {
    expect(detectHarshEvents(cruising())).toHaveLength(0)
  })

  it('flags a hard stop', () => {
    // 50 -> 30 km/h in one second is -5.6 m/s².
    const events = detectHarshEvents([sample(0, 50), sample(1, 30), ...cruising(2, 3, 30)])

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('harsh_braking')
    expect(events[0].magnitudeMs2).toBeCloseTo(5.56, 1)
    expect(events[0].severity).toBe('critical')
  })

  it('flags hard acceleration', () => {
    const events = detectHarshEvents([sample(0, 20), sample(1, 32), ...cruising(2, 3, 32)])

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('harsh_acceleration')
    expect(events[0].magnitudeMs2).toBeCloseTo(3.33, 1)
  })

  it('ignores ordinary pulling away and slowing down', () => {
    // 8 km/h per second is brisk but unremarkable.
    const events = detectHarshEvents([
      sample(0, 0),
      sample(1, 8),
      sample(2, 16),
      sample(3, 24),
    ])
    expect(events).toHaveLength(0)
  })

  it('reports one event for a sustained brake, not one per sample', () => {
    const events = detectHarshEvents([
      sample(0, 60),
      sample(1, 45),
      sample(2, 30),
      sample(3, 15),
      ...cruising(4, 3, 15),
    ])

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('harsh_braking')
  })

  it('flags a corner taken hard', () => {
    // 50 km/h through 40° of heading in a second ≈ 9.7 m/s² lateral.
    const events = detectHarshEvents([sample(0, 50, 90), sample(1, 50, 130), sample(2, 50, 130)])

    const corner = events.find((e) => e.type === 'harsh_cornering')
    expect(corner).toBeDefined()
    expect(corner!.magnitudeMs2).toBeGreaterThan(3)
  })

  it('ignores heading swings while barely moving', () => {
    // A vehicle crawling out of a parking space swings its GNSS course wildly.
    const events = detectHarshEvents([sample(0, 4, 10), sample(1, 5, 200), sample(2, 4, 40)])
    expect(events.filter((e) => e.type === 'harsh_cornering')).toHaveLength(0)
  })

  it('ignores a gentle motorway curve', () => {
    const events = detectHarshEvents([
      sample(0, 90, 90),
      sample(1, 90, 93),
      sample(2, 90, 96),
    ])
    expect(events).toHaveLength(0)
  })

  it('rejects an impossible speed jump as a GPS artefact', () => {
    const events = detectHarshEvents([sample(0, 10), sample(1, 95), sample(2, 10)])
    expect(events).toHaveLength(0)
  })

  it('never spans a reporting gap', () => {
    // 60 km/h at 12:00:00, stopped at 12:00:50 — the tracker went quiet, and
    // nothing can be said about the braking in between.
    const events = detectHarshEvents([sample(0, 60), sample(50, 0)])
    expect(events).toHaveLength(0)
  })

  it('ignores sub-second duplicate frames', () => {
    const events = detectHarshEvents([
      { ...sample(0, 60), at: new Date('2026-08-06T12:00:00.000Z') },
      { ...sample(0, 20), at: new Date('2026-08-06T12:00:00.200Z') },
    ])
    expect(events).toHaveLength(0)
  })

  it('records both when a driver brakes hard through a turn', () => {
    const events = detectHarshEvents([
      sample(0, 60, 90),
      sample(1, 45, 120),
      ...cruising(2, 3, 45),
    ])

    expect(events.map((e) => e.type).sort()).toEqual(['harsh_braking', 'harsh_cornering'])
  })

  it('honours per-fleet thresholds', () => {
    const series = [sample(0, 50), sample(1, 40), ...cruising(2, 3, 40)]

    expect(detectHarshEvents(series)).toHaveLength(0)
    expect(detectHarshEvents(series, { brakingMs2: 2 })).toHaveLength(1)
  })

  it('skips cornering when the device sent no heading', () => {
    const events = detectHarshEvents([sample(0, 50, null), sample(1, 50, null)])
    expect(events).toHaveLength(0)
  })
})
