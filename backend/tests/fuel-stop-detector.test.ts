import { describe, it, expect } from '@jest/globals'
import {
  stepStop,
  isFuelStopCandidate,
  type StopReading,
  type StopState,
} from '../src/lib/fuel-stop-detector'

const at = (iso: string): Date => new Date(`2026-08-06T${iso}Z`)

const parked = (iso: string, lat = '8.9946', lng = '7.6168'): StopReading => ({
  ignitionOn: false,
  speedKph: 0,
  latitude: lat,
  longitude: lng,
  recordedAt: at(iso),
})

const driving = (iso: string, speedKph = 40): StopReading => ({
  ignitionOn: true,
  speedKph,
  latitude: '8.9950',
  longitude: '7.6180',
  recordedAt: at(iso),
})

/** Runs a sequence and returns the completed stops. */
const play = (readings: StopReading[]) => {
  let state: StopState | null = null
  const stops = []
  for (const reading of readings) {
    const result = stepStop(state, reading)
    state = result.state
    if (result.completed) stops.push(result.completed)
  }
  return stops
}

describe('stepStop', () => {
  it('measures a stop from timestamps, not frame count', () => {
    // Two frames an hour apart is still an hour of standing still.
    const [stop] = play([parked('09:10:00'), parked('10:10:00'), driving('10:12:00')])

    expect(stop.minutes).toBe(62)
  })

  it('keeps the position where the vehicle came to rest', () => {
    const [stop] = play([
      parked('09:10:00', '8.9946', '7.6168'),
      parked('09:14:00', '8.9999', '7.6199'),
      driving('09:16:00'),
    ])

    expect(stop.latitude).toBe('8.9946')
    expect(stop.longitude).toBe('7.6168')
  })

  it('treats crawling in traffic with the engine on as stopped', () => {
    const [stop] = play([
      { ...driving('09:10:00', 1), ignitionOn: true },
      driving('09:16:00'),
    ])

    expect(stop.minutes).toBe(6)
  })

  it('emits nothing while the vehicle is still stopped', () => {
    expect(play([parked('09:10:00'), parked('09:20:00')])).toHaveLength(0)
  })
})

describe('isFuelStopCandidate', () => {
  const stop = (minutes: number, latitude: string | null = '8.9946') => ({
    startedAt: at('09:10:00'),
    endedAt: at('09:20:00'),
    minutes,
    latitude,
    longitude: latitude ? '7.6168' : null,
  })

  it('accepts a stop long enough to fill a tank', () => {
    expect(isFuelStopCandidate(stop(6))).toBe(true)
  })

  it('rejects a pause at a junction', () => {
    expect(isFuelStopCandidate(stop(1.5))).toBe(false)
  })

  it('rejects an overnight park', () => {
    expect(isFuelStopCandidate(stop(600))).toBe(false)
  })

  it('rejects a stop with no position to look up', () => {
    expect(isFuelStopCandidate(stop(6, null))).toBe(false)
  })
})
