'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Spring constant and damping for the compass card.
 *
 * Tuned to be under-damped on purpose: a real liquid-filled compass overshoots
 * its bearing and swings back once or twice before settling, and that overshoot
 * is most of what makes it read as an instrument rather than a rotating icon.
 * Raising DAMPING past ~2*sqrt(STIFFNESS) makes it critically damped and the
 * needle glides to a stop, which looks like CSS easing again.
 */
const STIFFNESS = 42;
const DAMPING = 5.6;
/**
 * Magnetometer noise, in degrees. A real sensor never sits perfectly still —
 * the card trembles by a fraction of a degree even parked. Small enough that
 * the reading is never ambiguous, large enough to be alive.
 */
const JITTER_DEG = 0.28;
/** Below this angular speed the card is treated as settled and jitter takes over. */
const SETTLED_DEG_PER_S = 6;

/** Shortest signed way round from a to b, so 350° → 10° swings +20, not -340. */
function shortestDelta(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

const CARDINALS = [
  { deg: 0, label: 'N' },
  { deg: 45, label: 'NE' },
  { deg: 90, label: 'E' },
  { deg: 135, label: 'SE' },
  { deg: 180, label: 'S' },
  { deg: 225, label: 'SW' },
  { deg: 270, label: 'W' },
  { deg: 315, label: 'NW' },
];

/** The 16-point name for a bearing — what the big readout shows. */
function bearingLabel(deg: number): string {
  const names = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
  ];
  const idx = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return names[idx];
}

/**
 * A compass card on a damped magnetic pivot.
 *
 * The card is integrated as a spring–mass–damper rather than transitioned with
 * CSS, because the behaviour that reads as "real" is the physics: it lags a
 * fast turn, overshoots the stop, swings back, and never sits perfectly still.
 * A CSS transition arrives on the exact bearing at the exact moment and looks
 * like a rotating graphic.
 *
 * The tilt is driven by the same angular velocity — a gimballed card leans into
 * a swing — so acceleration is visible as well as position. Both are dropped
 * entirely under `prefers-reduced-motion`, where the card snaps to bearing and
 * the jitter stops.
 */
