'use client';

import { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';

// The product at a glance, cycling through the three things a manager opens
// it for: where the vehicle is, what the tank is doing, and what it cost.
//
// Built as real markup rather than a screenshot so it stays sharp at every
// size, animates its own numbers, and cannot go stale when the dashboard
// changes. The frames are the actual panels, with representative figures.

type FrameKey = 'live' | 'fuel' | 'money';

const FRAMES: { key: FrameKey; tab: string }[] = [
  { key: 'live', tab: 'Live' },
  { key: 'fuel', tab: 'Fuel' },
  { key: 'money', tab: 'Cost' },
];

const CYCLE_MS = 4200;

/** Fuel curve for the middle frame, with the idling stretch marked. */
const CURVE = [42, 41.6, 40.9, 40.2, 39.4, 39.1, 38.9, 38.7, 37.9, 37.1, 36.2, 35.4];
const IDLE_FROM = 5;
const IDLE_TO = 7;

export function HeroDashboard() {
  const [active, setActive] = useState<FrameKey>('live');
  const root = useRef<HTMLDivElement>(null);

  // Advance on a timer, pausing while the visitor is hovering so they can
  // actually read the frame they stopped on.
  const paused = useRef(false);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (paused.current) return;
      setActive((current) => {
        const index = FRAMES.findIndex((frame) => frame.key === current);
        return FRAMES[(index + 1) % FRAMES.length].key;
      });
    }, CYCLE_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const scope = root.current;
    if (!scope) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const ctx = gsap.context(() => {
      gsap.fromTo(
        '[data-frame-active] [data-frame-item]',
        { opacity: 0, y: 10 },
        { opacity: 1, y: 0, duration: 0.45, ease: 'power2.out', stagger: 0.06 }
      );
    }, scope);

    return () => ctx.revert();
  }, [active]);

  const max = Math.max(...CURVE);
  const min = Math.min(...CURVE) - 1;

  return (
    <div
      className="fs-hero-dash"
      ref={root}
      onMouseEnter={() => (paused.current = true)}
      onMouseLeave={() => (paused.current = false)}
    >
      <div className="fs-hero-dash__chrome">
        <span className="fs-hero-dash__title">LIVE-FMC150 · Toyota RAV4</span>
        <span className="fs-live">
          <span className="fs-live__dot" aria-hidden />
          Live
        </span>
      </div>

      <div className="fs-hero-dash__tabs" role="tablist" aria-label="Dashboard preview">
        {FRAMES.map((frame) => (
          <button
            key={frame.key}
            type="button"
            role="tab"
            aria-selected={active === frame.key}
            className="fs-hero-dash__tab"
            onClick={() => setActive(frame.key)}
          >
            {frame.tab}
          </button>
        ))}
      </div>

      <div className="fs-hero-dash__stage">
        {active === 'live' && (
          <div className="fs-hero-dash__frame" data-frame-active>
            <div className="fs-hero-dash__rows">
              {[
                ['Ignition', 'On', true],
                ['Speed', '38 km/h', false],
                ['Trip today', '48.2 km · 1h 12m', false],
                ['Last stop', 'Nyanya market · 14 min', false],
              ].map(([label, value, accent]) => (
                <div className="fs-readrow" key={label as string} data-frame-item>
                  <span className="fs-readrow__label">{label}</span>
                  <span
                    className={`fs-readrow__value${accent ? ' fs-readrow__value--accent' : ''}`}
                  >
                    {value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {active === 'fuel' && (
          <div className="fs-hero-dash__frame" data-frame-active>
            <div data-frame-item>
              <svg viewBox="0 0 320 96" className="fs-hero-dash__curve" role="img"
                   aria-label="Fuel level falling through the day, with idling shaded">
                {/* Shaded block marks where the engine ran without moving. */}
                <rect
                  x={(IDLE_FROM / (CURVE.length - 1)) * 320}
                  y="0"
                  width={((IDLE_TO - IDLE_FROM) / (CURVE.length - 1)) * 320}
                  height="96"
                  fill="#ffb95f"
                  opacity="0.14"
                />
                <polyline
                  points={CURVE.map((value, i) => {
                    const x = (i / (CURVE.length - 1)) * 320;
                    const y = 88 - ((value - min) / (max - min)) * 76;
                    return `${x.toFixed(1)},${y.toFixed(1)}`;
                  }).join(' ')}
                  fill="none"
                  stroke="#00e599"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="fs-hero-dash__rows">
              {[
                ['Fuel left', '35.4 L · 59%', false],
                ['Burned today', '6.6 L', false],
                ['Idling', '22 min · 0.9 L', true],
              ].map(([label, value, warn]) => (
                <div className="fs-readrow" key={label as string} data-frame-item>
                  <span className="fs-readrow__label">{label}</span>
                  <span
                    className="fs-readrow__value"
                    style={warn ? { color: '#ffb95f' } : undefined}
                  >
                    {value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {active === 'money' && (
          <div className="fs-hero-dash__frame" data-frame-active>
            <div className="fs-hero-dash__tiles">
              {[
                { label: 'Spend · 7d', value: '₦48,300', note: '286 km' },
                { label: 'Per km', value: '₦169', note: 'vs ₦190 typical' },
                { label: 'Saved', value: '₦6,420', note: 'vs benchmark', good: true },
                { label: 'Economy', value: '7.4 km/L', note: 'vs 7.0' },
              ].map((tile) => (
                <div className="fs-hero-dash__tile" key={tile.label} data-frame-item>
                  <p className="fs-hero-dash__tilelabel">{tile.label}</p>
                  <p
                    className="fs-hero-dash__tilevalue"
                    style={tile.good ? { color: '#00e599' } : undefined}
                  >
                    {tile.value}
                  </p>
                  <p className="fs-hero-dash__tilenote">{tile.note}</p>
                </div>
              ))}
            </div>
            <p className="fs-hero-dash__foot" data-frame-item>
              286 km at 7.0 km/L = 40.9 L, which at ₦1,330/L is ₦54,720.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
