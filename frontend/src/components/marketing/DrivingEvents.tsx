'use client';

import { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

// The driving-events panel, built to look and behave like the product.
//
// The previous version was an abstract curve on an empty ground: no map, no
// vehicle, no event names. A visitor could not tell what they were looking at,
// which defeats the point of the section — someone deciding whether this solves
// their problem needs to see the actual instrument, not a diagram of one.
//
// So this is the replay panel in miniature: a road network underneath, the
// vehicle marker from the fleet map, a track coloured by measured speed with
// manoeuvre stretches picked out, and the event feed ticking alongside it.
//
// **The telemetry below is a scripted demonstration, not a live feed**, and the
// panel says so on its face. Everything it depicts is real capability — the
// speeds, the magnitudes, the detection thresholds and the derivation method
// all match what `harsh-driving.ts` actually computes — but these particular
// numbers describe a drive that never happened. Labelling it clearly is the
// same standard the product itself is held to.

const ROAD_BG =
  'M -40 250 C 120 250, 190 236, 250 205 M 250 205 C 330 165, 360 92, 470 70 ' +
  'M 470 70 C 560 52, 640 96, 720 120 M 90 320 C 180 300, 240 268, 300 230 ' +
  'M 520 -10 C 540 60, 505 120, 470 190 M 470 190 C 440 250, 470 300, 520 340';

const ROUTE =
  'M 30 300 C 96 300, 150 288, 196 262 C 250 232, 276 176, 340 152 ' +
  'C 400 130, 452 158, 508 136 C 560 116, 584 70, 648 56';

type Tone = 'slow' | 'mid' | 'fast' | 'brake' | 'corner' | 'over';

const TONE: Record<Tone, string> = {
  slow: '#4d7c3f',
  mid: '#8fb840',
  fast: '#cde04a',
  brake: '#ff4d4f',
  corner: '#ffab00',
  over: '#ff36c0',
};

/** Contiguous stretches of the route, in travel order. */
const SEGMENTS: Array<{ from: number; to: number; tone: Tone }> = [
  { from: 0, to: 0.13, tone: 'slow' },
  { from: 0.13, to: 0.25, tone: 'mid' },
  { from: 0.25, to: 0.31, tone: 'brake' },
  { from: 0.31, to: 0.44, tone: 'mid' },
  { from: 0.44, to: 0.51, tone: 'corner' },
  { from: 0.51, to: 0.64, tone: 'fast' },
  { from: 0.64, to: 0.84, tone: 'over' },
  { from: 0.84, to: 1, tone: 'mid' },
];

interface Event {
  /** Fraction along the route where it fires. */
  at: number;
  clock: string;
  type: string;
  detail: string;
  /** How it is known — never omitted. */
  source: string;
  tone: Tone;
}

const EVENTS: Event[] = [
  {
    at: 0.13,
    clock: '07:12:04',
    type: 'Trip started',
    detail: 'Ignition ON · Depot, Kubwa',
    source: 'AVL 239 ignition edge',
    tone: 'mid',
  },
  {
    at: 0.29,
    clock: '07:19:41',
    type: 'Harsh braking',
    detail: '4.1 m/s² · 0.42 g · from 63 km/h',
    source: 'Derived from the GPS speed trace',
    tone: 'brake',
  },
  {
    at: 0.5,
    clock: '07:24:18',
    type: 'Harsh cornering',
    detail: '3.6 m/s² lateral at 51 km/h',
    source: 'Speed × rate of heading change',
    tone: 'corner',
  },
  {
    at: 0.72,
    clock: '07:31:55',
    type: 'Overspeeding',
    detail: '118 km/h peak · 1 min 40 s over',
    source: 'Measured speed vs your 100 km/h limit',
    tone: 'over',
  },
  {
    at: 0.92,
    clock: '07:38:22',
    type: 'Idling',
    detail: '6 min 12 s · 0.12 L · ₦156',
    source: 'Engine on, speed below 2 km/h',
    tone: 'slow',
  },
];

/** Live readout beside the map, interpolated as the scrubber moves. */
function readoutAt(t: number) {
  const speed = Math.round(
    t < 0.13 ? 18 + t * 120 : t < 0.31 ? 63 - (t - 0.13) * 90 : t < 0.64 ? 48 + (t - 0.31) * 70 : t < 0.84 ? 118 - (t - 0.64) * 40 : 26
  );
  return {
    speed: Math.max(0, speed),
    distance: (t * 23.4).toFixed(1),
    fuel: (39.7 - t * 2.38).toFixed(1),
    spent: Math.round(t * 3050).toLocaleString('en-NG'),
  };
}

/**
 * The behaviours a visitor can inspect, one at a time.
 *
 * Showing all four colours at once made the track look like a fault report on
 * a single catastrophic drive, and buried the thing each detection actually
 * demonstrates. Picking one keeps the other stretches on the track as measured
 * speed, so the selected behaviour reads as an exception against normal
 * driving, which is how it appears in the product.
 */
const BEHAVIOURS: Array<{ id: Tone | 'all'; label: string; blurb: string }> = [
  {
    id: 'all',
    label: 'Everything',
    blurb: 'One drive, every detection the tracker supports, in the order they fired.',
  },
  {
    id: 'brake',
    label: 'Harsh braking',
    blurb: 'Δspeed ÷ Δt across consecutive fixes. Flagged past 3.0 m/s².',
  },
  {
    id: 'corner',
    label: 'Harsh cornering',
    blurb: 'Speed × rate of heading change. Ignored below 15 km/h, where heading is noise.',
  },
  {
    id: 'over',
    label: 'Overspeeding',
    blurb: 'Measured speed against the limit you declare. No limit set means nothing is reported.',
  },
];

export function DrivingEvents() {
  const root = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const [behaviour, setBehaviour] = useState<Tone | 'all'>('all');

  useEffect(() => {
    const scope = root.current;
    if (!scope) return;

    gsap.registerPlugin(ScrollTrigger);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const ctx = gsap.context(() => {
      const base = scope.querySelector<SVGPathElement>('[data-route]');
      const car = scope.querySelector<SVGGElement>('[data-car]');
      const segs = gsap.utils.toArray<SVGPathElement>('[data-seg]', scope);
      if (!base) return;

      const total = base.getTotalLength();

      // Each coloured stretch is the whole route clipped by a dash window, so
      // the segments butt together exactly and read as one continuous drive.
      segs.forEach((seg) => {
        const from = Number(seg.dataset.from) * total;
        const len = (Number(seg.dataset.to) - Number(seg.dataset.from)) * total;
        seg.style.strokeDasharray = `0 ${from} ${len} ${total}`;
      });

      // Reduced motion still gets the finished picture — the section is
      // information, and the scrubbing is only its delivery.
      if (reduced) {
        setProgress(1);
        if (car) {
          const p = base.getPointAtLength(total);
          gsap.set(car, { x: p.x, y: p.y, opacity: 1 });
        }
        return;
      }

      const proxy = { t: 0 };
      gsap.to(proxy, {
        t: 1,
        ease: 'none',
        scrollTrigger: {
          trigger: scope,
          start: 'top 78%',
          end: 'bottom 65%',
          scrub: 0.6,
        },
        onUpdate: () => {
          setProgress(proxy.t);
          if (!car) return;
          const p = base.getPointAtLength(proxy.t * total);
          gsap.set(car, { x: p.x, y: p.y, opacity: proxy.t > 0.01 ? 1 : 0 });
        },
      });
    }, scope);

    return () => ctx.revert();
  }, []);

  const live = readoutAt(progress);
  // "Everything" keeps the trip bookends for context; a single behaviour shows
  // only its own occurrences, so the feed matches what the track is drawing.
  const shownEvents =
    behaviour === 'all' ? EVENTS : EVENTS.filter((e) => e.tone === behaviour);
  const fired = shownEvents.filter((e) => progress >= e.at);

  return (
    <div ref={root} className="fs-events">
      <div className="fs-events__picker">
        <div className="fs-events__tabs" role="tablist" aria-label="Driving behaviour">
          {BEHAVIOURS.map((b) => (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-selected={behaviour === b.id}
              onClick={() => setBehaviour(b.id)}
              className={`fs-events__tab${behaviour === b.id ? ' is-active' : ''}`}
            >
              {b.id !== 'all' && (
                <span
                  className="fs-events__tabdot"
                  style={{ background: TONE[b.id as Tone] }}
                  aria-hidden="true"
                />
              )}
              {b.label}
            </button>
          ))}
        </div>
        {/* How the selected behaviour is actually computed. The point of the
            section is that each detection is checkable, so the method travels
            with the tab rather than living in a footnote. */}
        <p className="fs-events__blurb">
          {BEHAVIOURS.find((b) => b.id === behaviour)?.blurb}
        </p>
      </div>

      <div className="fs-events__stage">
        <div className="fs-events__chip">
          <span className="fs-events__dot" />
          LAG-001-FS · Toyota RAV4 · Benneth · Abuja
        </div>

        <svg
          viewBox="0 0 700 360"
          role="img"
          aria-label="A drive coloured by measured speed, with harsh braking, harsh cornering and an overspeed stretch marked"
        >
          {/* Road network beneath, so the track reads as a journey through a
              city rather than a line on a page. */}
          <path d={ROAD_BG} fill="none" stroke="#20242c" strokeWidth={14} strokeLinecap="round" />
          <path d={ROAD_BG} fill="none" stroke="#171b22" strokeWidth={10} strokeLinecap="round" />

          {/* Casing under the track, same as the replay map. */}
          <path data-route d={ROUTE} fill="none" stroke="#0b0e13" strokeWidth={13} strokeLinecap="round" />

          {SEGMENTS.map((seg) => {
            const isManoeuvre = seg.tone === 'brake' || seg.tone === 'corner' || seg.tone === 'over';
            // A manoeuvre the visitor is not currently inspecting falls back to
            // its speed colour, so the track still shows a complete drive
            // rather than developing gaps.
            const muted = isManoeuvre && behaviour !== 'all' && behaviour !== seg.tone;
            const tone: Tone = muted ? 'mid' : seg.tone;
            return (
              <path
                key={`${seg.from}-${seg.tone}`}
                data-seg
                data-from={seg.from}
                data-to={seg.to}
                d={ROUTE}
                fill="none"
                stroke={TONE[tone]}
                strokeWidth={isManoeuvre && !muted ? 9 : 6}
                strokeLinecap="butt"
                style={{ transition: 'stroke 0.35s ease, stroke-width 0.35s ease' }}
              />
            );
          })}

          {/* Event pins, revealed as the vehicle reaches them. */}
          {EVENTS.map((e) => {
            const shown = progress >= e.at;
            return (
              <g key={e.type} opacity={shown ? 1 : 0} style={{ transition: 'opacity .25s' }}>
                <circle
                  cx={30 + e.at * 620}
                  cy={300 - e.at * 250}
                  r={13}
                  fill={TONE[e.tone]}
                  opacity={0.16}
                />
              </g>
            );
          })}

          {/* The vehicle marker, matching the fleet map's puck-and-body. */}
          <g data-car opacity={0}>
            <circle r={15} fill="rgba(205,224,74,0.14)" />
            <rect x={-9} y={-6} width={18} height={12} rx={3} fill="#d9dde4" />
            <rect x={-6} y={-4.5} width={7} height={9} rx={1.5} fill="#20242c" />
          </g>
        </svg>

        <div className="fs-events__legend">
          <span className="fs-events__key">
            <span className="fs-events__swatch fs-events__swatch--ramp" aria-hidden="true" />
            Measured speed
          </span>
          {(['brake', 'corner', 'over'] as const).map((tone) => (
            <span key={tone} className="fs-events__key">
              <span
                className="fs-events__swatch"
                style={{ background: TONE[tone] }}
                aria-hidden="true"
              />
              {tone === 'brake' ? 'Harsh braking' : tone === 'corner' ? 'Harsh cornering' : 'Over the limit'}
            </span>
          ))}
        </div>
      </div>

      <div className="fs-events__side">
        {/* Live readout — the same four figures the product puts beside a trip. */}
        <div className="fs-events__readout">
          {[
            { label: 'Speed', value: `${live.speed}`, unit: 'km/h' },
            { label: 'Distance', value: live.distance, unit: 'km' },
            { label: 'Tank (modelled)', value: live.fuel, unit: 'L' },
            { label: 'Fuel spent', value: `₦${live.spent}`, unit: '' },
          ].map((m) => (
            <div key={m.label} className="fs-events__metric">
              <p className="fs-events__metriclabel">{m.label}</p>
              <p className="fs-events__metricvalue">
                {m.value}
                {m.unit && <span className="fs-events__metricunit"> {m.unit}</span>}
              </p>
            </div>
          ))}
        </div>

        <div className="fs-events__feedhead">
          <span className="fs-events__dot" />
          Event feed
          <span className="fs-events__count">{fired.length}/{shownEvents.length}</span>
        </div>

        <ul className="fs-events__feed">
          {shownEvents.map((e) => {
            const shown = progress >= e.at;
            return (
              <li
                key={e.type}
                className={`fs-events__event${shown ? ' is-live' : ''}`}
                style={{ borderLeftColor: TONE[e.tone] }}
              >
                <div className="fs-events__eventtop">
                  <span className="fs-events__clock">{e.clock}</span>
                  <span className="fs-events__type">{e.type}</span>
                </div>
                <p className="fs-events__detail">{e.detail}</p>
                <p className="fs-events__source">{e.source}</p>
              </li>
            );
          })}
        </ul>

        <p className="fs-events__disclaimer">
          Scripted demonstration, not a live vehicle. The detection method,
          thresholds and units are the ones the product actually uses — this
          particular drive is not real.
        </p>
      </div>
    </div>
  );
}
