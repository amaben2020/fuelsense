import { describe, it, expect } from '@jest/globals';
import { detectOverspeed, DrivingSample } from '../src/lib/harsh-driving';

/** A run of fixes one second apart at the given speeds. */
function samples(speeds: number[], startMs = Date.parse('2026-08-12T09:00:00Z')): DrivingSample[] {
  return speeds.map((speedKph, i) => ({
    at: new Date(startMs + i * 1000),
    speedKph,
    headingDeg: 90,
    lat: 9.05 + i * 0.0001,
    lng: 7.49,
  }));
}

const LIMIT = 100;

describe('detectOverspeed', () => {
  it('reports nothing when the fleet has declared no limit', () => {
    expect(detectOverspeed(samples(Array(30).fill(140)), null)).toEqual([]);
    expect(detectOverspeed(samples(Array(30).fill(140)), 0)).toEqual([]);
    expect(detectOverspeed(samples(Array(30).fill(140)), undefined)).toEqual([]);
  });

  it('ignores speeds inside the noise margin above the limit', () => {
    // 103 km/h against a 100 limit is within GNSS error, and flagging it would
    // bury real speeding under rounding artefacts.
    expect(detectOverspeed(samples(Array(60).fill(103)), LIMIT)).toEqual([]);
  });

  it('ignores a brief spike that does not persist', () => {
    // Three seconds over is below the dwell time — one bad fix, not a stretch.
    const speeds = [...Array(10).fill(90), 130, 130, 130, ...Array(10).fill(90)];
    expect(detectOverspeed(samples(speeds), LIMIT)).toEqual([]);
  });

  it('reports a sustained stretch with its peak', () => {
    const speeds = [...Array(5).fill(80), ...Array(20).fill(118), 131, ...Array(5).fill(80)];
    const [stretch, ...rest] = detectOverspeed(samples(speeds), LIMIT);

    expect(rest).toHaveLength(0);
    expect(stretch.peakKph).toBe(131);
    expect(stretch.limitKph).toBe(LIMIT);
    expect(stretch.seconds).toBeGreaterThanOrEqual(10);
    // 131 is over 120% of the limit.
    expect(stretch.severity).toBe('critical');
  });

  it('grades a moderate exceedance as a warning, not critical', () => {
    const [stretch] = detectOverspeed(samples(Array(30).fill(112)), LIMIT);
    expect(stretch.severity).toBe('warning');
    expect(stretch.peakKph).toBe(112);
  });

  it('separates two stretches split by a return to legal speed', () => {
    const speeds = [
      ...Array(15).fill(120),
      ...Array(10).fill(70),
      ...Array(15).fill(125),
    ];
    const found = detectOverspeed(samples(speeds), LIMIT);
    expect(found).toHaveLength(2);
    expect(found[0].peakKph).toBe(120);
    expect(found[1].peakKph).toBe(125);
  });

  it('does not span a reporting gap', () => {
    // Ten seconds over, then the device goes quiet for an hour, then more
    // speeding. Reporting one long stretch would claim the vehicle sped
    // through an hour nobody observed.
    const before = samples(Array(15).fill(130));
    const afterStart = before[before.length - 1].at.getTime() + 3_600_000;
    const after = samples(Array(15).fill(130), afterStart);

    const found = detectOverspeed([...before, ...after], LIMIT);
    expect(found).toHaveLength(2);
    expect(found[1].startedAt.getTime()).toBe(afterStart);
  });

  it('closes an open stretch that runs to the end of the samples', () => {
    const [stretch] = detectOverspeed(samples(Array(20).fill(140)), LIMIT);
    expect(stretch).toBeDefined();
    expect(stretch.seconds).toBe(19);
  });
});
