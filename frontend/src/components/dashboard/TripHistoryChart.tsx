'use client';

import { useMemo, useState } from 'react';
import { formatNgn } from '@/lib/api';

export type TripDay = {
  /** ISO date, YYYY-MM-DD. */
  day: string;
  trips: number;
  km: number;
  fuel: number;
  cost: number | null;
};

type Metric = 'km' | 'fuel' | 'cost';

const METRICS: { id: Metric; label: string; axis: (v: number) => string }[] = [
  { id: 'km', label: 'Distance', axis: (v) => `${round(v)} km` },
  { id: 'fuel', label: 'Fuel', axis: (v) => `${round(v)} L` },
  { id: 'cost', label: 'Cost', axis: (v) => formatNgn(Math.round(v)) },
];

function round(v: number) {
  return Math.round(v * 10) / 10;
}

/**
 * Axis ticks land on clean numbers, so the gridlines mean something.
 *
 * The step list is deliberately fine-grained. With only [1, 2, 2.5, 5, 10] a
 * 55.6 km peak rounds up to a 100 km ceiling and the tallest bar uses half the
 * plot — the chart reads as a quiet week when it was not one. Every step here
 * still halves into a clean mid-tick.
 */
function niceCeiling(max: number): number {
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const candidate = step * magnitude;
    if (candidate >= max) return candidate;
  }
  return 10 * magnitude;
}

function dayLabel(iso: string) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Africa/Lagos',
  });
}

function weekdayLabel(iso: string) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-NG', {
    weekday: 'short',
    timeZone: 'Africa/Lagos',
  });
}

/**
 * The window's shape, one column per day.
 *
 * The table answers "what happened on this trip"; it cannot answer "is this
 * week heavier than last" or "which day did the cost come from" without the
 * reader adding up rows in their head. That is the whole job here.
 *
 * One measure at a time, deliberately. Distance, litres and naira have no
 * common scale, and plotting two of them against two axes invents a
 * correlation that is not in the data.
 */