export function Compass({
  /** Map bearing in degrees. The card rotates opposite this so N stays north. */
  heading,
  onReset,
  size = 56,
}: {
  heading: number;
  onReset?: () => void;
  size?: number;
}) {
  const [angle, setAngle] = useState(heading);
  const [tilt, setTilt] = useState(0);

  const angleRef = useRef(heading);
  const velRef = useRef(0);
  const targetRef = useRef(heading);
  const rafRef = useRef<number | null>(null);

  // Written in an effect, not during render. A ref mutated in the render body
  // is applied again on every replay of that render under concurrent mode, so
  // the animation loop could read a bearing the component had already
  // discarded — the needle would chase a target that no longer existed.
  useEffect(() => {
    targetRef.current = heading;
  }, [heading]);

  useEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (reduced) {
      angleRef.current = targetRef.current;
      setAngle(targetRef.current);
      setTilt(0);
      return;
    }

    let last = performance.now();

    const step = (now: number) => {
      // Clamped so a backgrounded tab returning after seconds does not
      // integrate one enormous step and fling the card.
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      const delta = shortestDelta(angleRef.current, targetRef.current);
      const accel = STIFFNESS * delta - DAMPING * velRef.current;
      velRef.current += accel * dt;
      angleRef.current += velRef.current * dt;

      const speed = Math.abs(velRef.current);

      // Settled: the spring has nothing left to do, so the only motion is
      // sensor noise. Without this the card freezes dead and stops reading as
      // a live instrument.
      const shown =
        speed < SETTLED_DEG_PER_S
          ? angleRef.current + (Math.random() - 0.5) * JITTER_DEG
          : angleRef.current;

      setAngle(shown);
      // Lean into the swing, capped so a fast spin does not fold the card flat.
      setTilt(Math.max(-14, Math.min(14, velRef.current * 0.05)));

      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const r = size / 2;
  const label = bearingLabel(((heading % 360) + 360) % 360);

  return (
    <button
      type="button"
      onClick={onReset}
      title="Reset bearing to north"
      aria-label={`Bearing ${Math.round(((heading % 360) + 360) % 360)} degrees, ${label}. Reset to north.`}
      className="pointer-events-auto relative rounded-full transition-transform hover:scale-105"
      style={{ width: size, height: size, perspective: 220 }}
    >
      {/* Bezel. Two stacked gradients: a lit rim and a recessed dial well, so
          the face reads as sunk into a housing rather than printed on one. */}
      <span
        aria-hidden
        className="absolute inset-0 rounded-full"
        style={{
          background:
            'radial-gradient(circle at 50% 22%, #3b424e 0%, #222831 38%, #12161c 72%, #0a0d12 100%)',
          boxShadow:
            'inset 0 1px 1px rgba(255,255,255,0.18), inset 0 -2px 6px rgba(0,0,0,0.75), 0 6px 16px -6px rgba(0,0,0,0.9)',
        }}
      />

      {/* The rotating card, tilted by its own angular velocity. */}
      <span
        aria-hidden
        className="absolute inset-[3px] rounded-full"
        style={{
          transform: `rotateX(${tilt}deg) rotate(${-angle}deg)`,
          transformStyle: 'preserve-3d',
          willChange: 'transform',
        }}
      >
        <svg viewBox="0 0 100 100" className="h-full w-full">
          <circle cx={50} cy={50} r={48} fill="#0b0e13" />

          {/* Fine tick ring. Every 5°, with every 45° promoted — dense enough
              to shimmer as it turns, which is what sells the rotation. */}
          {Array.from({ length: 72 }, (_, i) => {
            const deg = i * 5;
            const rad = (deg * Math.PI) / 180;
            const major = deg % 45 === 0;
            const inner = major ? 36 : 40;
            return (
              <line
                key={i}
                x1={50 + inner * Math.sin(rad)}
                y1={50 - inner * Math.cos(rad)}
                x2={50 + 45 * Math.sin(rad)}
                y2={50 - 45 * Math.cos(rad)}
                stroke={major ? '#d8dfa8' : '#6f7660'}
                strokeWidth={major ? 2 : 1}
                opacity={major ? 0.95 : 0.5}
              />
            );
          })}

          {/* Cardinals ride the card, so they turn with it like a real dial. */}
          {CARDINALS.map(({ deg, label: cl }) => {
            const rad = (deg * Math.PI) / 180;
            const rr = 29;
            return (
              <text
                key={cl}
                x={50 + rr * Math.sin(rad)}
                y={50 - rr * Math.cos(rad)}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={cl.length > 1 ? 8 : 10}
                fontWeight={700}
                fill={cl === 'N' ? '#f0f3dc' : '#8b9280'}
                transform={`rotate(${deg} ${50 + rr * Math.sin(rad)} ${50 - rr * Math.cos(rad)})`}
              >
                {cl}
              </text>
            );
          })}

          {/* Hub, drawn over the card so the needle appears pivoted on it. */}
          <circle cx={50} cy={50} r={17} fill="#171c24" />
          <circle cx={50} cy={50} r={17} fill="none" stroke="#000" strokeWidth={1} opacity={0.8} />
        </svg>
      </span>

      {/* North marker, fixed to the housing rather than the card — this is the
          index the bearing is read against, so it must not rotate. */}
      <span
        aria-hidden
        className="absolute left-1/2 top-[3px] -translate-x-1/2"
        style={{
          width: 0,
          height: 0,
          borderLeft: '4px solid transparent',
          borderRight: '4px solid transparent',
          borderTop: '7px solid #ff6b3d',
          filter: 'drop-shadow(0 0 3px rgba(255,107,61,0.55))',
        }}
      />

      {/* Live bearing, upright at all times so it stays readable mid-swing. */}
      <span
        className="pointer-events-none absolute inset-0 flex items-center justify-center font-bold text-[--ink]"
        style={{ fontSize: r * 0.34, color: '#f0f3dc', letterSpacing: '-0.02em' }}
      >
        {label}
      </span>
    </button>
  );
}
