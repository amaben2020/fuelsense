'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Clock,
  Fuel,
  Gauge,
  Info,
  MapPin,
  Route as RouteIcon,
  TrendingDown,
  TrendingUp,
  Users,
} from 'lucide-react';
import {
  DriverPeriod,
  DriverReport,
  DriverReportsResponse,
  ReportBucket,
  fetchDriverReports,
} from '@/lib/api';
import { Avatar, HatchBar, Panel, SegmentedPills, StatusChip } from '@/components/ui/chrome';
import { LoadErrorBanner } from './LoadErrorBanner';

/** "2026-08" -> "August 2026". Parsed as UTC so the label never slips a month. */
function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** A day, in the viewer's own timezone, as the `YYYY-MM-DD` a date input wants. */
function toDateInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

/**
 * The full label for a bucket, spelled out from the period's own start/end
 * rather than re-parsed from the key — an ISO week number is not something a
 * fleet manager should have to decode into dates in their head.
 */
function periodLabel(row: DriverPeriod, bucket: ReportBucket): string {
  if (bucket === 'month') return monthLabel(row.period);
  const start = new Date(`${row.period_start.slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${row.period_end.slice(0, 10)}T00:00:00Z`);
  const fmt = (d: Date, withYear: boolean) =>
    d.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      ...(withYear ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    });
  if (bucket === 'day') return fmt(start, true);
  return `${fmt(start, false)} – ${fmt(end, true)}`;
}

