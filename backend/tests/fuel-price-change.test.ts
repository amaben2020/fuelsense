import { describe, it, expect } from '@jest/globals'
import { benchmarkChangeFraction, isNotableBenchmarkChange } from '../src/lib/fuel-price'

const previous = (ngnPerLiter: number) => ({
  id: 1,
  ngnPerLiter,
  effectiveFrom: new Date(),
  source: 'manager',
  note: null,
})

describe('benchmarkChangeFraction', () => {
  it('is null when there is no prior price', () => {
    expect(benchmarkChangeFraction(1500, null)).toBeNull()
  })

  it('is positive for a price increase', () => {
    expect(benchmarkChangeFraction(1500, previous(1000))).toBeCloseTo(0.5)
  })

  it('is negative for a price decrease', () => {
    expect(benchmarkChangeFraction(750, previous(1000))).toBeCloseTo(-0.25)
  })
})

describe('isNotableBenchmarkChange', () => {
  it('flags a change that could plausibly be a fat-fingered digit', () => {
    // ₦1,000 -> ₦1,300 is the kind of jump a stray digit produces.
    expect(isNotableBenchmarkChange(benchmarkChangeFraction(1300, previous(1000)))).toBe(true)
  })

  it('leaves an everyday price bump unflagged', () => {
    expect(isNotableBenchmarkChange(benchmarkChangeFraction(1050, previous(1000)))).toBe(false)
  })

  it('is false when there was no prior price to compare against', () => {
    expect(isNotableBenchmarkChange(null)).toBe(false)
  })
})
