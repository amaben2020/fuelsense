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

/**
 * How far over the limit counts, and for how long.
 *
 * GNSS speed carries a little noise, and a limit is not a cliff edge — a fix
 * reading 101 km/h against a 100 limit is inside the error bar, and reporting
 * it would bury a real 130 km/h stretch under a hundred rounding artefacts.
 * The margin and the dwell time together mean a reported stretch is one a
 * driver would recognise.
 */
const OVERSPEED_MARGIN_KPH = Number(process.env.OVERSPEED_MARGIN_KPH || 5);
const OVERSPEED_MIN_SECONDS = Number(process.env.OVERSPEED_MIN_SECONDS || 10);

export interface OverspeedStretch {
  startedAt: Date;
  endedAt: Date;
  seconds: number;
  /** Fastest fix in the stretch, km/h. */
  peakKph: number;
  limitKph: number;
  lat: number | null;
  lng: number | null;
  severity: 'warning' | 'critical';
}

/**
 * Continuous stretches above the fleet's declared limit.
 *
 * Derived from the GPS speed already stored on every fix, so it works whether
 * or not the tracker's own Overspeeding scenario is enabled — and it can be
 * recomputed for history, which a device-side event never can.
 *
 * Returns nothing when no limit is set: without a declared limit there is no
 * such thing as too fast, and picking a number here would be inventing fleet
 * policy.
 */
export function detectOverspeed(
  samples: DrivingSample[],
  limitKph: number | null | undefined,
): OverspeedStretch[] {
  if (!limitKph || limitKph <= 0) return [];

  const threshold = limitKph + OVERSPEED_MARGIN_KPH;
  const stretches: OverspeedStretch[] = [];
  let open: { start: DrivingSample; peak: DrivingSample; last: DrivingSample } | null = null;

  const close = () => {
    if (!open) return;
    const seconds = (open.last.at.getTime() - open.start.at.getTime()) / 1000;
    if (seconds >= OVERSPEED_MIN_SECONDS) {
      stretches.push({
        startedAt: open.start.at,
        endedAt: open.last.at,
        seconds: Math.round(seconds),
        peakKph: Math.round(open.peak.speedKph),
        limitKph,
        lat: open.peak.lat,
        lng: open.peak.lng,
        // 20% over the limit is a different conversation from a drift above it.
        severity: open.peak.speedKph >= limitKph * 1.2 ? 'critical' : 'warning',
      });
    }
    open = null;
  };

  for (const sample of samples) {
    // A reporting gap says nothing about the speed inside it, so a stretch
    // never spans one — otherwise an hour offline reads as an hour speeding.
    const gapS = open ? (sample.at.getTime() - open.last.at.getTime()) / 1000 : 0;
    if (open && gapS > MAX_SAMPLE_GAP_S * 12) close();

    if (sample.speedKph >= threshold) {
      if (!open) {
        open = { start: sample, peak: sample, last: sample };
      } else {
        open.last = sample;
        if (sample.speedKph > open.peak.speedKph) open.peak = sample;
      }
    } else {
      close();
    }
  }
  close();

  return stretches;
}

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

/**
 * Where "harsh" starts.
 *
 * These began at 2.5 / 3 / 3, which flagged 43 manoeuvres in 86 km of city
 * driving — one every two kilometres. 2.5 m/s² is 0.25 g, roughly 0-100 km/h
 * in eleven seconds: a brisk overtake, not a violent one. Two things make that
 * too tight. Published telematics practice puts harsh acceleration nearer
 * 3.0-3.5 m/s² and braking nearer 3.5-4.5. And these figures are differentiated
 * from GNSS speed, not read from an accelerometer — about 1 km/h of speed noise
 * across a half-second sample is already ±0.5 m/s² of phantom acceleration, so
 * a low threshold reports the receiver's error as the driver's.
 *
 * Braking sits higher than acceleration because heavy braking is the ordinary
 * response to someone else's mistake, and should not be scored like a choice.
 *
 * There is no ground truth to fit these against: the FMC150's Eco Driving
 * scenario is switched off, so the device reports no accelerometer events to
 * compare with. Treat them as a defensible starting point, not a measurement,
 * and tune with the env vars as real trips accumulate.
 */
export const DEFAULT_HARSH_THRESHOLDS: HarshThresholds = {
  accelerationMs2: Number(process.env.HARSH_ACCEL_MS2 || 3.2),
  brakingMs2: Number(process.env.HARSH_BRAKE_MS2 || 3.8),
  corneringMs2: Number(process.env.HARSH_CORNER_MS2 || 3.5),
  // Lowered from 1.5 alongside the raised thresholds above, which would
  // otherwise have dragged the critical bar up with them: 3.8 x 1.5 puts
  // "critical" braking at 5.7 m/s², and a 0.57 g emergency stop would have
  // been filed as a mere warning. Severe braking is around 0.5 g in the
  // literature, and 3.8 x 1.35 = 5.13 m/s² lands there.
  severeMultiple: Number(process.env.HARSH_SEVERE_MULTIPLE || 1.35),
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
