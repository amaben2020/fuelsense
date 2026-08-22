import { describe, it, expect } from '@jest/globals';
import {
  classifyAlert,
  countsTowardHealth,
  autoResolveAfterDays,
  sweepableTypesByWindow,
} from '../src/lib/alert-taxonomy';

describe('alert taxonomy', () => {
  describe('what counts toward fleet health', () => {
    // The bug this file exists to prevent: every one of these was costing the
    // fleet two points of health, and together they took a working
    // single-vehicle fleet to 39/100 and a "critical" verdict.
    it.each([
      'receipt_uploaded',
      'trip_start',
      'geofence_entry',
      'geofence_exit',
      'immobilizer_released',
    ])('ignores %s, which reports an event rather than a problem', (type) => {
      expect(countsTowardHealth(type)).toBe(false);
    });

    it('ignores device_offline, which is connectivity and has its own tile', () => {
      expect(classifyAlert('device_offline')).toBe('connectivity');
      expect(countsTowardHealth('device_offline')).toBe(false);
    });

    it.each([
      'fuel_theft',
      'unlogged_fill',
      'excessive_idle',
      'route_deviation',
      'overspeeding',
    ])('counts %s, which says something about driving or fuel', (type) => {
      expect(countsTowardHealth(type)).toBe(true);
    });

    it('counts an unrecognised type, so a new alert is visible not invisible', () => {
      expect(classifyAlert('something_new')).toBe('warning');
      expect(countsTowardHealth('something_new')).toBe(true);
    });
  });

  describe('expiry windows', () => {
    it('never expires anything involving possible loss', () => {
      for (const type of ['fuel_theft', 'receipt_fraud', 'unlogged_fill', 'fuel_discrepancy']) {
        expect(autoResolveAfterDays(type)).toBeNull();
      }
    });

    it('leaves device_offline to the watchdog that raises and clears it', () => {
      expect(autoResolveAfterDays('device_offline')).toBeNull();
    });

    it('expires notifications after a day and warnings after a fortnight', () => {
      expect(autoResolveAfterDays('receipt_uploaded')).toBe(1);
      expect(autoResolveAfterDays('excessive_idle')).toBe(14);
    });

    it('never offers a sweepable type that should wait for a person', () => {
      const sweepable = sweepableTypesByWindow().flatMap((b) => b.types);
      expect(sweepable).not.toContain('fuel_theft');
      expect(sweepable).not.toContain('receipt_fraud');
      expect(sweepable).not.toContain('unlogged_fill');
      expect(sweepable).not.toContain('device_offline');
      expect(sweepable).toContain('receipt_uploaded');
      expect(sweepable).toContain('excessive_idle');
    });

    it('groups sweepable types by window without duplicating any', () => {
      const buckets = sweepableTypesByWindow();
      const all = buckets.flatMap((b) => b.types);
      expect(new Set(all).size).toBe(all.length);
      expect(buckets.map((b) => b.days).sort((a, b) => a - b)).toEqual([1, 14]);
    });
  });
});
