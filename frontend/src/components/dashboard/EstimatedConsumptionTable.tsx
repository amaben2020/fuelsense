'use client';

import { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import {
  api,
  EstimatedConsumptionDay,
  EstimatedConsumptionResponse,
  EstimatedConsumptionRow,
  formatNgn,
} from '@/lib/api';

export const ESTIMATE_PERIOD_OPTIONS = [1, 7, 30];

export function useEstimatedConsumption(days: number) {
  const [data, setData] = useState<EstimatedConsumptionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<EstimatedConsumptionResponse>(`/dashboard/estimated-consumption?days=${days}`)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load estimate');
          setData(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  return { data, loading, error };
}

function formatDay(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function VehicleRow({ row }: { row: EstimatedConsumptionRow }) {
  return (
    <tr>
      <td className="px-6 py-2.5 font-medium text-ink">
        {row.license_plate}
        {row.model && <span className="ml-2 text-xs text-ink-dim">{row.model}</span>}
      </td>
      <td className="px-6 py-2.5">{row.driver_name ?? '—'}</td>
      <td className="px-6 py-2.5 font-mono">{row.distance_km.toLocaleString()} km</td>
      <td className="px-6 py-2.5 font-mono">{row.efficiency_km_l.toFixed(1)}</td>
      <td className="px-6 py-2.5 font-mono">
        {row.efficiency_mpg != null ? row.efficiency_mpg.toFixed(1) : '—'}
      </td>
      <td className="px-6 py-2.5 font-mono text-good">
        {row.estimated_fuel_liters.toFixed(1)} L
      </td>
      <td className="px-6 py-2.5 font-mono">{formatNgn(row.estimated_cost_ngn)}</td>
    </tr>
  );
}

function DayGroup({ day }: { day: EstimatedConsumptionDay }) {
  return (
    <>
      <tr className="bg-panel-deep">
        <td className="px-6 py-2 text-xs font-semibold uppercase tracking-wider text-brand" colSpan={2}>
          {formatDay(day.date)}
        </td>
        <td className="px-6 py-2 font-mono text-xs text-ink-dim">
          {day.totals.distance_km.toLocaleString()} km
        </td>
        <td className="px-6 py-2" colSpan={2} />
        <td className="px-6 py-2 font-mono text-xs text-ink-dim">
          {day.totals.estimated_fuel_liters.toFixed(1)} L
        </td>
        <td className="px-6 py-2 font-mono text-xs text-ink-dim">
          {formatNgn(day.totals.estimated_cost_ngn)}
        </td>
      </tr>
      {day.vehicles.map((row) => (
        <VehicleRow key={`${day.date}-${row.vehicle_id}`} row={row} />
      ))}
    </>
  );
}

export function EstimatedConsumptionTableView({
  days,
  onDaysChange,
  data,
  loading,
  error,
}: {
  days: number;
  onDaysChange: (d: number) => void;
  data: EstimatedConsumptionResponse | null;
  loading: boolean;
  error: string | null;
}) {
  const rows = data?.vehicles ?? [];

  return (
    <div className="overflow-hidden rounded-lg border border-edge bg-panel">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-edge px-6 py-4">
        <div>
          <h2 className="flex items-center gap-2 font-semibold text-ink">
            <Gauge className="h-4 w-4" /> Estimated fuel consumed
          </h2>
          <p className="mt-1 text-xs text-ink-dim">
            Distance covered ÷ model baseline efficiency — estimate only, no fuel-level sensor
            required
          </p>
        </div>
        <div className="flex gap-1">
          {ESTIMATE_PERIOD_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => onDaysChange(d)}
              className={`rounded-lg border px-3 py-1 text-xs ${
                days === d
                  ? 'border-good bg-good/10 text-good'
                  : 'border-edge text-ink-mid hover:bg-panel-hover'
              }`}
            >
              {d === 1 ? 'Today' : `${d} days`}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="px-6 py-3 text-sm text-bad">{error}</p>}

      {loading && rows.length === 0 ? (
        <p className="p-6 text-sm text-ink-dim">Estimating consumption…</p>
      ) : rows.length === 0 ? (
        <p className="p-6 text-sm text-ink-dim">
          No distance recorded in this period yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="bg-canvas text-xs uppercase tracking-wider text-ink-dim">
              <tr>
                <th className="px-6 py-3">Vehicle</th>
                <th className="px-6 py-3">Driver</th>
                <th className="px-6 py-3">Distance</th>
                <th className="px-6 py-3">Baseline km/L</th>
                <th className="px-6 py-3">MPG</th>
                <th className="px-6 py-3">Est. fuel used</th>
                <th className="px-6 py-3">Est. cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-divider text-ink-mid">
              {(data?.daily?.length ? data.daily : [null]).map((day) =>
                day == null ? (
                  rows.map((row) => <VehicleRow key={row.vehicle_id} row={row} />)
                ) : (
                  <DayGroup key={day.date} day={day} />
                )
              )}
            </tbody>
            {data && (
              <tfoot className="border-t border-edge bg-canvas font-medium text-ink">
                <tr>
                  <td className="px-6 py-3" colSpan={2}>
                    Fleet total
                  </td>
                  <td className="px-6 py-3 font-mono">
                    {data.totals.distance_km.toLocaleString()} km
                  </td>
                  <td className="px-6 py-3" colSpan={2} />
                  <td className="px-6 py-3 font-mono text-good">
                    {data.totals.estimated_fuel_liters.toFixed(1)} L
                  </td>
                  <td className="px-6 py-3 font-mono">
                    {formatNgn(data.totals.estimated_cost_ngn)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

export function EstimatedConsumptionTable() {
  const [days, setDays] = useState(7);
  const state = useEstimatedConsumption(days);

  return <EstimatedConsumptionTableView days={days} onDaysChange={setDays} {...state} />;
}
