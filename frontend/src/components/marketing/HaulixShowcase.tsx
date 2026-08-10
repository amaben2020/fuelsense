'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import { gsap } from 'gsap';
import {
  BatteryCharging,
  Cpu,
  Fuel,
  Gauge,
  MapPin,
  Radio,
  Route,
  Zap,
} from 'lucide-react';
import { useGsapScope } from './useScrollReveal';

// Every model is client-only: three.js needs a DOM, and loading four WebGL
// scenes eagerly would stall the landing page's first paint.
const Vehicle3D = dynamic(
  () => import('@/components/dashboard/Vehicle3D').then((m) => m.Vehicle3D),
  { ssr: false, loading: () => <ModelSkeleton /> }
);
const Battery3D = dynamic(
  () => import('@/components/dashboard/Battery3D').then((m) => m.Battery3D),
  { ssr: false, loading: () => <ModelSkeleton /> }
);
const Tracker3D = dynamic(
  () => import('@/components/dashboard/Tracker3D').then((m) => m.Tracker3D),
  { ssr: false, loading: () => <ModelSkeleton /> }
);

function ModelSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <span className="h-8 w-8 animate-pulse rounded-full bg-brand/20" />
    </div>
  );
}

/** Live-looking readouts from the real vehicle in the demo fleet. */
const SPECS: { icon: typeof Gauge; label: string; value: string; note: string }[] = [
  { icon: Route, label: 'Odometer', value: '50,829', note: 'miles, anchored to the dash' },
  { icon: Fuel, label: 'Fuel level', value: '19.1 L', note: '32% of tank · modelled' },
  { icon: Zap, label: 'Vehicle battery', value: '12.2 V', note: 'read every fix' },
  { icon: BatteryCharging, label: 'Backup cell', value: '3.8 V', note: 'survives power cuts' },
  { icon: Radio, label: 'Reporting', value: '15 s', note: 'while the engine runs' },
  { icon: MapPin, label: 'Position', value: '±5 m', note: 'GNSS with DOP filtering' },
];

const MODELS = [
  {
    id: 'tracker' as const,
    icon: Cpu,
    title: 'The tracker',
    copy: 'A Teltonika FMC150 wired behind the dash. It reads GPS, ignition and its own fuel counter, then streams them over the mobile network.',
  },
  {
    id: 'battery' as const,
    icon: Zap,
    title: 'The vehicle battery',
    copy: 'Read on every position fix. A failing battery shows up as sagging voltage long before it strands a driver in traffic.',
  },
  {
    id: 'cell' as const,
    icon: BatteryCharging,
    title: 'The backup cell',
    copy: 'A Li-ion cell inside the tracker. Cut power to the vehicle and it keeps reporting — which is what turns a silent disconnection into an alert.',
  },
];

