import { describe, it, expect } from '@jest/globals'
import {
  decideVerification,
  distanceMeters,
  type Evidence,
  type VerifyReceiptParams,
} from '../src/lib/receipt-verification'

// The real AA Rano receipt and the fix the tracker reported around it.
const RECEIPT_LAT = 8.99470805
const RECEIPT_LNG = 7.61677841
const FIX_LAT = 8.9946116
const FIX_LNG = 7.6168483

const purchase = new Date('2026-08-06T09:15:00Z')

const params = (overrides: Partial<VerifyReceiptParams> = {}): VerifyReceiptParams => ({
  vehicleId: 'v1',
  customerId: 'c1',
  transactionDate: purchase,
  declaredLiters: 11.06,
  pricePerLiter: 1300,
  receiptLatitude: RECEIPT_LAT,
  receiptLongitude: RECEIPT_LNG,
  tankCapacityLiters: 60,
  ...overrides,
})

const evidence = (overrides: Partial<Evidence> = {}): Evidence => ({
  fix: { at: new Date('2026-08-06T10:08:43Z'), latitude: FIX_LAT, longitude: FIX_LNG },
  fuelStop: null,
  levelBefore: 10.83,
  litersBurnedSincePrevious: null,
  litersBoughtSincePrevious: null,
  previousReceiptAt: null,
  ...overrides,
})

const check = (result: ReturnType<typeof decideVerification>, code: string) =>
  result.checks.find((c) => c.code === code)!

describe('distanceMeters', () => {
  it('measures the receipt-to-fix gap in metres', () => {
    expect(distanceMeters(FIX_LAT, FIX_LNG, RECEIPT_LAT, RECEIPT_LNG)).toBeLessThan(30)
  })

  it('measures a long separation', () => {
    // Abuja to Lagos, roughly.
    expect(distanceMeters(9.06, 7.49, 6.52, 3.37)).toBeGreaterThan(500_000)
  })
})

describe('decideVerification', () => {
  it('verifies a receipt when the vehicle was there and the volume fits', () => {
    const result = decideVerification(params(), evidence())

    expect(result.status).toBe('matched')
    expect(check(result, 'vehicle_present').outcome).toBe('pass')
    expect(check(result, 'volume_fits_tank').outcome).toBe('pass')
    expect(result.estimatedLossNgn).toBe(0)
  })

  it('flags a receipt issued while the vehicle was somewhere else', () => {
    const result = decideVerification(
      params(),
      evidence({ fix: { at: purchase, latitude: 9.06, longitude: 7.49 } })
    )

    expect(result.status).toBe('flagged_theft')
    expect(check(result, 'vehicle_present').outcome).toBe('fail')
    // The whole fill is at risk when the vehicle was never at that station.
    expect(result.estimatedLossNgn).toBe(Math.round(11.06 * 1300))
  })

  it('flags a volume the tank could not have taken', () => {
    const result = decideVerification(
      params({ declaredLiters: 55 }),
      evidence({ levelBefore: 40 })
    )

    expect(result.status).toBe('flagged_theft')
    expect(check(result, 'volume_fits_tank').outcome).toBe('fail')
    expect(result.overclaimedLiters).toBe(35)
    expect(result.estimatedLossNgn).toBe(Math.round(35 * 1300))
  })

  it('allows a fill slightly over the modelled headroom', () => {
    // Modelled level carries error; a 10% overshoot is not fraud.
    const result = decideVerification(params({ declaredLiters: 52 }), evidence({ levelBefore: 10 }))

    expect(check(result, 'volume_fits_tank').outcome).toBe('pass')
    expect(result.status).toBe('matched')
  })

  it('stays pending when there is no position to compare', () => {
    const result = decideVerification(params(), evidence({ fix: null }))

    expect(result.status).toBe('pending')
    expect(check(result, 'vehicle_present').outcome).toBe('unknown')
  })

  it('accepts a forecourt stop as proof of presence when GPS is missing', () => {
    const result = decideVerification(
      params({ receiptLatitude: null, receiptLongitude: null }),
      evidence({ fix: null, fuelStop: { at: purchase, minutes: 6 } })
    )

    expect(result.status).toBe('matched')
    expect(check(result, 'vehicle_present').outcome).toBe('pass')
    expect(check(result, 'vehicle_present').detail).toContain('filling station')
  })

  it('does not let a forecourt stop excuse a receipt from another town', () => {
    const result = decideVerification(
      params(),
      evidence({
        fix: { at: purchase, latitude: 9.06, longitude: 7.49 },
        fuelStop: { at: purchase, minutes: 6 },
      })
    )

    expect(result.status).toBe('flagged_theft')
  })

  it('reports buying against burning without flagging on it', () => {
    const result = decideVerification(
      params(),
      evidence({
        litersBurnedSincePrevious: 2.3,
        litersBoughtSincePrevious: 11.06,
        previousReceiptAt: new Date('2026-08-01T09:00:00Z'),
      })
    )

    const burn = check(result, 'bought_vs_burned')
    expect(burn.outcome).not.toBe('fail')
    expect(burn.detail).toContain('11.1L bought')
    expect(result.status).toBe('matched')
  })
})
