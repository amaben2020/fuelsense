import { describe, it, expect } from '@jest/globals'
import {
  VEHICLE_EFFICIENCY,
  baselineEfficiencyKmL,
  efficiencyProfileForModel,
} from '../src/lib/fuel-metrics'

// The benchmarks describe Nigerian city driving — gridlock, potholes, AC on —
// not manufacturer combined-cycle figures. A brochure number makes every driver
// look wasteful and buries real theft in the noise.
describe('vehicle efficiency benchmarks', () => {
  it('costs a RAV4 at a realistic city rate, not the brochure figure', () => {
    const rav4 = efficiencyProfileForModel('RAV4')

    expect(rav4.min).toBe(6)
    expect(rav4.max).toBe(8)
    // At ₦1,330/L this is ₦166–₦222 per km, matching observed running costs.
    expect(1330 / rav4.avg).toBeGreaterThan(180)
    expect(1330 / rav4.avg).toBeLessThan(200)
  })

  it('rates the smaller Corolla engine better than the RAV4', () => {
    expect(baselineEfficiencyKmL('Corolla')).toBeGreaterThan(baselineEfficiencyKmL('RAV4'))
  })

  it('rates a loaded van worst of the fleet', () => {
    const hiace = baselineEfficiencyKmL('Hiace')

    for (const model of ['Corolla', 'Camry', 'RAV4', 'Hilux']) {
      expect(baselineEfficiencyKmL(model)).toBeGreaterThan(hiace)
    }
  })

  it('keeps every benchmark inside the range real city driving produces', () => {
    for (const [model, profile] of Object.entries(VEHICLE_EFFICIENCY)) {
      expect(profile.min).toBeLessThan(profile.avg)
      expect(profile.avg).toBeLessThan(profile.max)
      // Above ~11 km/L in Lagos or Abuja traffic is not credible for these cars.
      expect(profile.max).toBeLessThanOrEqual(11)
      expect(profile.min).toBeGreaterThanOrEqual(5)
      expect(model).toBeTruthy()
    }
  })

  it('falls back to a conservative profile for an unknown model', () => {
    const unknown = efficiencyProfileForModel('Some Unlisted Van')

    expect(unknown.avg).toBeGreaterThanOrEqual(6)
    expect(unknown.avg).toBeLessThanOrEqual(8.5)
  })
})
