import { describe, it, expect } from '@jest/globals'
import {
  CONSECUTIVE_LOW_FRAMES,
  EXTERNAL_POWER_MIN_MV,
  EXTERNAL_VOLTAGE_AVL_ID,
  decidePowerTransition,
} from '../src/lib/power-monitor'

// On 2026-08-26 the tracker was pulled from the OBD port and nothing reported
// it. `device_offline` could not have: it fires on two hours of silence, and a
// tracker on its internal battery is not silent — it kept sending frames the
// whole time. AVL 252, the device's own unplug scenario, has never appeared in
// this fleet's history; the scenario is not enabled. AVL 66 read 0 throughout.
//
// These are the real millivolt readings either side of that disconnect, taken
// from device_frames.
const POWERED = [12490, 12492, 12577, 12624, 12792]
const UNPLUGGED = [0, 0, 0, 0, 0]
const RESTORED = [14099, 14094]

const FRESH = { unplugged: false, lowStreak: 0 }

/** Feed a sequence through the rule, collecting every transition it reports. */
const replay = (readings: (number | null)[], from = FRESH) => {
  let state = from
  const seen: string[] = []
  for (const mv of readings) {
    const { transition, after } = decidePowerTransition(mv, state)
    state = after
    if (transition) seen.push(transition)
  }
  return { transitions: seen, state }
}

describe('tracker power loss, from external voltage', () => {
  it('reads the element the device actually sends', () => {
    // 252 is the scenario event; 66 is the level. Only one of them arrives.
    expect(EXTERNAL_VOLTAGE_AVL_ID).toBe(66)
  })

  it('reports the real disconnect and its restore, once each', () => {
    const { transitions } = replay([...POWERED, ...UNPLUGGED, ...RESTORED])
    expect(transitions).toEqual(['unplugged', 'restored'])
  })

  it('stays quiet while power is normal', () => {
    expect(replay(POWERED).transitions).toEqual([])
  })

  it('does not re-report an unplug that is already open', () => {
    // Fifty more zero-volt frames must not become fifty more alerts. The real
    // episode ran to 75 frames.
    const { transitions } = replay([...UNPLUGGED, ...Array(50).fill(0)])
    expect(transitions).toEqual(['unplugged'])
  })

  it('needs more than one low frame, so a single bad read is not a tamper alert', () => {
    const { transitions } = replay([12000, 0, 12000, 12100])
    expect(transitions).toEqual([])
    expect(CONSECUTIVE_LOW_FRAMES).toBeGreaterThan(1)
  })

  it('ignores frames with no AVL 66 rather than inferring a disconnect', () => {
    // A device with the element disabled sends nothing here. Absence of a
    // reading is not a reading of zero.
    const { transitions, state } = replay([null, null, null])
    expect(transitions).toEqual([])
    expect(state.unplugged).toBe(false)
  })

  it('does not cry tamper at a weak battery', () => {
    // A flat-but-connected battery sits near 9–11V. Only a genuine loss of
    // supply drops to single digits of a volt.
    const { transitions } = replay([12000, 9500, 9200, 10100, 11000])
    expect(transitions).toEqual([])
    expect(EXTERNAL_POWER_MIN_MV).toBeLessThan(9000)
  })

  it('picks up an episode already in progress after a restart', () => {
    // State is seeded from the open alert, so a process restart mid-disconnect
    // must not re-raise — but must still report the restore.
    const seeded = { unplugged: true, lowStreak: CONSECUTIVE_LOW_FRAMES }
    const { transitions } = replay([0, 0, 14099], seeded)
    expect(transitions).toEqual(['restored'])
  })

  it('reports a second disconnect after power was restored', () => {
    const { transitions } = replay([
      ...POWERED,
      ...UNPLUGGED,
      ...RESTORED,
      ...UNPLUGGED,
      ...RESTORED,
    ])
    expect(transitions).toEqual(['unplugged', 'restored', 'unplugged', 'restored'])
  })
})
