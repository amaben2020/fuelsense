// Harsh acceleration, braking and cornering, derived from what the tracker
// already sends.
//
// The FMC150 can compute these itself, but only when its Eco/Green Driving
// scenario is switched on, and this fleet's devices have it off — which is why
// the driving-behaviour page has always been empty. Nothing has to change on
// the hardware: a manoeuvre violent enough to matter is plainly visible in the
// speed and heading series, which arrive roughly a second apart while moving.
//
//   acceleration = Δspeed / Δt
//   lateral acceleration in a turn = speed × rate of heading change
//
// The physics is the easy part. The care is in refusing to call a GPS artefact
// a driving fault: heading is meaningless when a vehicle is barely moving, a
// two-minute reporting gap says nothing about the second in between, and a
// satellite glitch can fake a 40 km/h jump. Each of those is rejected below
// rather than reported as a driver's mistake.

/** Below this, GNSS heading is noise — a stationary vehicle "turns" randomly. */
const CORNERING_MIN_SPEED_KPH = 15;

/** A manoeuvre happens in seconds; anything longer is two separate moments. */
const MAX_SAMPLE_GAP_S = 5;
/** Sub-second deltas divide by almost nothing and explode the result. */
const MIN_SAMPLE_GAP_S = 0.5;

/**
 * No road vehicle changes speed this fast. Beyond it the fix is wrong, not the
 * driver — a dropped satellite lock reads as a step change in speed.
 */
const IMPLAUSIBLE_DELTA_KPH_PER_S = 40;

export interface DrivingSample {
  at: Date;
  speedKph: number;
  /** GNSS course over ground, degrees. Null when the device did not report it. */
  headingDeg: number | null;
  lat: number | null;
  lng: number | null;
}

export type HarshEventType = 'harsh_acceleration' | 'harsh_braking' | 'harsh_cornering';

export interface HarshEvent {
  type: HarshEventType;
  occurredAt: Date;
  /** Peak magnitude of the manoeuvre, m/s². */
  magnitudeMs2: number;
  speedKph: number;
  lat: number | null;
  lng: number | null;
  severity: 'warning' | 'critical';
}

export interface HarshThresholds {
  /** m/s². ~0.25 g — firm enough to spill a drink, not an emergency. */
  accelerationMs2: number;
  /** m/s², magnitude. Braking is judged harder than acceleration: it is the
   *  one that precedes collisions, and its weight in the score reflects that. */
  brakingMs2: number;
  /** m/s² of lateral acceleration through a turn. */
  corneringMs2: number;
  /** Multiple of a threshold at which an event is recorded as critical. */
  severeMultiple: number;
}

export const DEFAULT_HARSH_THRESHOLDS: HarshThresholds = {
  accelerationMs2: Number(process.env.HARSH_ACCEL_MS2 || 2.5),
  brakingMs2: Number(process.env.HARSH_BRAKE_MS2 || 3),
  corneringMs2: Number(process.env.HARSH_CORNER_MS2 || 3),
  severeMultiple: Number(process.env.HARSH_SEVERE_MULTIPLE || 1.5),
};

const KPH_TO_MS = 1 / 3.6;

/**
 * Smallest angle between two compass headings, in degrees (0-180).
 *
 * The double modulo is doing real work: JavaScript's `%` keeps the sign of the
 * dividend, so a large negative swing would otherwise wrap the wrong way and
 * turn a gentle correction into a reported hairpin.
 */
