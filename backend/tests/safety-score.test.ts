import { describe, it, expect } from '@jest/globals';
import { scoreForPenalty } from '../src/routes/device-events';

describe('safety score curve', () => {
  it('is 100 when nothing was penalised', () => {
    expect(scoreForPenalty(0)).toBe(100);
    expect(scoreForPenalty(-5)).toBe(100);
  });

  it('tracks the old straight line in the healthy range', () => {
    // The curve is chosen so a fleet that was scoring well keeps the number it
    // had: the old formula was 100 - penalty, and the two agree within a point
    // until the penalty gets large.
    for (const p of [5, 10, 15, 20]) {
      expect(Math.abs(scoreForPenalty(p) - (100 - p))).toBeLessThan(2);
    }
  });

  it('never reaches zero, however bad the driving', () => {
    // The bug: everything past a penalty of 100 clamped to exactly 0, so the
    // real vehicle's 128.8 was indistinguishable from ten times worse.
    expect(scoreForPenalty(128.8)).toBeGreaterThan(0);
    expect(scoreForPenalty(500)).toBeGreaterThan(0);
    expect(scoreForPenalty(5000)).toBeGreaterThan(0);
  });

  it('still ranks two bad fleets against each other', () => {
    const bad = scoreForPenalty(128.8);
    const worse = scoreForPenalty(400);
    const awful = scoreForPenalty(1000);
    expect(bad).toBeGreaterThan(worse);
    expect(worse).toBeGreaterThan(awful);
  });

  it('stays inside 0-100', () => {
    for (const p of [0, 1, 50, 128.8, 1000, 1e6]) {
      const s = scoreForPenalty(p);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });

  it('survives a non-finite penalty rather than reporting NaN', () => {
    expect(scoreForPenalty(Number.NaN)).toBe(100);
    expect(scoreForPenalty(Number.POSITIVE_INFINITY)).toBe(100);
  });

  it('scores the real vehicle as bad but measurable', () => {
    // 43 harsh manoeuvres plus 1.3 billable idle hours over 86 km.
    const score = Math.round(scoreForPenalty(128.8));
    expect(score).toBeGreaterThan(20);
    expect(score).toBeLessThan(35);
  });
});
