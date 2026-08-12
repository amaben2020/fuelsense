'use client';

import { useEffect, useMemo, useState } from 'react';
import { Route } from 'lucide-react';
import { DailyActivityResponse, DailyActivityRow, api, formatNgn } from '@/lib/api';
import { IconTile } from '@/components/ui/chrome';

/**
 * Where the fleet's kilometres actually went.
 *
 * The Fleet health tile beside this one is a single score with a lot of empty
 * card around it, and "96 km this period" on its own tells a manager nothing
 * they can act on. Every line below breaks that total into a question they
 * might actually ask: how many runs was it, which day carried the load, how
 * far a typical run goes, and how much of the engine's time was spent going
 * nowhere.
 *
 * Sourced from `/telemetry/daily-activity`, the same per-vehicle-per-day
 * aggregate the activity table uses, so the two can never disagree. Distance
 * there is odometer-derived rather than integrated from GPS positions.
 *
 * Deliberately absent: longest single trip. Trip *counts* come from ignition
 * edges in that aggregate, but individual trip distances only exist once the
 * readings are segmented by `/telemetry/trips`, which returns full GPS paths
 * for the live map and answers a different time window. Fetching it here would
 * put a distance on screen that disagreed with the total directly above it, so
 * the card shows the typical run instead of guessing at the longest.
 */
export function DistanceBreakdownCard({
  periodDays,
  idleHours,
  idleCostNgn,
  className = '',
}: {
  periodDays: number;
  /** From the efficiency summary, so idling matches the fuel card exactly. */
  idleHours?: number | null;
  idleCostNgn?: number | null;
  className?: string;
}) {
  const [rows, setRows] = useState<DailyActivityRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  // State is only touched after the await, and a stale response from a
  // previous period is discarded rather than overwriting the current one.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        // A high page size rather than paging: this is one aggregate figure,
        // and a partial page would silently under-count the total.
        const result = await api<DailyActivityResponse>(
          `/telemetry/daily-activity?days=${periodDays}&page=1&limit=500`
        );
        if (!live) return;
        setRows(result.rows ?? []);
        setFailed(false);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [periodDays]);

  const stats = useMemo(() => {
    if (!rows?.length) return null;

    const totalKm = rows.reduce((sum, r) => sum + (r.distance_km ?? 0), 0);
    const totalTrips = rows.reduce((sum, r) => sum + (r.trip_count ?? 0), 0);

    // Rows are per vehicle per day, so a fleet day spans several rows and the
    // busiest day is the sum across them, not the biggest single row.
    const byDate = new globalThis.Map<string, number>();
    for (const r of rows) {
      const key = r.activity_date.slice(0, 10);
      byDate.set(key, (byDate.get(key) ?? 0) + (r.distance_km ?? 0));
    }
    const busiest = [...byDate.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;

    return {
      totalKm,
      totalTrips,
      activeDays: byDate.size,
      busiestDate: busiest?.[0] ?? null,
      busiestKm: busiest?.[1] ?? 0,
      // Only meaningful once there is a trip to divide by; an ignition edge
      // that never moved would otherwise read as a zero-kilometre journey.
      avgTripKm: totalTrips > 0 ? totalKm / totalTrips : null,
    };
  }, [rows]);

  const dayLabel = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });

  return (
    <div
      className={`flex flex-col rounded-xl border border-edge bg-panel p-5 ${className}`}
    >
      <div className="flex items-center gap-3">
        <IconTile icon={Route} tone="neutral" />
        <p className="text-xs font-medium uppercase tracking-[0.1em] text-ink-dim">
          Distance · {periodDays}d
        </p>
      </div>

      {failed ? (
        <p className="mt-4 text-sm text-ink-dim">Could not load activity</p>
      ) : !stats ? (
        <p className="mt-4 text-sm text-ink-dim">
          {rows ? 'No distance recorded in this period' : 'Loading…'}
        </p>
      ) : (
        <>
          <p className="mt-3 text-4xl font-bold leading-none tracking-tight tabular-nums text-ink">
            {Math.round(stats.totalKm).toLocaleString()}{' '}
            <span className="text-xl font-semibold text-ink-mid">km</span>
          </p>
          <p className="mt-1.5 text-sm text-ink-mid tabular-nums">
            {stats.totalTrips.toLocaleString()} trip
            {stats.totalTrips === 1 ? '' : 's'} over {stats.activeDays} active day
            {stats.activeDays === 1 ? '' : 's'}
          </p>

          <dl className="mt-4 space-y-2 border-t border-edge pt-4 text-sm">
            {stats.busiestDate && (
              <Row
                label="Busiest day"
                value={`${dayLabel(stats.busiestDate)} · ${Math.round(stats.busiestKm)} km`}
              />
            )}
            <Row
              label="Typical trip"
              value={stats.avgTripKm != null ? `${stats.avgTripKm.toFixed(1)} km` : '—'}
            />
            {idleHours != null && idleHours > 0 && (
              <Row
                label="Engine idling"
                value={`${formatHours(idleHours)}${
                  idleCostNgn ? ` · ${formatNgn(idleCostNgn)}` : ''
                }`}
                tone="warn"
              />
            )}
          </dl>

          <p className="mt-auto pt-4 text-[11px] leading-relaxed text-ink-dim">
            Distance is odometer-derived. Trips are counted from ignition
            starts, so a stop with the engine cut splits one journey in two.
          </p>
        </>
      )}
    </div>
  );
}

function formatHours(hours: number) {
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function Row({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'warn';
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-dim">{label}</dt>
      <dd
        className={`font-mono tabular-nums ${
          tone === 'warn' ? 'text-warn' : 'text-ink'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
