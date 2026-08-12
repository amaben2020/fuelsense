'use client';

import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

// A journey that grades itself as the visitor scrolls it.
//
// The claim this section makes is narrow on purpose: every colour below comes
// from something the tracker measures, and nothing here depends on hardware the
// fleet does not have. Speed arrives on every GPS fix, so the track is shaded by
// it. Harsh braking, acceleration and cornering are computed from that same
// speed series and the heading change between fixes. Overspeeding needs one
// extra thing — a limit the fleet declares — and is drawn only when there is
// one.
//
// The segments are laid out along a single path so the colour changes read as
// one continuous drive rather than four illustrations sitting side by side.

const ROUTE =
  'M 40 300 C 92 300, 132 292, 168 268 C 214 238, 232 196, 276 176 ' +
  'C 322 155, 372 172, 414 152 C 458 131, 476 92, 524 78 C 560 68, 596 72, 624 66';

type SegmentTone = 'speed-low' | 'speed-mid' | 'speed-high' | 'brake' | 'corner' | 'over';

const TONE_COLOR: Record<SegmentTone, string> = {
  'speed-low': '#4d7c3f',
  'speed-mid': '#8fb840',
  'speed-high': '#cde04a',
  brake: '#ff4d4f',
  corner: '#ffab00',
  over: '#ff36c0',
};

interface Segment {
  /** Fraction of the route this stretch covers. */
  from: number;
  to: number;
  tone: SegmentTone;
}

/**
 * The drive, in order. Two harsh moments and one sustained overspeed stretch,
 * separated by ordinary driving at varying speed — which is what a real trace
 * looks like, and what makes the flagged parts stand out without being the
 * whole picture.
 */
const SEGMENTS: Segment[] = [
  { from: 0, to: 0.14, tone: 'speed-low' },
  { from: 0.14, to: 0.26, tone: 'speed-mid' },
  { from: 0.26, to: 0.32, tone: 'brake' },
  { from: 0.32, to: 0.46, tone: 'speed-mid' },
  { from: 0.46, to: 0.53, tone: 'corner' },
  { from: 0.53, to: 0.66, tone: 'speed-high' },
  { from: 0.66, to: 0.85, tone: 'over' },
  { from: 0.85, to: 1, tone: 'speed-mid' },
];

interface Flag {
  /** Fraction along the route where the callout is anchored. */
  at: number;
  title: string;
  detail: string;
  /** How this is known — the honesty line, shown in smaller type. */
  source: string;
  tone: SegmentTone;
}

const FLAGS: Flag[] = [
  {
    at: 0.29,
    title: 'Harsh braking',
    detail: '4.1 m/s² · 0.42 g at 63 km/h',
    source: 'From the GPS speed trace',
    tone: 'brake',
  },
  {
    at: 0.5,
    title: 'Harsh cornering',
    detail: '3.6 m/s² lateral at 51 km/h',
    source: 'From speed and heading change',
    tone: 'corner',
  },
  {
    at: 0.75,
    title: 'Over the limit',
    detail: '118 km/h peak · 1 min 40s',
    source: 'Against your declared 100 km/h',
    tone: 'over',
  },
];

