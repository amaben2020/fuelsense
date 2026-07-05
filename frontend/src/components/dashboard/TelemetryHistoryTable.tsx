'use client';

import { useCallback, useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { api, TelemetryReadingsResponse } from '@/lib/api';

function Pagination({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-edge bg-canvas px-6 py-3">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className="rounded-lg border border-edge px-3 py-1 text-xs text-ink-mid disabled:opacity-40"
      >
        Previous
      </button>
      <span className="text-xs text-ink-dim">
        Page {page} of {totalPages}
      </span>
      <button
        type="button"
        disabled={page >= totalPages}
        onClick={() => onPage(page + 1)}
        className="rounded-lg border border-edge px-3 py-1 text-xs text-ink-mid disabled:opacity-40"
      >
        Next
      </button>
    </div>
  );
}

export function TelemetryHistoryTable() {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<TelemetryReadingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api<TelemetryReadingsResponse>(
        `/telemetry/readings?page=${p}&limit=15`
      );
      setData(result);
      setPage(result.page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load history');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(page);
  }, [page, load]);

  const rows = data?.rows ?? [];

  return (
    <div className="overflow-hidden rounded-lg border border-edge bg-panel">
      <div className="border-b border-edge px-6 py-4">
        <h2 className="flex items-center gap-2 font-semibold text-ink">
          <History className="h-4 w-4" /> Telemetry history
        </h2>
        <p className="mt-1 text-xs text-ink-dim">
          OBD readings from FMC150 — fuel level (IO 390), speed, GPS, odometer
        </p>
      </div>

      {error && <p className="px-6 py-3 text-sm text-bad">{error}</p>}

      {loading && rows.length === 0 ? (
        <p className="p-6 text-sm text-ink-dim">Loading history…</p>
      ) : rows.length === 0 ? (
        <p className="p-6 text-sm text-ink-dim">
          No telemetry yet. Ensure your FMC150 devices are powered on and connected.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-canvas text-xs uppercase tracking-wider text-ink-dim">
              <tr>
                <th className="px-6 py-3">Time</th>
                <th className="px-6 py-3">Vehicle</th>
                <th className="px-6 py-3">Driver</th>
                <th className="px-6 py-3">Fuel (L)</th>
                <th className="px-6 py-3">Speed</th>
                <th className="px-6 py-3">Odometer</th>
                <th className="px-6 py-3">Ignition</th>
                <th className="px-6 py-3">Location</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-divider text-ink-mid">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-nowrap px-6 py-2.5 text-xs">
                    {new Date(row.recorded_at).toLocaleString()}
                  </td>
                  <td className="px-6 py-2.5 font-medium text-ink">{row.license_plate}</td>
                  <td className="px-6 py-2.5">{row.driver_name ?? '—'}</td>
                  <td className="px-6 py-2.5 font-mono text-good">
                    {row.fuel_level_liters != null
                      ? Number(row.fuel_level_liters).toFixed(1)
                      : '—'}
                  </td>
                  <td className="px-6 py-2.5 font-mono">{row.speed_kph ?? 0} km/h</td>
                  <td className="px-6 py-2.5 font-mono">
                    {row.odometer_km != null
                      ? `${Number(row.odometer_km).toLocaleString()} km`
                      : '—'}
                  </td>
                  <td className="px-6 py-2.5">
                    {row.ignition_on == null ? '—' : row.ignition_on ? 'ON' : 'OFF'}
                  </td>
                  <td className="px-6 py-2.5 font-mono text-xs text-ink-dim">
                    {row.latitude != null && row.longitude != null
                      ? `${Number(row.latitude).toFixed(4)}, ${Number(row.longitude).toFixed(4)}`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && (
        <Pagination page={data.page} totalPages={data.total_pages} onPage={setPage} />
      )}
    </div>
  );
}
