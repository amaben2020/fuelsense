'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Gauge } from 'lucide-react';
import { api, DailyActivityResponse, DailyActivityRow } from '@/lib/api';

const FLAG_LABELS: Record<string, { label: string; className: string }> = {
  high_distance: { label: 'High distance', className: 'text-[#ffb95f]' },
  low_utilization: { label: 'Low use', className: 'text-[#8e90a2]' },
  below_efficiency: { label: 'Below baseline', className: 'text-[#ffb4ab]' },
};

export function DailyActivityTable() {
  const [data, setData] = useState<DailyActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFlaggedOnly, setShowFlaggedOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api<DailyActivityResponse>('/telemetry/daily-activity?days=7');
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load daily activity');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows = (data?.rows ?? []).filter((r) => !showFlaggedOnly || r.flags.length > 0);
  const flaggedCount = (data?.rows ?? []).filter((r) => r.flags.length > 0).length;
  const threshold = data?.efficiency_variance_threshold_percent ?? -10;

  return (
    <div className="overflow-hidden rounded-lg border border-[#434656] bg-[#171f33]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#434656] px-6 py-4">
        <div>
          <h2 className="flex items-center gap-2 font-semibold text-[#dae2fd]">
            <Gauge className="h-4 w-4" /> Daily fleet activity
          </h2>
          <p className="mt-1 text-xs text-[#8e90a2]">
            Per-day distance & efficiency · flags when over max km/day or efficiency below baseline
            by {Math.abs(threshold)}%
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-[#c4c5d9]">
          <input
            type="checkbox"
            checked={showFlaggedOnly}
            onChange={(e) => setShowFlaggedOnly(e.target.checked)}
            className="rounded border-[#434656]"
          />
          Flagged only ({flaggedCount})
        </label>
      </div>

      {error && <p className="px-6 py-3 text-sm text-[#ffb4ab]">{error}</p>}

      {loading ? (
        <p className="p-6 text-sm text-[#8e90a2]">Loading daily activity…</p>
      ) : rows.length === 0 ? (
        <p className="p-6 text-sm text-[#8e90a2]">No daily activity in this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="bg-[#0b1326] text-xs uppercase tracking-wider text-[#8e90a2]">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Vehicle</th>
                <th className="px-4 py-3">Driver</th>
                <th className="px-4 py-3">Distance</th>
                <th className="px-4 py-3">Threshold</th>
                <th className="px-4 py-3">Fuel</th>
                <th className="px-4 py-3">Efficiency</th>
                <th className="px-4 py-3">Baseline</th>
                <th className="px-4 py-3">Flags</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2d3449] text-[#c4c5d9]">
              {rows.map((row) => (
                <ActivityRow key={`${row.vehicle_id}-${row.activity_date}`} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ActivityRow({ row }: { row: DailyActivityRow }) {
  const overMax = row.flags.includes('high_distance');
  const dateStr = new Date(row.activity_date).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  return (
    <tr className={row.flags.length > 0 ? 'bg-[#93000a]/5' : undefined}>
      <td className="whitespace-nowrap px-4 py-2.5 text-xs">{dateStr}</td>
      <td className="px-4 py-2.5 font-medium text-[#b8c3ff]">{row.license_plate}</td>
      <td className="px-4 py-2.5">{row.driver_name ?? '—'}</td>
      <td
        className={`px-4 py-2.5 font-mono ${overMax ? 'font-semibold text-[#ffb95f]' : ''}`}
      >
        {row.distance_km} km
      </td>
      <td className="px-4 py-2.5 font-mono text-xs text-[#8e90a2]">
        {row.expected_distance_min_km}–{row.expected_distance_max_km} km
      </td>
      <td className="px-4 py-2.5 font-mono">{row.fuel_used_liters.toFixed(1)} L</td>
      <td className="px-4 py-2.5 font-mono">
        {row.efficiency_km_l != null ? `${row.efficiency_km_l.toFixed(1)} km/L` : '—'}
      </td>
      <td className="px-4 py-2.5 font-mono text-[#8e90a2]">
        {row.expected_efficiency_km_l} km/L
      </td>
      <td className="px-4 py-2.5">
        {row.flags.length === 0 ? (
          <span className="text-xs text-[#4edea3]">OK</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {row.flags.map((flag) => {
              const meta = FLAG_LABELS[flag];
              return (
                <span
                  key={flag}
                  className={`inline-flex items-center gap-0.5 rounded-full bg-[#0b1326] px-1.5 py-0.5 text-[10px] ${meta?.className ?? ''}`}
                >
                  {flag === 'below_efficiency' && <AlertTriangle className="h-2.5 w-2.5" />}
                  {meta?.label ?? flag}
                </span>
              );
            })}
          </div>
        )}
      </td>
    </tr>
  );
}
