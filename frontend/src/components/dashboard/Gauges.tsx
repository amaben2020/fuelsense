'use client';

import React, { useId } from 'react';
import { Fuel } from 'lucide-react';

/**
 * Analogue instrument cluster in the Haulix language.
 *
 * The colour ramp on these gauges is deliberately NOT themed. A speedometer
 * that turns red at the top of its range means the same thing on a white
 * screen as on a black one, so the ramp is fixed while the surfaces, ticks and
 * type around it stay on theme tokens.
 */

/**
 * Where the fuel gauge changes colour, as a percentage of usable tank.
 *
 * `usableFuelPercent` already subtracts the reserve litres, so 0% here means
 * the tank is down to the volume held back for the pump — these are warning
 * bands on the way there, not absolute tank fractions.
 */
const RESERVE_PCT = 11;
const LOW_PCT = 15;

const RAMP: { t: number; color: [number, number, number] }[] = [
  { t: 0, color: [77, 222, 138] }, // green — comfortable
  { t: 0.45, color: [226, 232, 113] }, // pale yellow — the Haulix accent
  { t: 0.72, color: [223, 169, 74] }, // amber — watch
  { t: 1, color: [255, 107, 107] }, // red — over
];

/** Sample the fixed ramp at t in [0,1]. */
function rampAt(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  let lo = RAMP[0];
  let hi = RAMP[RAMP.length - 1];
  for (let i = 0; i < RAMP.length - 1; i += 1) {
    if (clamped >= RAMP[i].t && clamped <= RAMP[i + 1].t) {
      lo = RAMP[i];
      hi = RAMP[i + 1];
      break;
    }
  }
  const span = hi.t - lo.t;
  const k = span === 0 ? 0 : (clamped - lo.t) / span;
  const ch = (i: number) => Math.round(lo.color[i] + (hi.color[i] - lo.color[i]) * k);
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

/**
 * Gauge sweep runs 135° → 405°, i.e. bottom-left, up over the top, down to
 * bottom-right. SVG's y-axis points down, so increasing the angle travels
 * clockwise on screen without any extra sign juggling.
 */
const START_DEG = 135;
const SWEEP_DEG = 270;

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

export function SpeedGauge({
  value,
  max = 150,
  unit = 'mph',
  label,
  size = 200,
  className = '',
}: {
  value: number | null;
  max?: number;
  unit?: string;
  label?: string;
  size?: number;
  className?: string;
}) {
  const cx = 100;
  const cy = 100;
  const rArc = 78;
  const safeMax = max > 0 ? max : 1;
  const hasValue = value != null && Number.isFinite(value);
  const t = hasValue ? Math.max(0, Math.min(1, value / safeMax)) : 0;

  // The band is drawn as short arc segments rather than one gradient-stroked
  // path, because SVG gradients are linear in space and would not follow the
  // curve.
  const SEGMENTS = 48;
  const band = Array.from({ length: SEGMENTS }, (_, i) => {
    const t0 = i / SEGMENTS;
    const t1 = (i + 1) / SEGMENTS;
    // Overlap by a hair so antialiasing does not leave seams between segments.
    const a0 = START_DEG + t0 * SWEEP_DEG;
    const a1 = START_DEG + t1 * SWEEP_DEG + 0.6;
    const p0 = polar(cx, cy, rArc, a0);
    const p1 = polar(cx, cy, rArc, a1);
    return {
      key: i,
      d: `M ${p0.x} ${p0.y} A ${rArc} ${rArc} 0 0 1 ${p1.x} ${p1.y}`,
      color: rampAt((t0 + t1) / 2),
    };
  });

  // Pick the densest major-tick count that still lands on round numbers — a
  // fixed count turns a 160 km/h dial into "27 / 53 / 80 / 107 / 133", which
  // no driver reads as a speedometer.
  const MAJORS =
    [6, 5, 4].find((n) => {
      const step = safeMax / n;
      return Number.isInteger(step) && step % 5 === 0;
    }) ?? 4;
  const MINORS_PER_MAJOR = 5;
  const totalTicks = MAJORS * MINORS_PER_MAJOR;
  const ticks = Array.from({ length: totalTicks + 1 }, (_, i) => {
    const tt = i / totalTicks;
    const isMajor = i % MINORS_PER_MAJOR === 0;
    const deg = START_DEG + tt * SWEEP_DEG;
    const outer = polar(cx, cy, rArc - 8, deg);
    const inner = polar(cx, cy, rArc - (isMajor ? 20 : 14), deg);
    return { key: i, isMajor, outer, inner };
  });

  const numbers = Array.from({ length: MAJORS + 1 }, (_, i) => {
    const tt = i / MAJORS;
    const deg = START_DEG + tt * SWEEP_DEG;
    const p = polar(cx, cy, rArc - 27, deg);
    return { key: i, x: p.x, y: p.y, text: Math.round(tt * safeMax).toString() };
  });

  // Needle drawn once pointing right, then rotated into place. Recomputing the
  // polygon points per value changed the geometry rather than a transform, so
  // `transition-transform` had nothing to interpolate and the needle teleported
  // between readings instead of sweeping.
  const needleDeg = START_DEG + t * SWEEP_DEG;
  const needlePoints = `${cx + rArc - 16},${cy} ${cx},${cy - 7} ${cx},${cy + 7}`;

  return (
    <div className={`flex flex-col items-center ${className}`}>
      <svg
        viewBox="0 0 200 200"
        width={size}
        height={size}
        role="img"
        aria-label={
          hasValue ? `${label ?? 'Speed'}: ${value} ${unit}` : `${label ?? 'Speed'}: no data`
        }
        className="max-w-full"
      >
        {/* Unlit track behind the band keeps the dial readable at zero. */}
        <path
          d={(() => {
            const p0 = polar(cx, cy, rArc, START_DEG);
            const p1 = polar(cx, cy, rArc, START_DEG + SWEEP_DEG);
            return `M ${p0.x} ${p0.y} A ${rArc} ${rArc} 0 1 1 ${p1.x} ${p1.y}`;
          })()}
          fill="none"
          stroke="var(--instrument)"
          strokeWidth={15}
          strokeLinecap="round"
        />
        {/* With no reading the ramp is dropped entirely rather than faded —
            a washed-out ramp disappears against a light canvas and still
            implies a value that isn't there. */}
        {band.map((seg) => (
          <path
            key={seg.key}
            d={seg.d}
            fill="none"
            stroke={hasValue ? seg.color : 'var(--instrument-tick)'}
            strokeWidth={13}
            opacity={hasValue ? 1 : 0.35}
          />
        ))}

        {ticks.map((tick) => (
          <line
            key={tick.key}
            x1={tick.inner.x}
            y1={tick.inner.y}
            x2={tick.outer.x}
            y2={tick.outer.y}
            stroke="var(--instrument-tick)"
            strokeWidth={tick.isMajor ? 2 : 1}
            strokeLinecap="round"
            opacity={tick.isMajor ? 0.95 : 0.55}
          />
        ))}

        {numbers.map((n) => (
          <text
            key={n.key}
            x={n.x}
            y={n.y}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={11}
            fill="var(--ink-dim)"
            className="tabular-nums"
          >
            {n.text}
          </text>
        ))}

        {hasValue && (
          <>
            <g
              transform={`rotate(${needleDeg} ${cx} ${cy})`}
              className="transition-transform duration-[900ms] ease-out motion-reduce:transition-none"
            >
              <polygon points={needlePoints} fill="var(--ink)" />
            </g>
            <circle cx={cx} cy={cy} r={8} fill="var(--ink)" />
            <circle cx={cx} cy={cy} r={3.5} fill="var(--instrument)" />
          </>
        )}
        {!hasValue && <circle cx={cx} cy={cy} r={8} fill="var(--instrument-tick)" />}
      </svg>

      <div className="-mt-6 text-center">
        <p className="text-2xl font-bold tabular-nums tracking-tight text-ink">
          {hasValue ? `${Math.round(value)} ` : '— '}
          <span className="text-base font-semibold text-ink-mid">{unit}</span>
        </p>
      </div>
    </div>
  );
}

/**
 * One wave period in SVG user units. The `fuel-wave-*` keyframes shift by
 * exactly this much, so the surface loops without a visible seam — keep the
 * two in step if either changes.
 */
const WAVE_PERIOD = 100;
const WAVE_PERIODS = 6;
const WAVE_W = WAVE_PERIOD * WAVE_PERIODS;
/** Deep enough to cover the dial once the surface sits at the very top. */
const WAVE_H = 220;

/** Sine-like surface built from quadratics, closed downward into a fill. */
function wavePath(amp: number): string {
  const half = WAVE_PERIOD / 2;
  let d = `M 0 0`;
  for (let x = 0; x < WAVE_W; x += WAVE_PERIOD) {
    d += ` Q ${x + half / 2} ${-amp} ${x + half} 0`;
    d += ` Q ${x + half + half / 2} ${amp} ${x + WAVE_PERIOD} 0`;
  }
  d += ` L ${WAVE_W} ${WAVE_H} L 0 ${WAVE_H} Z`;
  return d;
}

/**
 * Circular fuel dial with a liquid surface. The wave is two offset layers
 * drifting in opposite directions, which stops the surface reading as a loop.
 */
export function LiquidFuelGauge({
  percent,
  primary,
  secondary,
  icon: Icon,
  size = 190,
  className = '',
  /** Mirrors a real dashboard's low-fuel telltale — the tank has dropped into
   *  the litres a manufacturer holds back to keep the fuel pump submerged.
   *  `percent` is expected to already be reserve-adjusted (see
   *  `usableFuelPercent` in lib/api), so this only changes the colour and
   *  adds the warning glyph — it does not re-derive the number. */
  inReserve = false,
}: {
  percent: number | null;
  primary: React.ReactNode;
  secondary?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  size?: number;
  className?: string;
  inReserve?: boolean;
}) {
  const rawId = useId();
  const clipId = `fuel-clip-${rawId}`;
  const scrimId = `fuel-scrim-${rawId}`;
  const hasValue = percent != null && Number.isFinite(percent);
  const pct = hasValue ? Math.max(0, Math.min(100, percent)) : 0;

  // Three bands rather than two. The gauge used to jump straight from amber to
  // red the moment the tank hit reserve, which gave a driver no warning that it
  // was coming — the interesting moment is the approach, not the arrival.
  //
  // `inReserve` stays authoritative for the red band because it is measured in
  // litres against the manufacturer's held-back volume, which is the real
  // physical threshold; the percentages below are the warning shading on top.
  const level: 'reserve' | 'low' | 'normal' =
    inReserve || (hasValue && pct <= RESERVE_PCT)
      ? 'reserve'
      : hasValue && pct <= LOW_PCT
        ? 'low'
        : 'normal';

  const waveDeep =
    level === 'reserve'
      ? 'var(--bad-deep)'
      : level === 'low'
        ? 'var(--fuel-low-deep)'
        : 'var(--fuel-amber-deep)';
  const waveTop =
    level === 'reserve'
      ? 'var(--bad-bright)'
      : level === 'low'
        ? 'var(--fuel-low)'
        : 'var(--fuel-amber)';

  const cx = 100;
  const cy = 100;
  const rOuter = 92;
  const rDial = 78;

  // Surface height inside the dial. Kept a touch inside the rim so a full or
  // empty tank still shows a sliver of curve rather than a flat edge.
  const top = cy - rDial;
  const span = rDial * 2;
  const surfaceY = top + span * (1 - pct / 100);

  const TICKS = 60;
  const ticks = Array.from({ length: TICKS }, (_, i) => {
    const deg = (i / TICKS) * 360;
    const isMajor = i % 5 === 0;
    const outer = polar(cx, cy, rOuter, deg);
    const inner = polar(cx, cy, rOuter - (isMajor ? 9 : 5), deg);
    return { key: i, isMajor, outer, inner };
  });

  return (
    <div className={`flex flex-col items-center ${className}`}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          viewBox="0 0 200 200"
          width={size}
          height={size}
          role="img"
          aria-label={hasValue ? `Fuel level ${Math.round(pct)}%` : 'Fuel level: no data'}
        >
          <defs>
            <clipPath id={clipId}>
              <circle cx={cx} cy={cy} r={rDial} />
            </clipPath>
            {/* Soft halo so the centre readout stays legible once the liquid
                rises past it on a near-full tank. */}
            <radialGradient id={scrimId}>
              <stop offset="0%" stopColor="var(--instrument)" stopOpacity="0.99" />
              <stop offset="58%" stopColor="var(--instrument)" stopOpacity="0.95" />
              <stop offset="100%" stopColor="var(--instrument)" stopOpacity="0" />
            </radialGradient>
          </defs>

          {ticks.map((tick) => (
            <line
              key={tick.key}
              x1={tick.inner.x}
              y1={tick.inner.y}
              x2={tick.outer.x}
              y2={tick.outer.y}
              stroke="var(--instrument-tick)"
              strokeWidth={tick.isMajor ? 1.6 : 1}
              strokeLinecap="round"
              opacity={tick.isMajor ? 0.85 : 0.4}
            />
          ))}

          <circle cx={cx} cy={cy} r={rDial} fill="var(--instrument)" />

          {/* The fill level and the drift are applied on separate nested
              groups on purpose: a CSS `transform` animation replaces the whole
              transform, so putting both on one element would animate the
              surface height away and render every tank as full. */}
          {hasValue && pct > 0 && (
            <g clipPath={`url(#${clipId})`}>
              {/* Back wave: deeper, slower, lower opacity. */}
              <g transform={`translate(0 ${surfaceY + 5})`}>
                <g className="fuel-bob-b">
                  <g className="fuel-wave-b">
                    <path
                      d={wavePath(9)}
                      fill={waveDeep}
                      opacity={0.6}
                      transform={`translate(${-WAVE_PERIOD} 0)`}
                    />
                  </g>
                </g>
              </g>
              {/* Front wave carries the readable amber. */}
              <g transform={`translate(0 ${surfaceY})`}>
                <g className="fuel-bob-a">
                  <g className="fuel-wave-a">
                    <path
                      d={wavePath(12)}
                      fill={waveTop}
                      transform={`translate(${-WAVE_PERIOD} 0)`}
                    />
                  </g>
                </g>
              </g>
            </g>
          )}

          <circle cx={cx} cy={cy} r={58} fill={`url(#${scrimId})`} />

          <circle
            cx={cx}
            cy={cy}
            r={rDial}
            fill="none"
            stroke={level === 'reserve' ? 'var(--bad-bright)' : level === 'low' ? 'var(--fuel-low)' : 'var(--edge)'}
            strokeWidth={level === 'normal' ? 1.5 : 2.5}
            className={inReserve ? 'accent-pulse' : undefined}
          />
        </svg>

        {/* Telltale badge — the same fuel-pump glyph a real dashboard lights
            up amber/red once the reserve is reached, not a number a manager
            has to interpret. */}
        {inReserve && (
          <div
            className="accent-pulse absolute -right-1 -top-1 flex h-7 w-7 items-center justify-center rounded-full border-2 border-canvas bg-bad-bright text-white shadow-lg"
            title="In reserve — refuel soon"
            aria-label="Fuel in reserve"
          >
            <Fuel className="h-3.5 w-3.5" />
          </div>
        )}

        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
          {Icon && <Icon className={`h-4 w-4 ${inReserve ? 'text-bad-bright' : 'text-ink-mid'}`} />}
          <p
            className={`text-xl font-bold tabular-nums tracking-tight drop-shadow-sm ${inReserve ? 'text-bad-bright' : 'text-ink'}`}
          >
            {primary}
          </p>
          {secondary}
        </div>
      </div>
    </div>
  );
}
