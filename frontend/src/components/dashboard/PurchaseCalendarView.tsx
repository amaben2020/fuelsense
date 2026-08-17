'use client';

import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { FuelPurchase, formatNgn } from '@/lib/api';

const TZ = 'Africa/Lagos';
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_CHIPS_PER_DAY = 3;
const TIP_WIDTH = 220;
const TIP_FLIP_MARGIN = 160;

function dateKey(iso: string) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
}

function shortTime(iso: string) {
  return new Date(iso)
    .toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ })
    .replace(' ', '');
}

function firstName(name?: string | null) {
  if (!name) return 'Unassigned';
  return name.split(' ')[0];
}

/** Monday-first grid covering every day shown for `monthCursor`'s month. */
function buildMonthGrid(monthCursor: Date): Date[] {
  const year = monthCursor.getFullYear();
  const month = monthCursor.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  // Monday = 0 ... Sunday = 6
  const leadingOffset = (firstOfMonth.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - leadingOffset);

  const days: Date[] = [];
  for (let i = 0; i < 42; i += 1) {
    days.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  }
  // Six full weeks is one week too many for most months — drop the last row
  // when it holds nothing from the target month.
  const lastRowStart = 35;
  const lastRowInMonth = days
    .slice(lastRowStart)
    .some((d) => d.getMonth() === month);
  return lastRowInMonth ? days : days.slice(0, 35);
}

interface DayTooltip {
  x: number;
  y: number;
  above: boolean;
  dateLabel: string;
  totalNgn: number;
  count: number;
}

export function PurchaseCalendarView({
  purchases,
  onViewEvent,
}: {
  purchases: FuelPurchase[];
  onViewEvent: (purchase: FuelPurchase) => void;
}) {
  const [monthCursor, setMonthCursor] = useState(() => {
    const latest = purchases[0]?.purchased_at ?? purchases[0]?.timestamp;
    const base = latest ? new Date(latest) : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [tooltip, setTooltip] = useState<DayTooltip | null>(null);

  const byDay = useMemo(() => {
    const map = new Map<string, FuelPurchase[]>();
    for (const purchase of purchases) {
      const key = dateKey(purchase.purchased_at ?? purchase.timestamp);
      const list = map.get(key) ?? [];
      list.push(purchase);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          new Date(a.purchased_at ?? a.timestamp).getTime() -
          new Date(b.purchased_at ?? b.timestamp).getTime()
      );
    }
    return map;
  }, [purchases]);

  const grid = useMemo(() => buildMonthGrid(monthCursor), [monthCursor]);
  const todayKey = dateKey(new Date().toISOString());
  const monthLabel = monthCursor.toLocaleDateString('en-NG', {
    month: 'long',
    year: 'numeric',
    timeZone: TZ,
  });

  const showTooltip = (event: { currentTarget: HTMLElement }, key: string, dateLabel: string) => {
    const dayPurchases = byDay.get(key) ?? [];
    if (!dayPurchases.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const above = window.innerHeight - rect.bottom < TIP_FLIP_MARGIN;
    setTooltip({
      x: Math.max(16, Math.min(rect.left, window.innerWidth - TIP_WIDTH - 16)),
      y: above ? rect.top - 8 : rect.bottom + 8,
      above,
      dateLabel,
      totalNgn: dayPurchases.reduce((sum, p) => sum + p.total_cost_ngn, 0),
      count: dayPurchases.length,
    });
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between">
        <p className="font-semibold text-ink">{monthLabel}</p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMonthCursor((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
            className="rounded-lg border border-edge p-1.5 text-ink-dim hover:border-brand hover:text-ink"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setMonthCursor(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
            className="rounded-lg border border-edge px-2.5 py-1.5 text-xs font-medium text-ink-dim hover:border-brand hover:text-ink"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => setMonthCursor((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
            className="rounded-lg border border-edge p-1.5 text-ink-dim hover:border-brand hover:text-ink"
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-edge bg-edge">
        {WEEKDAY_LABELS.map((label) => (
          <div
            key={label}
            className="bg-canvas px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-ink-dim"
          >
            {label}
          </div>
        ))}
        {grid.map((date) => {
          const key = dateKey(date.toISOString());
          const inMonth = date.getMonth() === monthCursor.getMonth();
          const isToday = key === todayKey;
          const dayPurchases = byDay.get(key) ?? [];
          const dayTotal = dayPurchases.reduce((sum, p) => sum + p.total_cost_ngn, 0);
          const overflow = dayPurchases.length - MAX_CHIPS_PER_DAY;
          const dateLabel = date.toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
            timeZone: TZ,
          });

          return (
            <div
              key={key}
              onMouseEnter={(e) => showTooltip(e, key, dateLabel)}
              onMouseLeave={() => setTooltip(null)}
              className={`min-h-[6.5rem] bg-panel p-1.5 ${inMonth ? '' : 'bg-panel/40'}`}
            >
              <span
                className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                  isToday
                    ? 'bg-brand font-semibold text-accent-y-ink'
                    : inMonth
                      ? 'text-ink-mid'
                      : 'text-ink-dim/50'
                }`}
              >
                {date.getDate()}
              </span>
              <div className="mt-1 space-y-1">
                {dayPurchases.slice(0, MAX_CHIPS_PER_DAY).map((purchase) => (
                  <button
                    key={purchase.id}
                    type="button"
                    onClick={() => onViewEvent(purchase)}
                    title={`${firstName(purchase.driver_name)} · ${shortTime(
                      purchase.purchased_at ?? purchase.timestamp
                    )} · ${formatNgn(purchase.total_cost_ngn)}`}
                    className={`block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] leading-tight ${
                      purchase.status === 'flagged_theft'
                        ? 'bg-bad-deep/25 text-bad'
                        : purchase.status === 'pending_receipt'
                          ? 'bg-warn-deep/20 text-warn'
                          : 'bg-good/15 text-good'
                    } hover:opacity-80`}
                  >
                    {shortTime(purchase.purchased_at ?? purchase.timestamp)} · {firstName(purchase.driver_name)}
                  </button>
                ))}
                {overflow > 0 && (
                  <p className="px-1.5 text-[11px] text-ink-dim">+{overflow} more</p>
                )}
              </div>
              {dayTotal > 0 && (
                <p className="mt-1 truncate px-1.5 font-mono text-[10px] text-ink-dim">
                  {formatNgn(dayTotal)}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {tooltip &&
        createPortal(
          <div
            role="tooltip"
            style={{
              left: tooltip.x,
              top: tooltip.y,
              width: TIP_WIDTH,
              transform: tooltip.above ? 'translateY(-100%)' : undefined,
            }}
            className="pointer-events-none fixed z-[70] rounded-md border border-edge bg-panel-deep p-3 shadow-xl"
          >
            <p className="text-xs font-semibold text-ink">{tooltip.dateLabel}</p>
            <p className="mt-1 font-mono text-sm font-semibold text-brand">
              {formatNgn(tooltip.totalNgn)}
            </p>
            <p className="mt-0.5 text-[11px] text-ink-dim">
              {tooltip.count} {tooltip.count === 1 ? 'receipt' : 'receipts'}
            </p>
          </div>,
          document.body
        )}
    </div>
  );
}