export function HaulixShowcase() {
  const [model, setModel] = useState<'tracker' | 'battery' | 'cell'>('tracker');

  const scope = useGsapScope(({ scope }) => {
    // Headline and copy lift in.
    gsap.from(gsap.utils.toArray<HTMLElement>('[data-hx-reveal]', scope), {
      opacity: 0,
      y: 30,
      duration: 0.8,
      ease: 'power3.out',
      stagger: 0.09,
      scrollTrigger: { trigger: scope, start: 'top 72%', once: true },
    });

    // The vehicle stage rises and settles as the section scrolls through —
    // parallax rather than a one-shot fade, so the model feels anchored to the
    // page rather than pasted on it.
    const stage = scope.querySelector<HTMLElement>('[data-hx-stage]');
    if (stage) {
      gsap.fromTo(
        stage,
        { y: 70, scale: 0.94, opacity: 0 },
        {
          y: 0,
          scale: 1,
          opacity: 1,
          duration: 1.1,
          ease: 'power3.out',
          scrollTrigger: { trigger: stage, start: 'top 85%', once: true },
        }
      );
      gsap.to(stage, {
        yPercent: -8,
        ease: 'none',
        scrollTrigger: { trigger: scope, start: 'top bottom', end: 'bottom top', scrub: 0.6 },
      });
    }

    // Spec tiles deal themselves in on a stagger.
    gsap.from(gsap.utils.toArray<HTMLElement>('[data-hx-spec]', scope), {
      opacity: 0,
      y: 24,
      duration: 0.6,
      ease: 'power2.out',
      stagger: 0.06,
      scrollTrigger: { trigger: '[data-hx-specs]', start: 'top 85%', once: true },
    });

    // Hairline rules draw themselves left-to-right.
    gsap.from(gsap.utils.toArray<HTMLElement>('[data-hx-rule]', scope), {
      scaleX: 0,
      transformOrigin: 'left center',
      duration: 0.9,
      ease: 'power2.out',
      stagger: 0.08,
      scrollTrigger: { trigger: '[data-hx-specs]', start: 'top 85%', once: true },
    });
  });

  const active = MODELS.find((m) => m.id === model)!;

  return (
    <section
      ref={scope}
      className="relative overflow-hidden bg-canvas py-24 text-ink sm:py-32"
    >
      {/* Lemon bloom behind the stage, echoing the map's vehicle puck. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_50%_40%_at_50%_35%,color-mix(in_srgb,var(--brand)_10%,transparent),transparent_70%)]"
      />

      <div className="relative mx-auto max-w-6xl px-6">
        <p
          data-hx-reveal
          className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brand"
        >
          What you are actually buying
        </p>
        <h2
          data-hx-reveal
          className="mt-4 max-w-2xl text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl"
        >
          Every part of the vehicle, accounted for.
        </h2>
        <p data-hx-reveal className="mt-5 max-w-xl text-base leading-relaxed text-ink-mid">
          One tracker, wired to the battery, watching fuel, distance and power. Drag the vehicle
          to look around — the markers are the same ones your fleet manager taps in the dashboard.
        </p>

        {/* Vehicle stage */}
        <div
          data-hx-stage
          className="relative mt-14 overflow-hidden rounded-3xl border border-edge bg-panel"
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_40%,color-mix(in_srgb,var(--brand)_8%,transparent),transparent_70%)]"
          />
          <div className="relative h-[380px] cursor-grab active:cursor-grabbing sm:h-[460px]">
            <Vehicle3D plate="FLEET-01" model="RAV4" />
          </div>
          <div className="relative flex flex-wrap items-center justify-between gap-3 border-t border-edge bg-panel-deep/70 px-6 py-4 text-xs text-ink-dim">
            <span className="flex items-center gap-1.5">
              <Gauge className="h-3.5 w-3.5" />
              Drag to rotate · scroll to zoom
            </span>
            <span className="flex items-center gap-1.5">
              <Radio className="h-3.5 w-3.5 text-brand" />
              Live telemetry, not a render loop
            </span>
          </div>
        </div>

        {/* Specs */}
        <div data-hx-specs className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-3">
          {SPECS.map((s) => (
            <div
              key={s.label}
              data-hx-spec
              className="rounded-2xl border border-edge bg-panel p-4 transition-colors hover:border-brand/40"
            >
              <div className="flex items-center gap-2 text-ink-dim">
                <s.icon className="h-3.5 w-3.5" />
                <span className="text-[10px] font-semibold uppercase tracking-wider">
                  {s.label}
                </span>
              </div>
              <p className="mt-2 font-mono text-2xl font-bold tabular-nums text-ink">{s.value}</p>
              <span data-hx-rule className="mt-2 block h-px w-full bg-edge" />
              <p className="mt-2 text-[11px] text-ink-dim">{s.note}</p>
            </div>
          ))}
        </div>

        {/* Component switcher */}
        <div className="mt-20 grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-center">
          <div>
            <p
              data-hx-reveal
              className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brand"
            >
              The hardware
            </p>
            <h3 data-hx-reveal className="mt-4 text-3xl font-bold tracking-tight">
              Three components, one story.
            </h3>

            <div className="mt-7 flex flex-wrap gap-2">
              {MODELS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setModel(m.id)}
                  className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold transition ${
                    model === m.id
                      ? 'bg-brand text-canvas'
                      : 'border border-edge text-ink-mid hover:border-brand/40 hover:text-ink'
                  }`}
                >
                  <m.icon className="h-3.5 w-3.5" />
                  {m.title}
                </button>
              ))}
            </div>

            <p key={active.id} className="mt-6 max-w-md text-base leading-relaxed text-ink-mid">
              {active.copy}
            </p>
          </div>

          <div className="relative h-[320px] overflow-hidden rounded-3xl border border-edge bg-panel sm:h-[380px]">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_55%_45%_at_50%_45%,color-mix(in_srgb,var(--brand)_9%,transparent),transparent_70%)]"
            />
            {/* Keyed so switching genuinely remounts the scene rather than
                mutating a model into a different object mid-spin. */}
            <div key={model} className="relative h-full w-full">
              {model === 'tracker' && <Tracker3D online />}
              {model === 'battery' && (
                <Battery3D variant="vehicle" charge={0.72} tone="good" />
              )}
              {model === 'cell' && (
                <Battery3D variant="cell" charge={0.23} tone="warn" charging />
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
