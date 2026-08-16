import { describe, it, expect } from '@jest/globals'
import { findClosestIndex, SerializedReading } from '../src/lib/event-replay'

const reading = (recordedAt: string, fix: boolean): SerializedReading => ({
  recorded_at: recordedAt,
  fuel_level_liters: null,
  speed_kph: 0,
  ignition_on: true,
  latitude: fix ? 9.05 : null,
  longitude: fix ? 7.49 : null,
  odometer_km: null,
})

describe('findClosestIndex', () => {
  it('picks the reading nearest in time when every reading has a fix', () => {
    const readings = [
      reading('2026-08-15T17:00:00Z', true),
      reading('2026-08-15T17:00:10Z', true),
      reading('2026-08-15T17:00:20Z', true),
    ]
    expect(findClosestIndex(readings, '2026-08-15T17:00:09Z')).toBe(1)
  })

  // This is the harsh-cornering bug: the closest-in-time reading has no GPS
  // fix, so painting the manoeuvre there would drop it from the map track
  // entirely (see EventReplayPanel.tsx's indexInPath remap).
  it('skips a fix-less reading even when it is the closest in time', () => {
    const readings = [
      reading('2026-08-15T17:00:00Z', true),
      reading('2026-08-15T17:00:10Z', false),
      reading('2026-08-15T17:00:20Z', true),
    ]
    expect(findClosestIndex(readings, '2026-08-15T17:00:09Z')).toBe(0)
  })

  it('falls back to closest-in-time when no reading in the window has a fix', () => {
    const readings = [reading('2026-08-15T17:00:00Z', false), reading('2026-08-15T17:00:10Z', false)]
    expect(findClosestIndex(readings, '2026-08-15T17:00:09Z')).toBe(1)
  })
})
