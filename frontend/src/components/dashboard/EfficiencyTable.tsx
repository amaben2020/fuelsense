import { FleetEfficiency, formatNgn } from '@/lib/api';

export function EfficiencyTable({ rows }: { rows: FleetEfficiency[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-edge bg-panel">
      <div className="border-b border-edge px-6 py-4">
        <h2 className="font-semibold text-ink">
          Fleet efficiency (last {rows[0]?.period_days ?? 7} days)
        </h2>
        <p className="text-xs text-ink-dim">Computed from live telemetry in PostgreSQL</p>
      </div>
      {rows.length === 0 ? (
        <p className="p-6 text-sm text-ink-dim">
          No telemetry history yet. Run <code className="text-brand">npm run simulate-fleet</code>{' '}
          in the backend.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-canvas text-xs text-ink-dim">
              <tr>
                <th className="px-6 py-3 font-medium">Vehicle</th>
                <th className="px-6 py-3 font-medium">Model</th>
                <th className="px-6 py-3 font-medium">Distance</th>
                <th className="px-6 py-3 font-medium">Fuel used</th>
                <th className="px-6 py-3 font-medium">Efficiency</th>
                <th className="px-6 py-3 font-medium">Fuel cost</th>
                <th className="px-6 py-3 font-medium">CO₂</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              {rows.map((row) => (
                <tr key={row.vehicle_id} className="text-ink-mid">
                  <td className="px-6 py-3 font-medium text-ink">{row.license_plate}</td>
                  <td className="px-6 py-3 text-ink-dim">{row.model ?? '—'}</td>
                  <td className="px-6 py-3">{row.distance_km.toLocaleString()} km</td>
                  <td className="px-6 py-3">{row.fuel_used_liters.toFixed(1)} L</td>
                  <td
                    className={`px-6 py-3 font-mono ${
                      row.efficiency_km_l == null
                        ? 'text-ink-dim'
                        : row.efficiency_km_l >= 8
                          ? 'text-good'
                          : row.efficiency_km_l >= 7
                            ? 'text-warn'
                            : 'text-bad'
                    }`}
                  >
                    {row.efficiency_km_l != null ? row.efficiency_km_l.toFixed(2) : '—'} km/L
                  </td>
                  <td className="px-6 py-3">{formatNgn(row.fuel_cost_ngn)}</td>
                  <td className="px-6 py-3">{row.co2_emissions_kg} kg</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
