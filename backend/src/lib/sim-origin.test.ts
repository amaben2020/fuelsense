import { envOrigin, isValidLatLng, resolveOrigin, toLatLng, translateLoop } from './sim-origin'

const LAGOS = { lat: 6.5244, lng: 3.3792 }
const ABUJA = { lat: 9.0765, lng: 7.3986 }

describe('isValidLatLng', () => {
  it('accepts a real coordinate', () => {
    expect(isValidLatLng(ABUJA)).toBe(true)
  })

  it('rejects Null Island (0,0) — a placeholder, not a fix', () => {
    expect(isValidLatLng({ lat: 0, lng: 0 })).toBe(false)
  })

  it('rejects out-of-range and non-finite values', () => {
    expect(isValidLatLng({ lat: 91, lng: 0 })).toBe(false)
    expect(isValidLatLng({ lat: 0, lng: 181 })).toBe(false)
    expect(isValidLatLng({ lat: NaN, lng: 3 })).toBe(false)
  })

  it('rejects non-objects', () => {
    expect(isValidLatLng(null)).toBe(false)
    expect(isValidLatLng('6.5,3.3')).toBe(false)
  })
})

describe('toLatLng', () => {
  it('coerces the numeric STRINGS pg returns for NUMERIC columns', () => {
    expect(toLatLng('6.52440000', '3.37920000')).toEqual({ lat: 6.5244, lng: 3.3792 })
  })

  it('returns null for unparseable input rather than NaN coordinates', () => {
    expect(toLatLng('not-a-number', '3.3')).toBeNull()
    expect(toLatLng(null, null)).toBeNull()
  })
})

describe('resolveOrigin precedence', () => {
  it('prefers the device last known position above everything else', () => {
    expect(
      resolveOrigin({ lastKnown: ABUJA, envOrigin: LAGOS, profileStart: LAGOS }),
    ).toEqual({ origin: ABUJA, source: 'telemetry' })
  })

  it('falls back to the env origin when the device has never reported', () => {
    expect(resolveOrigin({ lastKnown: null, envOrigin: ABUJA })).toEqual({
      origin: ABUJA,
      source: 'env',
    })
  })

  it('falls back to an explicit profile start last', () => {
    expect(resolveOrigin({ lastKnown: null, envOrigin: null, profileStart: ABUJA })).toEqual({
      origin: ABUJA,
      source: 'profile',
    })
  })

  it('INVENTS NOTHING when no candidate is valid', () => {
    expect(resolveOrigin({})).toEqual({ origin: null, source: 'none' })
  })

  it('skips an invalid last-known rather than trusting it', () => {
    expect(
      resolveOrigin({ lastKnown: { lat: 0, lng: 0 }, envOrigin: ABUJA }),
    ).toEqual({ origin: ABUJA, source: 'env' })
  })
})

describe('envOrigin', () => {
  it('reads SIM_ORIGIN_LAT/LNG', () => {
    expect(envOrigin({ SIM_ORIGIN_LAT: '9.0765', SIM_ORIGIN_LNG: '7.3986' } as NodeJS.ProcessEnv)).toEqual(
      ABUJA,
    )
  })

  it('is null when unset or garbage', () => {
    expect(envOrigin({} as NodeJS.ProcessEnv)).toBeNull()
    expect(envOrigin({ SIM_ORIGIN_LAT: 'x', SIM_ORIGIN_LNG: 'y' } as NodeJS.ProcessEnv)).toBeNull()
  })
})

describe('translateLoop', () => {
  const loop = [LAGOS, { lat: 6.5355, lng: 3.3621 }, { lat: 6.5488, lng: 3.3515 }]

  it('puts the first waypoint exactly on the origin', () => {
    const moved = translateLoop(loop, ABUJA)
    expect(moved[0].lat).toBeCloseTo(ABUJA.lat, 10)
    expect(moved[0].lng).toBeCloseTo(ABUJA.lng, 10)
  })

  it('preserves the SHAPE — every leg keeps its offset', () => {
    const moved = translateLoop(loop, ABUJA)
    for (let i = 1; i < loop.length; i += 1) {
      expect(moved[i].lat - moved[i - 1].lat).toBeCloseTo(loop[i].lat - loop[i - 1].lat, 10)
      expect(moved[i].lng - moved[i - 1].lng).toBeCloseTo(loop[i].lng - loop[i - 1].lng, 10)
    }
  })

  it('does not mutate the shared loop constant', () => {
    const snapshot = JSON.parse(JSON.stringify(loop))
    translateLoop(loop, ABUJA)
    expect(loop).toEqual(snapshot)
  })

  it('handles an empty loop', () => {
    expect(translateLoop([], ABUJA)).toEqual([])
  })
})
