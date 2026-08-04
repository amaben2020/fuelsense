import { describe, it, expect } from '@jest/globals'
import { stepIdle, type IdleReading, type IdleState, type IdleEmission } from '../src/lib/idle-detector'

const at = (iso: string): Date => new Date(`2026-08-04T${iso}Z`)

const running = (iso: string, speedKph = 0): IdleReading => ({
  ignitionOn: true,
  speedKph,
  recordedAt: at(iso),
})

const off = (iso: string): IdleReading => ({
  ignitionOn: false,
  speedKph: 0,
  recordedAt: at(iso),
})

/** Runs a sequence through the machine and returns every event it emitted. */
const play = (readings: IdleReading[]): IdleEmission[] => {
  let state: IdleState | null = null
  const emitted: IdleEmission[] = []
  for (const reading of readings) {
    const result = stepIdle(state, reading)
    state = result.state
    emitted.push(...result.emissions)
  }
  return emitted
}

describe('stepIdle', () => {
  it('reports an idle stretch that the device only bookended with two frames', () => {
    // The real failure case: engine on at 11:00, off at 11:20, and because the
    // tracker drops to its "on stop" cadence while parked, nothing in between.
    const emitted = play([running('11:00:00'), off('11:20:00')])

    expect(emitted.map((e) => e.eventType)).toEqual(['idling_start', 'idling_end'])
    expect(emitted[0].occurredAt).toEqual(at('11:00:00'))
    expect(emitted[1].occurredAt).toEqual(at('11:20:00'))
    expect(emitted[1].minutes).toBe(20)
  })

  it('backdates the start to when the engine actually settled, not to the frame that crossed the threshold', () => {
    const emitted = play([running('11:00:00'), running('11:05:00')])

    expect(emitted).toHaveLength(1)
    expect(emitted[0].eventType).toBe('idling_start')
    expect(emitted[0].occurredAt).toEqual(at('11:00:00'))
  })

  it('emits one start per stretch, not one per frame', () => {
    const emitted = play([
      running('11:00:00'),
      running('11:05:00'),
      running('11:06:00'),
      running('11:07:00'),
    ])

    expect(emitted.filter((e) => e.eventType === 'idling_start')).toHaveLength(1)
  })

  it('ignores a pause shorter than the threshold', () => {
    // Key cycled at a gate — the kind of thing that would bury real idling.
    expect(play([running('11:00:00'), off('11:01:00')])).toEqual([])
  })

  it('closes the stretch when the vehicle drives off, timed to the first moving frame', () => {
    const emitted = play([running('11:00:00'), running('11:04:00'), running('11:06:00', 34)])

    expect(emitted.map((e) => e.eventType)).toEqual(['idling_start', 'idling_end'])
    expect(emitted[1].occurredAt).toEqual(at('11:06:00'))
    expect(emitted[1].minutes).toBe(6)
  })

  it('treats GNSS noise below 2 km/h as stationary', () => {
    const emitted = play([running('11:00:00', 1), running('11:03:00', 1)])

    expect(emitted.map((e) => e.eventType)).toEqual(['idling_start'])
  })

  it('does not idle a parked vehicle with the engine off', () => {
    expect(play([off('09:12:14'), off('10:12:14'), off('11:12:14')])).toEqual([])
  })

  it('starts a fresh stretch after the engine is restarted', () => {
    const emitted = play([
      running('11:00:00'),
      off('11:04:00'),
      running('11:30:00'),
      off('11:36:00'),
    ])

    expect(emitted.map((e) => e.eventType)).toEqual([
      'idling_start',
      'idling_end',
      'idling_start',
      'idling_end',
    ])
    expect(emitted[1].minutes).toBe(4)
    expect(emitted[3].minutes).toBe(6)
  })
})