/** The short form that fits inside a pill. */
function periodPillLabel(row: DriverPeriod, bucket: ReportBucket): string {
  if (bucket === 'month') return monthLabel(row.period).split(' ')[0];
  const start = new Date(`${row.period_start.slice(0, 10)}T00:00:00Z`);
  return start.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

const BUCKETS: Array<{ id: ReportBucket; label: string }> = [
  { id: 'month', label: 'Month' },
  { id: 'week', label: 'Week' },
  { id: 'day', label: 'Day' },
];

/**
 * A metric with no reading is shown as an em dash. Every figure here is
 * measured from telemetry, so an absent one means the data was not there —
 * never a zero standing in for "unknown".
 */
function Metric({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | null;
  sub?: string | null;
}) {
  return (
    <div className="min-w-0 rounded-xl bg-panel-deep px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-ink-dim">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate text-[11px] font-medium uppercase tracking-wider">{label}</span>
      </div>
      <p className="mt-1.5 truncate text-xl font-bold tabular-nums tracking-tight text-ink">
        {value ?? '—'}
      </p>
      {sub && <p className="mt-0.5 truncate text-[11px] text-ink-dim">{sub}</p>}
    </div>
  );
}

function DriverCard({
  report,
  period,
  bucket,
  onViewVehicle,
}: {
  report: DriverReport;
  period: string;
  bucket: ReportBucket;
  onViewVehicle?: () => void;
}) {
  const row = report.periods.find((p) => p.period === period) ?? null;
  const previous = useMemo(() => {
    const idx = report.periods.findIndex((p) => p.period === period);
    return idx >= 0 ? (report.periods[idx + 1] ?? null) : null;
  }, [report.periods, period]);

  // Period-over-period distance, only when both periods actually have a reading.
  const trend =
    row && previous && previous.distance_km > 0
      ? ((row.distance_km - previous.distance_km) / previous.distance_km) * 100
      : null;

  const vsBaseline =
    row?.efficiency_km_l != null && row.baseline_km_l != null && row.baseline_km_l > 0
      ? ((row.efficiency_km_l - row.baseline_km_l) / row.baseline_km_l) * 100
      : null;

  return (
    /* Raised rather than flat: a soft lift and a top-light edge so the card
       reads as an object on the canvas, matching the instrument treatment. */
    <Panel className="h-full shadow-[0_18px_36px_-24px_rgba(0,0,0,0.75)] transition-shadow hover:shadow-[0_24px_44px_-22px_rgba(0,0,0,0.85)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={report.driver_name} size={56} />
          <div className="min-w-0">
            <p className="truncate text-lg font-bold tracking-tight text-ink">
              {report.driver_name}
            </p>
            <p className="truncate text-xs text-ink-dim">
              {row ? `${row.vehicles} vehicle${row.vehicles === 1 ? '' : 's'}` : 'No activity'}
              {row?.active_days ? ` · ${row.active_days} active days` : ''}
            </p>
          </div>
        </div>
        {trend != null && (
          <StatusChip tone={trend >= 0 ? 'good' : 'warn'}>
            {trend >= 0 ? (
              <TrendingUp className="h-3 w-3" />
            ) : (
              <TrendingDown className="h-3 w-3" />
            )}
            {trend >= 0 ? '+' : ''}
            {Math.round(trend)}% vs prev
          </StatusChip>
        )}
      </div>

      {!row ? (
        <p className="mt-4 rounded-xl bg-panel-deep px-3.5 py-6 text-center text-sm text-ink-dim">
          No telemetry for this {bucket}.
        </p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric
              icon={RouteIcon}
              label="Distance"
              value={`${row.distance_km.toLocaleString()} km`}
              sub={`${row.trips} trip${row.trips === 1 ? '' : 's'}`}
            />
            <Metric
              icon={Fuel}
              label="Fuel"
              value={row.fuel_liters > 0 ? `${row.fuel_liters.toFixed(1)} L` : null}
              sub={row.fuel_liters > 0 ? null : 'no level data'}
            />
            <Metric
              icon={Gauge}
              label="Economy"
              value={row.efficiency_km_l != null ? `${row.efficiency_km_l} km/L` : null}
              sub={
                row.efficiency_km_l != null
                  ? row.baseline_km_l != null
                    ? `vs ${row.baseline_km_l} baseline`
                    : null
                  : // Says why the figure is absent instead of leaving a bare dash.
                    row.fuel_complete === false
                    ? 'partial fuel data'
                    : 'not enough data'
              }
            />
            <Metric
              icon={Clock}
              label="Driving"
              value={`${row.moving_hours}h`}
              sub={row.idle_hours > 0 ? `${row.idle_hours}h idling` : null}
            />
          </div>

          {vsBaseline != null && (
            <div className="mt-3">
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <span className="text-ink-dim">Economy against vehicle baseline</span>
                <span
                  className={`font-semibold tabular-nums ${
                    vsBaseline >= 0 ? 'text-good' : 'text-warn'
                  }`}
                >
                  {vsBaseline >= 0 ? '+' : ''}
                  {Math.round(vsBaseline)}%
                </span>
              </div>
              <HatchBar
                value={row.efficiency_km_l ?? 0}
                max={Math.max(row.baseline_km_l ?? 1, row.efficiency_km_l ?? 1)}
                tone={vsBaseline >= 0 ? 'good' : 'amber'}
                showPercent={false}
              />
            </div>
          )}

          {onViewVehicle && (
            <button
              type="button"
              onClick={onViewVehicle}
              className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent-y px-4 py-2.5 text-xs font-semibold text-accent-y-ink transition-opacity hover:opacity-90"
            >
              View vehicle details <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}

          <div className="mt-3 flex items-start gap-2.5 rounded-xl bg-panel-deep px-3.5 py-3">
            <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-ink-dim" />
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">
                Most visited
              </p>
              {row.top_location ? (
                <>
                  <p className="truncate text-sm font-semibold text-ink">
                    {/* An uncached point keeps its coordinates rather than
                        borrowing a nearby name it was never matched to. */}
                    {row.top_location.name ??
                      `${row.top_location.latitude.toFixed(4)}, ${row.top_location.longitude.toFixed(4)}`}
                  </p>
                  <p className="truncate text-[11px] text-ink-dim">
                    {row.top_location.address ?? 'Location not yet geocoded'} ·{' '}
                    {row.top_location.visits} stationary fixes
                  </p>
                </>
              ) : (
                <p className="text-sm text-ink-dim">No sustained stops recorded</p>
              )}
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

export function DriverManagementPanel({ onViewVehicle }: { onViewVehicle?: () => void }) {
  const [data, setData] = useState<DriverReportsResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [bucket, setBucket] = useState<ReportBucket>('month');
  const [period, setPeriod] = useState<string | null>(null);
  // Draft values, so a half-typed date does not fire a request on every keystroke.
  const [fromInput, setFromInput] = useState('');
  const [toInput, setToInput] = useState('');
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);

  // `loading` starts true, so the first fetch does not set it synchronously
  // inside the effect — that cascades an extra render for no benefit. Only the
  // manual refresh flips it back on.
  const runFetch = useCallback(() => {
    fetchDriverReports({
      bucket,
      // An explicit range replaces the rolling window; the end date is pushed to
      // the close of that day so a same-day range still covers it.
      from: range ? `${range.from}T00:00:00` : null,
      to: range ? `${range.to}T23:59:59` : null,
    })
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [bucket, range]);

  const load = useCallback(() => {
    setLoading(true);
    runFetch();
  }, [runFetch]);

  useEffect(() => {
    runFetch();
  }, [runFetch]);

  // Every period any driver reported in, newest first, keyed to its own row so
  // labels can be spelled out from real dates.
  const periods = useMemo(() => {
    const byKey = new Map<string, DriverPeriod>();
    data?.drivers.forEach((d) => d.periods.forEach((p) => byKey.set(p.period, p)));
    return [...byKey.values()].sort((a, b) => b.period.localeCompare(a.period));
  }, [data]);

  const activePeriod = period ?? periods[0]?.period ?? null;
  const activeRow = periods.find((p) => p.period === activePeriod) ?? null;

  const fleetTotals = useMemo(() => {
    if (!data || !activePeriod) return null;
    const rows = data.drivers
      .map((d) => d.periods.find((p) => p.period === activePeriod))
      .filter((p): p is DriverPeriod => p != null);
    if (rows.length === 0) return null;
    return {
      drivers: rows.length,
      distance: rows.reduce((n, r) => n + r.distance_km, 0),
      trips: rows.reduce((n, r) => n + r.trips, 0),
      fuel: rows.reduce((n, r) => n + r.fuel_liters, 0),
    };
  }, [data, activePeriod]);

  // Changing the grain or the window invalidates whichever period was selected,
  // so both are reset together at the point of change rather than in an effect
  // reacting to them — the effect version cascades an extra render each time.
  const changeBucket = useCallback((next: ReportBucket) => {
    setBucket(next);
    setPeriod(null);
  }, []);

  const applyRange = useCallback(() => {
    if (!fromInput || !toInput || fromInput > toInput) return;
    setRange({ from: fromInput, to: toInput });
    setPeriod(null);
  }, [fromInput, toInput]);

  const clearRange = useCallback(() => {
    setFromInput('');
    setToInput('');
    setRange(null);
    setPeriod(null);
  }, []);

  const applyLastSevenDays = useCallback(() => {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - 6);
    setFromInput(toDateInput(from));
    setToInput(toDateInput(to));
    setRange({ from: toDateInput(from), to: toDateInput(to) });
    setPeriod(null);
  }, []);

  const rangeInvalid = Boolean(fromInput && toInput && fromInput > toInput);

  if (error) {
    return <LoadErrorBanner error={error} subject="driver reports" onRetry={load} />;
  }

  return (
    <div className="space-y-4">
      <Panel
        icon={Users}
        title="Driver performance"
        subtitle={
          range
            ? `Measured from vehicle telemetry — ${range.from} to ${range.to}, grouped by ${bucket}`
            : `Measured from vehicle telemetry — distance, fuel, trips and stops per ${bucket}`
        }
        onRefresh={load}
        refreshing={loading}
        actions={
          <SegmentedPills items={BUCKETS} active={bucket} onChange={changeBucket} />
        }
      >
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {periods.length > 0 && (
            <SegmentedPills
              items={periods.slice(0, 5).map((p) => ({
                id: p.period,
                label: periodPillLabel(p, bucket),
              }))}
              active={activePeriod ?? periods[0].period}
              onChange={setPeriod}
            />
          )}

          {/* Exact window. Applied on demand rather than per-keystroke, and only
              when both ends are set — a half-entered range would otherwise
              silently widen the report to everything. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              type="date"
              value={fromInput}
              max={toInput || undefined}
              onChange={(e) => setFromInput(e.target.value)}
              aria-label="Report window start"
              className={`rounded-lg border bg-panel px-2.5 py-1.5 text-xs text-ink ${
                rangeInvalid ? 'border-bad' : range ? 'border-good' : 'border-edge'
              }`}
            />
            <span className="text-xs text-ink-dim">→</span>
            <input
              type="date"
              value={toInput}
              min={fromInput || undefined}
              onChange={(e) => setToInput(e.target.value)}
              aria-label="Report window end"
              className={`rounded-lg border bg-panel px-2.5 py-1.5 text-xs text-ink ${
                rangeInvalid ? 'border-bad' : range ? 'border-good' : 'border-edge'
              }`}
            />
            <button
              type="button"
              onClick={applyRange}
              disabled={!fromInput || !toInput || rangeInvalid}
              className="rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-xs text-ink-mid transition-colors hover:bg-panel-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              Apply
            </button>
            {(range || fromInput || toInput) && (
              <button
                type="button"
                onClick={clearRange}
                className="rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-xs text-ink-dim transition-colors hover:text-ink"
                title="Clear the date range and return to the rolling window"
              >
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={applyLastSevenDays}
              className="rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-xs text-ink-mid transition-colors hover:bg-panel-hover hover:text-ink"
            >
              Last 7 days
            </button>
          </div>
        </div>

        {rangeInvalid && (
          <p className="mb-3 text-xs text-bad">The start date must not be after the end date.</p>
        )}

        {activeRow && (
          <p className="mb-3 text-xs text-ink-dim">
            Showing {periodLabel(activeRow, bucket)}
          </p>
        )}

        {fleetTotals ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric icon={Users} label="Drivers" value={String(fleetTotals.drivers)} />
            <Metric
              icon={RouteIcon}
              label="Total distance"
              value={`${Math.round(fleetTotals.distance).toLocaleString()} km`}
            />
            <Metric icon={RouteIcon} label="Trips" value={String(fleetTotals.trips)} />
            <Metric
              icon={Fuel}
              label="Fuel burned"
              value={fleetTotals.fuel > 0 ? `${fleetTotals.fuel.toFixed(1)} L` : null}
            />
          </div>
        ) : loading ? (
          <div
            className="grid grid-cols-2 gap-2 sm:grid-cols-4"
            role="status"
            aria-live="polite"
            aria-label="Loading driver activity"
          >
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="min-w-0 rounded-xl bg-panel-deep px-3.5 py-3">
                <span className="skeleton-shimmer block h-2.5 w-16 rounded-full" />
                <span className="skeleton-shimmer mt-2 block h-5 w-12 rounded" />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-dim">No driver activity recorded yet.</p>
        )}

        {/* Stated plainly: the tracker cannot identify who was behind the wheel. */}
        <p className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-ink-dim">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Attributed through each vehicle&apos;s current driver assignment — the tracker reports
          the vehicle, not who was driving it. Reassigning a vehicle reattributes its whole {bucket}.
        </p>
      </Panel>

      {activePeriod && data && data.drivers.length > 0 && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {data.drivers.map((d) => (
            <DriverCard
              key={d.driver_name}
              report={d}
              period={activePeriod}
              bucket={bucket}
              onViewVehicle={onViewVehicle}
            />
          ))}
        </div>
      )}
    </div>
  );
}
