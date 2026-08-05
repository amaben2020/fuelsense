'use client';

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

// A calendar built for the job, replacing two native datetime-local inputs.
//
// The native control renders differently in every browser, ignores the dark
// theme entirely, and makes "last week" a four-field typing exercise. Picking
// a range on a fleet dashboard is nearly always one of a handful of shapes, so
// the presets do the common cases in one click and the grid handles the rest.

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export interface DateRange {
  from: string;
  to: string;
}

interface Preset {
  label: string;
  /** Whole days back from today, inclusive of today. */
  days: number;
}

const PRESETS: Preset[] = [
  { label: 'Today', days: 1 },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
];

const startOfDay = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

const endOfDay = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Cells for a month grid, padded so the first row starts on a Monday. */
function monthGrid(month: Date): Array<Date | null> {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  // getDay() is Sunday-first; this fleet reads Monday-first calendars.
  const lead = (first.getDay() + 6) % 7;

  return [
    ...Array.from({ length: lead }, () => null),
    ...Array.from(
      { length: daysInMonth },
      (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1)
    ),
  ];
}

const formatMonth = (date: Date): string =>
  date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

const formatDay = (date: Date): string =>
  date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export function DateRangePicker({
  value,
  onApply,
  onClear,
}: {
  value: DateRange | null;
  onApply: (range: DateRange) => void;
  onClear: () => void;
}) {
  const today = useMemo(() => new Date(), []);
  const [month, setMonth] = useState(() =>
    value ? new Date(value.from) : new Date(today.getFullYear(), today.getMonth(), 1)
  );
  const [from, setFrom] = useState<Date | null>(value ? new Date(value.from) : null);
  const [to, setTo] = useState<Date | null>(value ? new Date(value.to) : null);

  const cells = useMemo(() => monthGrid(month), [month]);

  /** Click one: start a range. Click two: close it, ordering the pair. */
  const pick = (day: Date) => {
    if (!from || (from && to)) {
      setFrom(day);
      setTo(null);
      return;
    }
    if (day < from) {
      setTo(from);
      setFrom(day);
      return;
    }
    setTo(day);
  };

  const applyPreset = (preset: Preset) => {
    const end = today;
    const start = new Date(today);
    start.setDate(start.getDate() - (preset.days - 1));
    setFrom(start);
    setTo(end);
    setMonth(new Date(start.getFullYear(), start.getMonth(), 1));
  };

  const inRange = (day: Date): boolean => {
    if (!from || !to) return false;
    return day > startOfDay(from) && day < startOfDay(to);
  };

  const ready = Boolean(from && to);

  return (
    <div className="w-[19rem] rounded-xl border border-edge bg-panel/95 p-3 shadow-2xl backdrop-blur">
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => applyPreset(preset)}
            className="rounded-md border border-edge px-2 py-1 text-[11px] text-ink-dim transition-colors hover:border-brand hover:text-ink"
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
          className="rounded-md p-1 text-ink-dim transition-colors hover:bg-panel-hover hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <p className="text-xs font-semibold text-ink">{formatMonth(month)}</p>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
          className="rounded-md p-1 text-ink-dim transition-colors hover:bg-panel-hover hover:text-ink"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2 grid grid-cols-7 gap-y-1 text-center">
        {WEEKDAYS.map((day, i) => (
          <span key={`${day}-${i}`} className="text-[10px] uppercase text-ink-dim">
            {day}
          </span>
        ))}

        {cells.map((day, i) => {
          if (!day) return <span key={`pad-${i}`} />;

          const isFrom = from && sameDay(day, from);
          const isTo = to && sameDay(day, to);
          const isEdge = isFrom || isTo;
          const between = inRange(day);
          // Telemetry cannot exist in the future, so those days are dead.
          const future = startOfDay(day) > startOfDay(today);

          return (
            <button
              key={day.toISOString()}
              type="button"
              disabled={future}
              onClick={() => pick(day)}
              aria-pressed={Boolean(isEdge)}
              className={`mx-auto flex h-8 w-8 items-center justify-center rounded-md text-xs transition-colors ${
                isEdge
                  ? 'bg-brand font-semibold text-canvas'
                  : between
                    ? 'bg-brand/15 text-ink'
                    : future
                      ? 'text-ink-dim/30'
                      : 'text-ink-mid hover:bg-panel-hover hover:text-ink'
              } ${sameDay(day, today) && !isEdge ? 'ring-1 ring-inset ring-edge' : ''}`}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>

      <p className="mt-3 text-[11px] text-ink-dim">
        {from && to
          ? `${formatDay(from)} to ${formatDay(to)}`
          : from
            ? `${formatDay(from)}, now pick the end`
            : 'Pick a start day'}
      </p>

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={!ready}
          onClick={() => {
            if (!from || !to) return;
            // Whole days: a range that ends at midnight would silently drop the
            // final day's driving.
            onApply({ from: startOfDay(from).toISOString(), to: endOfDay(to).toISOString() });
          }}
          className="flex-1 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-opacity disabled:opacity-40"
        >
          Apply
        </button>
        <button
          type="button"
          onClick={() => {
            setFrom(null);
            setTo(null);
            onClear();
          }}
          className="rounded-md border border-edge px-3 py-1.5 text-xs text-ink-mid transition-colors hover:text-ink"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
