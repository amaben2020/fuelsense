'use client';

import Link from 'next/link';
import { ArrowLeft, Check, Cpu, Minus, X } from 'lucide-react';

/**
 * What the tracker can and cannot see.
 *
 * This page exists because the honest answer to "why isn't the fleet showing
 * harsh braking?" is a hardware fact, not a bug, and a manager evaluating the
 * product deserves to read that before they buy rather than discover it after.
 * Every row names the AVL element behind the claim so the answer is checkable,
 * not a promise.
 */

type Status = 'available' | 'derivable' | 'unavailable';

interface Signal {
  id: string;
  insight: string;
  status: Status;
  elements: string;
  detail: string;
  /** What it would take to move an unavailable row into the product. */
  unlock?: string;
}

const SIGNALS: Signal[] = [
  {
    id: 'position',
    insight: 'Position, trips and distance',
    status: 'available',
    elements: 'GNSS lat/lng · AVL 16 (total odometer, metres) · AVL 240 (movement)',
    detail:
      'Every trip, stop and kilometre on the dashboard comes from these. Distance is taken from the odometer in metres and cross-checked against GPS hops, which agree to within 0.03%.',
  },
  {
    id: 'overspeeding',
    insight: 'Overspeeding',
    status: 'available',
    elements: 'AVL 24 (speed) · GNSS speed',
    detail:
      'Speed arrives with every frame and is already stored on each telemetry row, so a limit can be applied over any window without touching the device.',
  },
  {
    id: 'idling',
    insight: 'Idling and idle fuel waste',
    status: 'available',
    elements: 'AVL 239 (ignition) · AVL 24 (speed) · AVL 13 (fuel rate)',
    detail:
      'Engine on with the vehicle stationary. The tracker never sends an idling event — that scenario is not enabled — so FuelSense derives the stretches from ignition and speed, timed from the record timestamps rather than frame counts.',
  },
  {
    id: 'harsh-driving',
    insight: 'Harsh acceleration and braking',
    status: 'derivable',
    elements: 'AVL 24 (speed), sampled ~1 s apart while driving',
    detail:
      'Not sent as events, but computable: the change in speed between consecutive fixes gives acceleration directly. At the cadence this device reports while moving, a hard stop is unmistakable in the series.',
    unlock: 'Needs the derivation built — no hardware or configurator change.',
  },
  {
    id: 'cornering',
    insight: 'Harsh cornering',
    status: 'derivable',
    elements: 'gps_raw.angle (heading), stored on every device frame',
    detail:
      'Heading is captured with each frame. Rate of heading change against speed identifies a corner taken hard, without an accelerometer event.',
    unlock: 'Needs the derivation built — no hardware or configurator change.',
  },
  {
    id: 'scenario-events',
    insight: 'Crash, towing, jamming, power unplug',
    status: 'unavailable',
    elements: 'AVL 247, 246, 249, 252 — not enabled, never sent',
    detail:
      'These are device scenarios: the tracker computes them internally and emits an event only when the scenario is switched on in its configuration. This fleet sends 15 elements and none of these are among them.',
    unlock:
      'Enable the scenarios in the Teltonika configurator. No new hardware, but the device must be reconfigured.',
  },
  {
    id: 'fuel-level',
    insight: 'Fuel level in the tank',
    status: 'unavailable',
    elements: 'AVL 48 / 89 / 201 / 389 — absent, no sensor fitted',
    detail:
      'Nothing on this vehicle measures how much fuel is in the tank. During a verified 11.5 L refuel, AVL 12 sat flat at 7,514 ml through the entire fill and only rose once the engine restarted — it counts fuel burned and cannot decrease.',
    unlock:
      'A capacitive level sensor wired to the analog input, or a CAN adapter reading the vehicle bus. Roughly $60–150 per vehicle.',
  },
  {
    id: 'fuel-burn',
    insight: 'Fuel consumed',
    status: 'available',
    elements: 'AVL 12 (fuel used, ml accumulator) · AVL 13 (burn rate, L/h)',
    detail:
      'A running total of fuel burned, built from how the vehicle actually moved. It is a model, not a measurement, so every trip carries a confidence score with its reasons attached.',
  },
];

const STATUS_META: Record<
  Status,
  { label: string; icon: typeof Check; className: string; dot: string }
> = {
  available: {
    label: 'In the product',
    icon: Check,
    className: 'border-good/30 bg-good/10 text-good',
    dot: 'bg-good',
  },
  derivable: {
    label: 'Derivable from stored data',
    icon: Minus,
    className: 'border-warn/30 bg-warn-deep/10 text-warn',
    dot: 'bg-warn',
  },
  unavailable: {
    label: 'Not possible on this hardware',
    icon: X,
    className: 'border-bad-deep/40 bg-bad-deep/10 text-bad',
    dot: 'bg-bad',
  },
};

export default function SignalsDocPage() {
  return (
    <main className="min-h-screen bg-canvas px-6 py-10">
      <div className="mx-auto max-w-4xl">
        <Link
          href="/documentation"
          className="inline-flex items-center gap-1.5 text-sm text-ink-dim hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" /> Documentation
        </Link>

        <div className="mt-4 flex items-start gap-3">
          <Cpu className="mt-1 h-6 w-6 shrink-0 text-brand" />
          <div>
            <p className="font-mono text-[11px] uppercase tracking-widest text-brand">
              What the tracker can see
            </p>
            <h1 className="mt-1 text-2xl font-bold text-ink">
              Every insight, and the signal behind it
            </h1>
          </div>
        </div>

        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-ink-mid">
          A Teltonika FMC150 reports a fixed set of AVL elements, and this fleet&apos;s
          devices send exactly fifteen of them:{' '}
          <code className="font-mono text-xs text-ink">
            12, 13, 16, 21, 24, 68, 69, 181, 182, 199, 200, 239, 240, 241, 449
          </code>
          . Everything the dashboard shows is built from those, and anything that would
          need an element outside that list is marked as such below rather than estimated
          into existence.
        </p>

        <div className="mt-8 space-y-4">
          {SIGNALS.map((signal) => {
            const meta = STATUS_META[signal.status];
            const Icon = meta.icon;

            return (
              <section
                key={signal.id}
                id={signal.id}
                className="scroll-mt-6 rounded-xl border border-edge bg-panel p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <h2 className="text-base font-semibold text-ink">{signal.insight}</h2>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] ${meta.className}`}
                  >
                    <Icon className="h-3 w-3" />
                    {meta.label}
                  </span>
                </div>

                <p className="mt-3 font-mono text-xs text-ink-dim">{signal.elements}</p>
                <p className="mt-2 text-sm leading-relaxed text-ink-mid">{signal.detail}</p>

                {signal.unlock && (
                  <p className="mt-3 border-l-2 border-l-brand/50 pl-3 text-xs text-ink-dim">
                    <span className="font-medium text-ink-mid">To have it: </span>
                    {signal.unlock}
                  </p>
                )}
              </section>
            );
          })}
        </div>

        <section className="mt-10 mb-16 rounded-xl border border-edge bg-panel p-5">
          <h2 className="text-base font-semibold text-ink">Why we publish this</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-mid">
            A fuel figure the tracker cannot support is worse than no figure at all — it
            gets a driver accused, survives one round of scrutiny, and then loses the
            manager&apos;s trust in every other number on the screen. Each insight above
            either has a signal behind it or says plainly what it would take. Where the
            evidence runs out, FuelSense says so instead of guessing.
          </p>
        </section>
      </div>
    </main>
  );
}