export function TripHistoryChart({ days }: { days: TripDay[] }) {
  const [metric, setMetric] = useState<Metric>('km');
  const [hover, setHover] = useState<string | null>(null);

  const active = METRICS.find((m) => m.id === metric) ?? METRICS[0];

  const values = useMemo(
    () => days.map((d) => (metric === 'cost' ? (d.cost ?? 0) : d[metric])),
    [days, metric]
  );

  const max = Math.max(0, ...values);
  const ceiling = niceCeiling(max);
  const peakIndex = values.indexOf(max);

  // Cost is null across the board until a receipt sets a real price per litre,
  // so offering the tab would be offering an empty chart.
  const costAvailable = days.some((d) => d.cost != null);
  const metrics = METRICS.filter((m) => m.id !== 'cost' || costAvailable);

  const total = values.reduce((s, v) => s + v, 0);
  const activeDays = days.filter((d) => d.trips > 0).length;

  if (days.length === 0) {
    return (
      <p className="rounded-xl bg-panel-deep px-4 py-10 text-center text-sm text-ink-dim">
        No journeys in this window, so there is nothing to plot.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">
            {active.axis(total)}
            <span className="ml-2 text-xs font-normal text-ink-dim">
              across {activeDays} {activeDays === 1 ? 'day' : 'days'} with journeys
            </span>
          </p>
          <p className="mt-0.5 text-[11px] text-ink-dim">
            Days without a journey are shown as zero, not skipped.
          </p>
        </div>

        {/* One measure at a time — never two scales on one plot. */}
        <div className="flex gap-2" role="group" aria-label="Chart measure">
          {metrics.map((m) => (
            <button
              key={m.id}
              type="button"
              aria-pressed={metric === m.id}
              onClick={() => setMetric(m.id)}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                metric === m.id
                  ? 'border-good bg-good/10 text-good'
                  : 'border-edge bg-canvas text-ink-mid hover:bg-panel-hover'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-3">
        {/* Y axis. Ticks carry the values no bar is directly labelled with. */}
        <div className="flex h-56 w-14 shrink-0 flex-col justify-between py-px text-right text-[10px] tabular-nums text-ink-dim">
          {[1, 0.5, 0].map((f) => (
            <span key={f}>{active.axis(ceiling * f)}</span>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          <div className="relative h-56">
            {/* Hairline, solid, one step off the surface — recessive. */}
            {[0, 0.5, 1].map((f) => (
              <div
                key={f}
                aria-hidden
                className="absolute inset-x-0 border-t border-divider"
                style={{ top: `${f * 100}%` }}
              />
            ))}

            <ol className="absolute inset-0 flex items-end gap-[2px]">
              {days.map((d, i) => {
                const value = values[i];
                const pct = ceiling > 0 ? (value / ceiling) * 100 : 0;
                const isPeak = i === peakIndex && value > 0;
                const isHover = hover === d.day;
                return (
                  <li key={d.day} className="relative flex h-full min-w-0 flex-1 items-end">
                    {/* The hit target is the whole column, not the painted bar —
                        a 3%-tall bar is otherwise unhoverable. */}
                    <button
                      type="button"
                      onMouseEnter={() => setHover(d.day)}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => setHover(d.day)}
                      onBlur={() => setHover(null)}
                      aria-label={`${dayLabel(d.day)}: ${active.axis(value)}, ${d.trips} ${
                        d.trips === 1 ? 'trip' : 'trips'
                      }`}
                      className="absolute inset-0 flex items-end justify-center focus:outline-none"
                    >
                      <span
                        aria-hidden
                        className={`w-full max-w-6 rounded-t-[4px] transition-opacity ${
                          isHover ? 'opacity-100' : 'opacity-85'
                        }`}
                        style={{
                          height: `${Math.max(pct, value > 0 ? 1.5 : 0)}%`,
                          background: 'var(--chart-bar)',
                          // A day with no journey is a real zero, and should
                          // look like one rather than like missing data.
                          ...(value === 0
                            ? { height: '2px', background: 'var(--edge)', borderRadius: 0 }
                            : null),
                        }}
                      />
                    </button>

                    {/* Labelled selectively: the peak only. A number on every
                        column is noise, and the axis carries the rest. */}
                    {isPeak && !isHover && (
                      <span
                        aria-hidden
                        className="pointer-events-none absolute inset-x-0 text-center text-[10px] font-semibold tabular-nums text-ink"
                        style={{ bottom: `calc(${pct}% + 4px)` }}
                      >
                        {active.axis(value)}
                      </span>
                    )}

                    {isHover && (
                      <div
                        role="tooltip"
                        className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 w-max -translate-x-1/2 rounded-lg border border-edge bg-panel px-2.5 py-1.5 shadow-lg"
                      >
                        {/* Value leads, label follows — the reader has the day
                            and wants the number. */}
                        <p className="text-sm font-semibold tabular-nums text-ink">
                          {active.axis(value)}
                        </p>
                        <p className="whitespace-nowrap text-[10px] text-ink-dim">
                          {dayLabel(d.day)} · {d.trips} {d.trips === 1 ? 'trip' : 'trips'}
                        </p>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>

          {/* X axis. Every label collides once a month is in view, so they thin
              out to whatever the width can carry. */}
          <ol className="mt-1.5 flex gap-[2px]" aria-hidden>
            {days.map((d, i) => {
              const stride = Math.ceil(days.length / 10);
              const show = i % stride === 0 || i === days.length - 1;
              return (
                <li
                  key={d.day}
                  className="min-w-0 flex-1 text-center text-[10px] text-ink-dim"
                >
                  {show && (
                    <span className="block truncate">
                      {days.length > 10 ? dayLabel(d.day) : weekdayLabel(d.day)}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}
