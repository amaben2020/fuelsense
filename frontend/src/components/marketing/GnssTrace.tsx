'use client';

import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

// The signature scroll moment: a journey draws itself while the tank drains.
//
// Scrubbed rather than played, so the visitor is scrubbing real cause and
// effect — distance covered on the left, fuel gone on the right. The markers
// are the four things the product actually detects from a Teltonika feed:
// ignition on, movement, a stop, ignition off.

const TRIP_PATH =
  'M 44 322 C 96 322, 118 318, 150 296 C 190 268, 206 232, 244 214 ' +
  'C 288 193, 330 206, 366 190 C 408 171, 424 132, 470 116 ' +
  'C 512 101, 556 108, 596 96';

interface Marker {
  /** Fraction along the path, 0-1. */
  at: number;
  label: string;
  detail: string;
  tone: 'good' | 'warn' | 'neutral';
}

const MARKERS: Marker[] = [
  { at: 0.02, label: 'Ignition on', detail: '06:12 · trip opens', tone: 'good' },
  { at: 0.36, label: 'Moving', detail: '38 km/h · burn 9.4 L/100km', tone: 'neutral' },
  { at: 0.63, label: 'Stop · 14 min', detail: 'engine running, idling', tone: 'warn' },
  { at: 0.97, label: 'Ignition off', detail: '07:21 · 30.4 km · 3.1 L', tone: 'good' },
];

const TONE_COLOR: Record<Marker['tone'], string> = {
  good: '#00e599',
  warn: '#ffb95f',
  neutral: '#7d8697',
};

export function GnssTrace() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scope = root.current;
    if (!scope) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    gsap.registerPlugin(ScrollTrigger);

    const ctx = gsap.context(() => {
      const path = scope.querySelector<SVGPathElement>('[data-trace]');
      const dot = scope.querySelector<SVGCircleElement>('[data-dot]');
      const fuelBar = scope.querySelector<HTMLElement>('[data-fuel-bar]');
      const fuelValue = scope.querySelector<HTMLElement>('[data-fuel-value]');
      const distanceValue = scope.querySelector<HTMLElement>('[data-distance-value]');
      if (!path || !dot) return;

      const length = path.getTotalLength();
      gsap.set(path, { strokeDasharray: length, strokeDashoffset: length });
      gsap.set('[data-marker]', { opacity: 0, scale: 0.6, transformOrigin: 'center' });

      const progress = { value: 0 };
      const startLiters = 42;
      const usedLiters = 3.1;
      const totalKm = 30.4;

      gsap.to(progress, {
        value: 1,
        ease: 'none',
        scrollTrigger: {
          trigger: scope,
          start: 'top 72%',
          end: 'bottom 62%',
          scrub: 0.6,
        },
        onUpdate: () => {
          const p = progress.value;
          gsap.set(path, { strokeDashoffset: length * (1 - p) });

          const point = path.getPointAtLength(length * p);
          gsap.set(dot, { attr: { cx: point.x, cy: point.y } });

          if (fuelBar) gsap.set(fuelBar, { scaleY: 1 - (usedLiters / startLiters) * p });
          if (fuelValue) fuelValue.textContent = `${(startLiters - usedLiters * p).toFixed(1)} L`;
          if (distanceValue) distanceValue.textContent = `${(totalKm * p).toFixed(1)} km`;
        },
      });

      // Each marker pops as the trace reaches it.
      MARKERS.forEach((marker, i) => {
        gsap.to(`[data-marker="${i}"]`, {
          opacity: 1,
          scale: 1,
          duration: 0.3,
          ease: 'back.out(2)',
          scrollTrigger: {
            trigger: scope,
            start: `top ${72 - marker.at * 10}%`,
            end: 'bottom 62%',
            onUpdate: (self) => {
              const visible = self.progress >= marker.at * 0.92;
              gsap.to(`[data-marker="${i}"]`, {
                opacity: visible ? 1 : 0,
                scale: visible ? 1 : 0.6,
                duration: 0.25,
                overwrite: true,
              });
            },
          },
        });
      });
    }, scope);

    return () => ctx.revert();
  }, []);

  return (
    <div ref={root} className="fs-trace">
      <div className="fs-trace__map">
        <svg viewBox="0 0 640 360" role="img" aria-label="A vehicle journey drawn from GNSS fixes">
          <defs>
            <pattern id="fs-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#28303d" strokeWidth="1" />
            </pattern>
            <linearGradient id="fs-trace-grad" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0%" stopColor="#00885d" />
              <stop offset="100%" stopColor="#00e599" />
            </linearGradient>
          </defs>

          <rect width="640" height="360" fill="#0b0e13" />
          <rect width="640" height="360" fill="url(#fs-grid)" opacity="0.55" />

          {/* Ghost of the full route, so the drawn part reads as progress */}
          <path d={TRIP_PATH} fill="none" stroke="#28303d" strokeWidth="3" strokeLinecap="round" />
          <path
            data-trace
            d={TRIP_PATH}
            fill="none"
            stroke="url(#fs-trace-grad)"
            strokeWidth="3.5"
            strokeLinecap="round"
          />

          {MARKERS.map((marker, i) => {
            // Static placement mirrors the path's own geometry closely enough
            // for a caption pin; the moving dot is the precise one.
            const positions = [
              { x: 44, y: 322 },
              { x: 244, y: 214 },
              { x: 400, y: 176 },
              { x: 596, y: 96 },
            ];
            const pos = positions[i];
            return (
              <g key={marker.label} data-marker={i}>
                <circle cx={pos.x} cy={pos.y} r="7" fill={TONE_COLOR[marker.tone]} opacity="0.22" />
                <circle cx={pos.x} cy={pos.y} r="3.5" fill={TONE_COLOR[marker.tone]} />
              </g>
            );
          })}

          <circle data-dot cx="44" cy="322" r="6" fill="#ffffff" />
          <circle data-dot-halo cx="44" cy="322" r="0" fill="none" />
        </svg>

        <ol className="fs-trace__legend">
          {MARKERS.map((marker, i) => (
            <li key={marker.label} data-marker={i} className="fs-trace__legenditem">
              <span
                className="fs-trace__pip"
                style={{ background: TONE_COLOR[marker.tone] }}
                aria-hidden
              />
              <span>
                <strong>{marker.label}</strong>
                <span className="fs-trace__detail">{marker.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>

      <aside className="fs-trace__gauge">
        <p className="fs-trace__gaugelabel">Virtual tank</p>
        <div className="fs-trace__tube">
          <div className="fs-trace__fill" data-fuel-bar />
        </div>
        <p className="fs-trace__reading" data-fuel-value>
          42.0 L
        </p>
        <p className="fs-trace__gaugelabel" style={{ marginTop: '1.25rem' }}>
          Distance
        </p>
        <p className="fs-trace__reading" data-distance-value>
          0.0 km
        </p>
      </aside>
    </div>
  );
}