export function DrivingEvents() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scope = root.current;
    if (!scope) return;

    // Someone who has asked for less motion still gets the finished picture —
    // the section is information, and the animation is only its delivery.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    gsap.registerPlugin(ScrollTrigger);

    const ctx = gsap.context(() => {
      const paths = gsap.utils.toArray<SVGPathElement>('[data-seg]', scope);
      const car = scope.querySelector<SVGGElement>('[data-car]');
      const base = scope.querySelector<SVGPathElement>('[data-route]');
      if (!paths.length || !base) return;

      // Each coloured stretch is the full route path clipped by a dash window,
      // so the segments meet exactly and the drive reads as one line.
      const total = base.getTotalLength();
      paths.forEach((seg) => {
        const from = Number(seg.dataset.from) * total;
        const to = Number(seg.dataset.to) * total;
        const len = to - from;
        seg.style.strokeDasharray = `0 ${from} ${len} ${total}`;
        gsap.set(seg, { strokeDashoffset: 0, opacity: 0 });
      });

      const timeline = gsap.timeline({
        scrollTrigger: {
          trigger: scope,
          start: 'top 72%',
          end: 'bottom 60%',
          scrub: 0.7,
        },
      });

      // Segments light up in travel order, so scrolling *is* driving the route.
      paths.forEach((seg, i) => {
        timeline.to(seg, { opacity: 1, duration: 0.4 }, i * 0.35);
      });

      if (car) {
        timeline.to(car, { opacity: 1, duration: 0.3 }, 0);
        // Position along the path is driven directly rather than with
        // MotionPathPlugin, which is not registered on this page.
        const proxy = { t: 0 };
        timeline.to(
          proxy,
          {
            t: 1,
            ease: 'none',
            duration: paths.length * 0.35,
            onUpdate: () => {
              const point = base.getPointAtLength(proxy.t * total);
              gsap.set(car, { x: point.x, y: point.y });
            },
          },
          0
        );
      }

      // Callouts arrive as the vehicle reaches them, not all at once.
      gsap.utils.toArray<HTMLElement>('[data-flag]', scope).forEach((flag) => {
        const at = Number(flag.dataset.at);
        timeline.fromTo(
          flag,
          { opacity: 0, y: 14 },
          { opacity: 1, y: 0, duration: 0.5 },
          at * paths.length * 0.35
        );
      });
    }, scope);

    return () => ctx.revert();
  }, []);

  return (
    <div ref={root} className="fs-events">
      <div className="fs-events__stage">
        <svg viewBox="0 0 664 340" role="img" aria-label="A drive coloured by measured speed, with harsh braking, harsh cornering and an overspeed stretch highlighted">
          {/* Casing, so pale high-speed colours stay readable. */}
          <path
            data-route
            d={ROUTE}
            fill="none"
            stroke="#101725"
            strokeWidth={13}
            strokeLinecap="round"
          />
          {SEGMENTS.map((seg) => (
            <path
              key={`${seg.from}-${seg.tone}`}
              data-seg
              data-from={seg.from}
              data-to={seg.to}
              d={ROUTE}
              fill="none"
              stroke={TONE_COLOR[seg.tone]}
              strokeWidth={seg.tone === 'speed-low' || seg.tone === 'speed-mid' || seg.tone === 'speed-high' ? 6 : 9}
              strokeLinecap="butt"
            />
          ))}
          <g data-car opacity={0}>
            <circle r={13} fill="rgba(205,224,74,0.16)" />
            <circle r={5.5} fill="#cde04a" />
          </g>
        </svg>

        {/* A legend, because a coloured line that needs a paragraph to decode
            is decoration rather than evidence. */}
        <ul className="fs-events__legend">
          <li>
            <span
              className="fs-events__swatch fs-events__swatch--ramp"
              aria-hidden="true"
            />
            Measured speed
          </li>
          {(['brake', 'corner', 'over'] as const).map((tone) => (
            <li key={tone}>
              <span
                className="fs-events__swatch"
                style={{ background: TONE_COLOR[tone] }}
                aria-hidden="true"
              />
              {tone === 'brake'
                ? 'Harsh braking'
                : tone === 'corner'
                  ? 'Harsh cornering'
                  : 'Over the limit'}
            </li>
          ))}
        </ul>
      </div>

      <div className="fs-events__flags">
        {FLAGS.map((flag) => (
          <article
            key={flag.title}
            data-flag
            data-at={flag.at}
            className="fs-events__flag"
            style={{ borderLeftColor: TONE_COLOR[flag.tone] }}
          >
            <h3 className="fs-events__flagtitle">{flag.title}</h3>
            <p className="fs-events__flagdetail">{flag.detail}</p>
            <p className="fs-events__flagsource">{flag.source}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
