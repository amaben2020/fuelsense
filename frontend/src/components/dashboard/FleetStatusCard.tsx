'use client';

import { AlertOctagon, CheckCircle2, Gauge } from 'lucide-react';
import { formatNgn } from '@/lib/api';
import { IconTile } from '@/components/ui/chrome';

export type FleetStatusTone = 'good' | 'warn' | 'bad';

/** Plain-language verdict from the same 0-100 score already computed. */
export function fleetStatusWord(score: number | null): {
  word: string;
  tone: FleetStatusTone;
} {
  if (score == null) return { word: 'No data', tone: 'warn' };
  // Bands set so the spec's worked example holds: 49/100 reads "Needs
  // attention", not "Critical". Critical is reserved for a fleet that is
  // materially broken rather than one carrying a week of open alerts —
  // calling a routine backlog critical is how a status word stops meaning
  // anything.
  if (score >= 75) return { word: 'Healthy', tone: 'good' };
  if (score >= 40) return { word: 'Needs attention', tone: 'warn' };
  return { word: 'Critical', tone: 'bad' };
}

/**
 * The one card that answers "do I need to act today".
 *
 * It absorbs what used to be three peer cards — Fleet health, Preventable
 * loss and Active alerts — because they were three views of a single
 * question shown at equal weight, leaving the manager to reconcile them.
 * Worse, "Preventable loss" and the fuel card's "Over benchmark" were
 * arithmetically the same figure under two names whenever theft was zero,
 * which reads as a bug the first time somebody notices.
 *
 * The loss total now appears here and in the loss breakdown that itemises it,
 * nowhere else, and it is stated with its cause attached rather than as a bare
 * number.
 */
export function FleetStatusCard({
  score,
  concerningAlerts,
  theftAlerts,
  preventableLossNgn,
  periodDays,
  causeParts,
  harshEventCount = 0,
  onOpenDetail,
}: {
  score: number | null;
  concerningAlerts: number;
  theftAlerts: number;
  preventableLossNgn: number;
  periodDays: number;
  /** Each cause with what it cost, biggest first. */
  causeParts: Array<{ label: string; ngn: number }>;
  /** Counted, never costed — there is no honest litres-per-harsh-brake rate. */
  harshEventCount?: number;
  onOpenDetail?: () => void;
}) {
  const { word, tone } = fleetStatusWord(score);

  const accent = {
    good: 'text-good',
    warn: 'text-warn',
    bad: 'text-bad',
  }[tone];

  const edge = {
    good: 'border-good/35',
    warn: 'border-warn/35',
    bad: 'border-bad/35',
  }[tone];

  return (
    <section
      aria-label="Fleet status"
      className={`rounded-xl border ${edge} bg-panel-deep p-5 sm:p-6`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          <IconTile
            icon={tone === 'good' ? CheckCircle2 : tone === 'bad' ? AlertOctagon : Gauge}
            tone={tone}
            size={48}
          />
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-dim">
              Fleet status
            </p>
            <p className={`mt-1 text-3xl font-bold leading-none tracking-tight ${accent}`}>
              {word}
            </p>
            {/* The score and what moved it, on one line — previously the
                deductions sat in a side list and the reader did the
                subtraction themselves. */}
            <p className="mt-2 text-sm text-ink-mid">
              {score != null ? (
                <>
                  <span className="font-mono font-semibold tabular-nums text-ink">
                    {score}/100
                  </span>{' '}
                  · driven by {concerningAlerts} open alert
                  {concerningAlerts === 1 ? '' : 's'}, {theftAlerts} theft flag
                  {theftAlerts === 1 ? '' : 's'}
                </>
              ) : (
                'Not enough data to score this fleet yet'
              )}
            </p>
          </div>
        </div>

        <div className="min-w-[13rem] shrink-0">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-dim">
            Preventable loss · {periodDays}d
          </p>
          <p
            className={`mt-1 font-mono text-2xl font-bold tabular-nums ${
              preventableLossNgn > 0 ? 'text-warn' : 'text-good'
            }`}
          >
            {formatNgn(preventableLossNgn)}
          </p>
          {/* The figure broken into its parts, right under it. A manager
              should not have to open a section to learn that most of a loss
              was idling. */}
          {causeParts.length > 0 ? (
            <ul className="mt-1.5 space-y-0.5">
              {causeParts.map((p) => (
                <li
                  key={p.label}
                  className="flex items-baseline justify-between gap-3 text-xs"
                >
                  <span className="text-ink-dim">{p.label}</span>
                  <span className="font-mono tabular-nums text-ink-mid">
                    {formatNgn(p.ngn)}
                  </span>
                </li>
              ))}
              {harshEventCount > 0 && (
                <li className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="text-ink-dim">harsh events</span>
                  <span className="font-mono tabular-nums text-ink-dim">
                    {harshEventCount} · not costed
                  </span>
                </li>
              )}
            </ul>
          ) : (
            <p className="mt-1 text-xs leading-relaxed text-ink-dim">
              Nothing above the benchmark this period
            </p>
          )}
          {onOpenDetail && preventableLossNgn > 0 && (
            <button
              type="button"
              onClick={onOpenDetail}
              className="mt-2 text-xs font-medium text-accent underline decoration-dotted underline-offset-2"
            >
              See what makes this up
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
