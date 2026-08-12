import { describe, it, expect } from '@jest/globals';
import { modelHopBurnMl } from '../src/lib/virtual-tank';

/** 15 mpg US = 6.38 km/L = 15.68 L/100 km. */
const RATE = { consumptionL100km: 15.68, idleBurnLph: 1.2 };

describe('modelHopBurnMl', () => {
  it('charges distance at the vehicle consumption rate', () => {
    // 40 km in an hour averages 40 km/h, which sits in the baseline band, so
    // the multiplier is 1 and this is the bare rate: 40 km at 15.68 L/100km.
    const ml = modelHopBurnMl({
      distanceKm: 40,
      seconds: 3600,
      ignitionOn: true,
      speedKph: 40,
      ...RATE,
    });
    expect(ml).toBe(6272);
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
    // idle rate as well would double-count the same fuel. An hour to cover 1 km
    // averages 1 km/h, which is stop-start, so the distance is charged at ×1.3
    // rather than at the bare rate. 1 km × 15.68 × 1.3 / 100 = 0.204 L.
    const moving = modelHopBurnMl({
      distanceKm: 1,
      seconds: 3600,
      ignitionOn: true,
      speedKph: 30,
      ...RATE,
    });
    expect(moving).toBe(204);

    // An hour of idling at 1.2 L/h would be 1.2 L, and the capped ten minutes
    // still 0.2 L — either would dwarf the distance charge if both applied.
    expect(moving).toBeLessThan(1200);
  });

  describe('speed banding', () => {
    // Real economy follows a U-curve: worst crawling, worst again at speed,
    // best on a mid-range cruise. A flat rate charged the same for all three.
    const hop = (distanceKm: number, seconds: number) =>
      modelHopBurnMl({ distanceKm, seconds, ignitionOn: true, speedKph: null, ...RATE });

    it('charges stop-start traffic more per km than a steady cruise', () => {
      const crawl = hop(5, (5 / 10) * 3600); // 10 km/h
      const cruise = hop(5, (5 / 40) * 3600); // 40 km/h
      expect(crawl).toBeGreaterThan(cruise);
      expect(crawl / cruise).toBeCloseTo(1.3, 2);
    });

    it('charges motorway speed more per km than a mid-range cruise', () => {
      const cruise = hop(50, (50 / 40) * 3600); // 40 km/h
      const highway = hop(50, (50 / 80) * 3600); // 80 km/h
      const fast = hop(50, (50 / 120) * 3600); // 120 km/h
      expect(highway).toBeGreaterThan(cruise);
      expect(fast).toBeGreaterThan(highway);
    });

    it('uses the hop average, not the closing instantaneous speed', () => {
      // A minute of crawling that happened to end mid-acceleration. Reading the
      // snapshot would file the whole hop under highway and undercharge it.
      const ml = modelHopBurnMl({
        distanceKm: 0.2,
        seconds: 60, // 12 km/h average
        ignitionOn: true,
        speedKph: 90, // instantaneous at the closing fix
        ...RATE,
      });
      // 0.2 km × 15.68 × 1.3 / 100 = 0.0408 L
      expect(ml).toBe(41);
    });

    it('applies no adjustment when the speed cannot be established', () => {
      // Distance with no elapsed time and no reported speed earns the bare
      // rate rather than a guessed band.
      const ml = modelHopBurnMl({
        distanceKm: 10,
        seconds: 0,
        ignitionOn: true,
        speedKph: null,
        ...RATE,
      });
      expect(ml).toBe(1568);
    });
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
