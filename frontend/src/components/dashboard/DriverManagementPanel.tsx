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
  DriverMonth,
  DriverReport,
  DriverReportsResponse,
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
  month,
  onViewVehicle,
}: {
  report: DriverReport;
  month: string;
  onViewVehicle?: () => void;
}) {
  const row = report.months.find((m) => m.month === month) ?? null;
  const previous = useMemo(() => {
    const idx = report.months.findIndex((m) => m.month === month);
    return idx >= 0 ? (report.months[idx + 1] ?? null) : null;
  }, [report.months, month]);

  // Month-over-month distance, only when both months actually have a reading.
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
          No telemetry for {monthLabel(month)}.
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
  const [month, setMonth] = useState<string | null>(null);

  // `loading` starts true, so the first fetch does not set it synchronously
  // inside the effect — that cascades an extra render for no benefit. Only the
  // manual refresh flips it back on.
  const runFetch = useCallback(() => {
    fetchDriverReports(6)
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    runFetch();
  }, [runFetch]);

  useEffect(() => {
    runFetch();
  }, [runFetch]);

  // Every month any driver reported in, newest first.
  const months = useMemo(() => {
    const set = new Set<string>();
    data?.drivers.forEach((d) => d.months.forEach((m) => set.add(m.month)));
    return [...set].sort().reverse();
  }, [data]);

  const activeMonth = month ?? months[0] ?? null;

  const fleetTotals = useMemo(() => {
    if (!data || !activeMonth) return null;
    const rows = data.drivers
      .map((d) => d.months.find((m) => m.month === activeMonth))
      .filter((m): m is DriverMonth => m != null);
    if (rows.length === 0) return null;
    return {
      drivers: rows.length,
      distance: rows.reduce((n, r) => n + r.distance_km, 0),
      trips: rows.reduce((n, r) => n + r.trips, 0),
      fuel: rows.reduce((n, r) => n + r.fuel_liters, 0),
    };
  }, [data, activeMonth]);

  if (error) {
    return <LoadErrorBanner error={error} subject="driver reports" onRetry={load} />;
  }

  return (
    <div className="space-y-4">
      <Panel
        icon={Users}
        title="Driver performance"
        subtitle="Measured from vehicle telemetry — distance, fuel, trips and stops per calendar month"
        onRefresh={load}
        refreshing={loading}
        actions={
          months.length > 0 ? (
            <SegmentedPills
              items={months.slice(0, 4).map((m) => ({ id: m, label: monthLabel(m).split(' ')[0] }))}
              active={activeMonth ?? months[0]}
              onChange={setMonth}
            />
          ) : undefined
        }
      >
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
        ) : (
          <p className="text-sm text-ink-dim">
            {loading ? 'Loading driver activity…' : 'No driver activity recorded yet.'}
          </p>
        )}

        {/* Stated plainly: the tracker cannot identify who was behind the wheel. */}
        <p className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-ink-dim">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Attributed through each vehicle&apos;s current driver assignment — the tracker reports
          the vehicle, not who was driving it. Reassigning a vehicle reattributes its whole month.
        </p>
      </Panel>

      {activeMonth && data && data.drivers.length > 0 && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {data.drivers.map((d) => (
            <DriverCard
              key={d.driver_name}
              report={d}
              month={activeMonth}
              onViewVehicle={onViewVehicle}
            />
          ))}
        </div>
      )}
    </div>
  );
}
