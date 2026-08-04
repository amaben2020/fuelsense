import { describe, it, expect } from '@jest/globals'
import { deriveBurnFactor } from '../src/lib/virtual-tank'

// The FMC150 ships two fuel elements that can disagree. On the live RAV4 the
// accumulator (AVL 12) implied 0.93 l/h idling while the rate element (AVL 13)
// reported 2.22 l/h — uncorrected, every litre and every naira read ~2.4x low.
describe('deriveBurnFactor', () => {
  it('corrects an accumulator that under-reports against the device rate', () => {
    const { factor, source } = deriveBurnFactor(2.221, 0.927, 26)

    expect(factor).toBeCloseTo(2.396, 2)
    expect(source).toBe('device_rate_cross_check')
  })

  it('leaves the device alone when the two elements agree', () => {
    expect(deriveBurnFactor(2.0, 1.95, 40)).toEqual({ factor: 1, source: null })
    expect(deriveBurnFactor(1.0, 1.1, 40)).toEqual({ factor: 1, source: null })
  })

  it('waits for enough samples before trusting the ratio', () => {
    // One unlucky ping must not rescale the whole tank.
    expect(deriveBurnFactor(2.221, 0.927, 3)).toEqual({ factor: 1, source: null })
  })

  it('does nothing until both rates are known', () => {
    expect(deriveBurnFactor(null, 0.927, 40)).toEqual({ factor: 1, source: null })
    expect(deriveBurnFactor(2.221, null, 40)).toEqual({ factor: 1, source: null })
    expect(deriveBurnFactor(2.221, 0, 40)).toEqual({ factor: 1, source: null })
  })

  it('clamps a wild ratio rather than emptying the tank on one bad reading', () => {
    expect(deriveBurnFactor(8, 0.1, 40).factor).toBe(4)
    expect(deriveBurnFactor(0.2, 8, 40).factor).toBe(0.5)
  })

  it('can also correct an accumulator that over-reports', () => {
    const { factor, source } = deriveBurnFactor(1.0, 2.0, 40)

    expect(factor).toBeCloseTo(0.5, 2)
    expect(source).toBe('device_rate_cross_check')
  })
})
