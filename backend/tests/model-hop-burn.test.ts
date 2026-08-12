import { describe, it, expect } from '@jest/globals';
import { modelHopBurnMl } from '../src/lib/virtual-tank';

/** 15 mpg US = 6.38 km/L = 15.68 L/100 km. */
const RATE = { consumptionL100km: 15.68, idleBurnLph: 1.2 };

describe('modelHopBurnMl', () => {
  it('charges distance at the vehicle consumption rate', () => {
    const ml = modelHopBurnMl({
      distanceKm: 10,
      seconds: 600,
      ignitionOn: true,
      speedKph: 60,
      ...RATE,
    });
    // 10 km at 15.68 L/100km = 1.568 L
    expect(ml).toBe(1568);
  });

  it('charges idle time only when the engine is on and nothing moved', () => {
    const idling = modelHopBurnMl({
      distanceKm: 0,
      seconds: 300,
      ignitionOn: true,
      speedKph: 0,
      ...RATE,
    });
    expect(idling).toBe(100); // five minutes at 1.2 l/h

    const parked = modelHopBurnMl({
      distanceKm: 0,
      seconds: 300,
      ignitionOn: false,
      speedKph: 0,
      ...RATE,
    });
    expect(parked).toBe(0);
  });

  it('does not bill a moving hop for both its distance and its seconds', () => {
    // A hop that covered ground is charged for the distance only — charging the
    // idle rate as well would double-count the same fuel.
    const moving = modelHopBurnMl({
      distanceKm: 1,
      seconds: 3600,
      ignitionOn: true,
      speedKph: 30,
      ...RATE,
    });
    expect(moving).toBe(157); // 1 km only, no idle component
  });

  it('does not bill a reporting outage as idling', () => {
    // The tracker returned on 2026-08-11 after 13.7 hours off air, and its
    // first packet carried ignition-on at a standstill. Uncapped, that single
    // hop modelled 16.4 L — a third of a tank invented from silence.
    const outage = modelHopBurnMl({
      distanceKm: 0,
      seconds: 13.7 * 3600,
      ignitionOn: true,
      speedKph: 0,
      ...RATE,
    });
    // Capped at 600 s: 10 minutes at 1.2 l/h = 0.2 L.
    expect(outage).toBe(200);
  });

  it('never returns negative burn for a backwards or empty hop', () => {
    expect(
      modelHopBurnMl({
        distanceKm: -5,
        seconds: -10,
        ignitionOn: true,
        speedKph: 0,
        ...RATE,
      })
    ).toBe(0);
  });

  it('reproduces the 2026-08-10 drive far more plausibly than AVL 12 did', () => {
    // 3.6 km driven plus 9.1 minutes idling. The device's own accumulator
    // counted 0.145 L for this; the model should land near three quarters of a
    // litre, which is what a RAV4 actually burns doing it.
    const driving = modelHopBurnMl({
      distanceKm: 3.6,
      seconds: 0,
      ignitionOn: true,
      speedKph: 20,
      ...RATE,
    });
    const idling = modelHopBurnMl({
      distanceKm: 0,
      seconds: 9.1 * 60,
      ignitionOn: true,
      speedKph: 0,
      ...RATE,
    });
    const litres = (driving + idling) / 1000;
    expect(litres).toBeGreaterThan(0.6);
    expect(litres).toBeLessThan(0.9);
  });
});
