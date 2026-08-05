import { describe, it, expect } from '@jest/globals'
import {
  deriveBurnFactor,
  refuelDiscrepancyLiters,
  RECEIPT_BURN_FACTOR_SOURCE,
} from '../src/lib/virtual-tank'

// The virtual tank is the source of truth for how much fuel a vehicle holds,
// so a fill is where that truth gets audited: nobody can put more into a tank
// than its empty space. Litres beyond the modelled headroom are litres the
// model wrongly believed were still aboard.
describe('refuelDiscrepancyLiters', () => {
  it('flags a fill the modelled tank could not have accepted', () => {
    // Model says 30 L in a 60 L tank, so 30 L of room. The driver puts in 45.
    expect(refuelDiscrepancyLiters(60, 30, 45)).toBe(15)
  })

  it('stays silent on an ordinary top-up', () => {
    expect(refuelDiscrepancyLiters(60, 30, 25)).toBe(0)
    expect(refuelDiscrepancyLiters(60, 10, 50)).toBe(0)
  })

  it('allows for splashing and pump rounding rather than crying wolf', () => {
    // 1.5 L over the headroom on a 60 L tank is noise, not a finding.
    expect(refuelDiscrepancyLiters(60, 30, 31.5)).toBe(0)
  })

  it('scales its tolerance with tank size', () => {
    // 5 L over on a 200 L truck tank is within 8%; the same 5 L on a small
    // tank is not.
    expect(refuelDiscrepancyLiters(200, 100, 105)).toBe(0)
    expect(refuelDiscrepancyLiters(40, 20, 25)).toBeCloseTo(5, 2)
  })

  it('reports the gap on a vehicle that ran emptier than the dashboard showed', () => {
    // The driver says they ran dry while the model still showed 15 L.
    expect(refuelDiscrepancyLiters(60, 15, 58)).toBeCloseTo(13, 2)
  })
})

describe('deriveBurnFactor priority', () => {
  it('lets a receipt-measured factor stand over the device cross-check', () => {
    const result = deriveBurnFactor(2.221, 0.927, 40, RECEIPT_BURN_FACTOR_SOURCE, 1.8)

    expect(result.factor).toBe(1.8)
    expect(result.source).toBe(RECEIPT_BURN_FACTOR_SOURCE)
  })

  it('still cross-checks the device when receipts have not calibrated it yet', () => {
    const result = deriveBurnFactor(2.221, 0.927, 40, null, 1)

    expect(result.factor).toBeCloseTo(2.396, 2)
    expect(result.source).toBe('device_rate_cross_check')
  })

  it('ignores a receipt source with no factor behind it', () => {
    const result = deriveBurnFactor(2.221, 0.927, 40, RECEIPT_BURN_FACTOR_SOURCE, 0)

    expect(result.source).toBe('device_rate_cross_check')
  })
})