export function headingDeltaDeg(from: number, to: number): number {
  return Math.abs(((((to - from) % 360) + 540) % 360) - 180);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Find every harsh manoeuvre in one vehicle's samples.
 *
 * Consecutive samples over a threshold are one event, not five: a driver who
 * brakes hard for three seconds did one thing wrong, and reporting it as three
 * violations would distort any score built on the count. The peak magnitude of
 * each stretch is what gets recorded.
 */
export function detectHarshEvents(
  samples: DrivingSample[],
  overrides: Partial<HarshThresholds> = {}
): HarshEvent[] {
  const thresholds = { ...DEFAULT_HARSH_THRESHOLDS, ...overrides };
  const events: HarshEvent[] = [];

  // One open run per type, so a hard brake through a corner is reported as
  // both without either swallowing the other.
  const open = new Map<HarshEventType, HarshEvent>();

  const close = (type: HarshEventType) => {
    const event = open.get(type);
    if (event) {
      events.push(event);
      open.delete(type);
    }
  };

  const extend = (type: HarshEventType, candidate: HarshEvent) => {
    const current = open.get(type);
    if (!current) {
      open.set(type, candidate);
      return;
    }
    // Keep the worst moment of the stretch, and the position it happened at.
    if (candidate.magnitudeMs2 > current.magnitudeMs2) open.set(type, candidate);
  };

  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const sample = samples[i];
    const gapS = (sample.at.getTime() - prev.at.getTime()) / 1000;

    // A gap this size tells us nothing about what happened inside it, so any
    // open manoeuvre ends here rather than spanning the silence.
    if (gapS < MIN_SAMPLE_GAP_S || gapS > MAX_SAMPLE_GAP_S) {
      close('harsh_acceleration');
      close('harsh_braking');
      close('harsh_cornering');
      continue;
    }

    const deltaKph = sample.speedKph - prev.speedKph;

    if (Math.abs(deltaKph) / gapS > IMPLAUSIBLE_DELTA_KPH_PER_S) {
      close('harsh_acceleration');
      close('harsh_braking');
      close('harsh_cornering');
      continue;
    }

    const accelMs2 = (deltaKph * KPH_TO_MS) / gapS;

    const shared = {
      occurredAt: sample.at,
      speedKph: Math.round(sample.speedKph),
      lat: sample.lat,
      lng: sample.lng,
    };

    // --- longitudinal ----------------------------------------------------
    if (accelMs2 >= thresholds.accelerationMs2) {
      extend('harsh_acceleration', {
        ...shared,
        type: 'harsh_acceleration',
        magnitudeMs2: round2(accelMs2),
        severity:
          accelMs2 >= thresholds.accelerationMs2 * thresholds.severeMultiple
            ? 'critical'
            : 'warning',
      });
      close('harsh_braking');
    } else if (-accelMs2 >= thresholds.brakingMs2) {
      extend('harsh_braking', {
        ...shared,
        type: 'harsh_braking',
        magnitudeMs2: round2(-accelMs2),
        severity:
          -accelMs2 >= thresholds.brakingMs2 * thresholds.severeMultiple
            ? 'critical'
            : 'warning',
      });
      close('harsh_acceleration');
    } else {
      close('harsh_acceleration');
      close('harsh_braking');
    }

    // --- lateral ---------------------------------------------------------
    // Heading only means something once the vehicle is properly moving, and
    // the speed through the turn is what turns a heading change into force.
    const speedMs = sample.speedKph * KPH_TO_MS;
    if (
      prev.headingDeg != null &&
      sample.headingDeg != null &&
      sample.speedKph >= CORNERING_MIN_SPEED_KPH &&
      prev.speedKph >= CORNERING_MIN_SPEED_KPH
    ) {
      const yawRateRadS = (headingDeltaDeg(prev.headingDeg, sample.headingDeg) * Math.PI) / 180 / gapS;
      const lateralMs2 = speedMs * yawRateRadS;

      if (lateralMs2 >= thresholds.corneringMs2) {
        extend('harsh_cornering', {
          ...shared,
          type: 'harsh_cornering',
          magnitudeMs2: round2(lateralMs2),
          severity:
            lateralMs2 >= thresholds.corneringMs2 * thresholds.severeMultiple
              ? 'critical'
              : 'warning',
        });
      } else {
        close('harsh_cornering');
      }
    } else {
      close('harsh_cornering');
    }
  }

  close('harsh_acceleration');
  close('harsh_braking');
  close('harsh_cornering');

  return events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}
