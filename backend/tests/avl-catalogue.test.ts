import { describe, it, expect } from '@jest/globals'
import { decodeSignal } from '../src/lib/avl-catalogue'

// Values taken from a real FMC150 frame (imei 862129084847783, 2026-08-04).
describe('decodeSignal', () => {
  it('applies the implied divisor to scaled elements', () => {
    expect(decodeSignal(12, 7514).display).toBe('7.51 L')
    expect(decodeSignal(13, 227).display).toBe('2.27 L/h')
    expect(decodeSignal(16, 785775).display).toBe('785.8 km')
    expect(decodeSignal(182, 6).display).toBe('0.6')
  })

  it('names enumerated states instead of showing the code', () => {
    expect(decodeSignal(239, 0).display).toBe('Off')
    expect(decodeSignal(239, 1).display).toBe('On')
    expect(decodeSignal(240, 1).display).toBe('Moving')
    expect(decodeSignal(69, 1).display).toBe('On, no fix')
    expect(decodeSignal(200, 0).display).toBe('No sleep')
  })

  it('resolves the GSM operator code to a carrier', () => {
    expect(decodeSignal(241, 62130).display).toBe('MTN NG')
  })

  it('falls back to the raw code for an unmapped carrier rather than guessing', () => {
    expect(decodeSignal(241, 99999).display).toBe('99999')
  })

  it('surfaces unknown elements instead of dropping them', () => {
    const signal = decodeSignal(517, 42)

    expect(signal.known).toBe(false)
    expect(signal.label).toBe('AVL 517')
    expect(signal.display).toBe('42')
    expect(signal.group).toBe('other')
  })

  it('keeps the raw value alongside the scaled one', () => {
    const signal = decodeSignal(16, 785775)

    expect(signal.raw).toBe(785775)
    expect(signal.value).toBe(785.8)
    expect(signal.unit).toBe('km')
  })
})
