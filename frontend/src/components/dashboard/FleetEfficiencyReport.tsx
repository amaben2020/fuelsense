import {
  AlertTriangle,
  Shield,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { FleetEfficiency, formatNgn } from '@/lib/api';

function StatusBadge({ status }: { status: FleetEfficiency['status'] }) {
  if (status === 'theft_alert') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#93000a]/20 px-2 py-1 text-xs text-[#ffb4ab]">
        <AlertTriangle className="h-3 w-3" /> Theft alert
      </span>
    );
  }
  if (status === 'underperforming') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#996100]/20 px-2 py-1 text-xs text-[#ffb95f]">
        <TrendingDown className="h-3 w-3" /> Underperforming
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#4edea3]/20 px-2 py-1 text-xs text-[#4edea3]">
      <Shield className="h-3 w-3" /> Verified
    </span>
  );
}

export function FleetEfficiencyReport({ rows }: { rows: FleetEfficiency[] }) {
  const periodDays = rows[0]?.period_days ?? 7;
  const totalDistance = rows.reduce((s, r) => s + r.distance_km, 0);
  const totalFuel = rows.reduce((s, r) => s + r.fuel_used_liters, 0);
  const totalCost = rows.reduce((s, r) => s + r.fuel_cost_ngn, 0);
  const totalTheft = rows.reduce((s, r) => s + r.theft_loss_ngn, 0);
  const effValues = rows.map((r) => r.efficiency_km_l).filter((v): v is number => v != null);
  const avgEfficiency =
    effValues.length > 0 ? effValues.reduce((s, v) => s + v, 0) / effValues.length : null;

  return (
    <div className="overflow-hidden rounded-lg border border-[#434656] bg-[#171f33]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#434656] px-6 py-4">
        <div>
          <h2 className="font-semibold text-[#dae2fd]">Fleet efficiency report</h2>
          <p className="mt-1 text-xs text-[#8e90a2]">
            Last {periodDays} days · OBD telemetry from FMC150 devices · all costs in NGN
          </p>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="p-6 text-sm text-[#8e90a2]">
          Run <code className="text-[#b8c3ff]">npm run seed-telemetry</code> in the backend for
          demo fleet history.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="bg-[#0b1326] text-xs uppercase tracking-wider text-[#8e90a2]">
              <tr>
                <th className="px-6 py-3">Vehicle</th>
                <th className="px-6 py-3">Driver</th>
                <th className="px-6 py-3">Distance</th>
                <th className="px-6 py-3">Fuel used</th>
                <th className="px-6 py-3">Efficiency</th>
                <th className="px-6 py-3">vs expected</th>
                <th className="px-6 py-3">Fuel cost</th>
                <th className="px-6 py-3">Theft loss</th>
                <th className="px-6 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2d3449] text-[#c4c5d9]">
              {rows.map((row) => {
                const meetsBaseline =
                  row.efficiency_km_l != null &&
                  row.efficiency_km_l >= row.expected_efficiency_km_l * 0.95;
                return (
                  <tr key={row.vehicle_id} className="hover:bg-[#222a3d]">
                    <td className="px-6 py-3 font-medium text-[#b8c3ff]">{row.license_plate}</td>
                    <td className="px-6 py-3">{row.driver_name ?? '—'}</td>
                    <td className="px-6 py-3 font-mono">{row.distance_km.toLocaleString()} km</td>
                    <td className="px-6 py-3 font-mono">{row.fuel_used_liters.toFixed(1)} L</td>
                    <td
                      className={`px-6 py-3 font-mono font-bold ${
                        meetsBaseline ? 'text-[#4edea3]' : 'text-[#ffb95f]'
                      }`}
                    >
                      {row.efficiency_km_l != null ? `${row.efficiency_km_l.toFixed(1)} km/L` : '—'}
                    </td>
                    <td className="px-6 py-3">
                      {row.variance_percent != null ? (
                        <span
                          className={`inline-flex items-center gap-1 ${
                            row.variance_percent >= 0 ? 'text-[#4edea3]' : 'text-[#ffb4ab]'
                          }`}
                        >
                          {row.variance_percent >= 0 ? (
                            <TrendingUp className="h-3 w-3" />
                          ) : (
                            <TrendingDown className="h-3 w-3" />
                          )}
                          {Math.abs(row.variance_percent).toFixed(0)}%
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-6 py-3 font-mono">{formatNgn(row.fuel_cost_ngn)}</td>
                    <td className="px-6 py-3">
                      {row.theft_loss_ngn > 0 ? (
                        <span className="font-mono text-[#ffb4ab]">
                          {formatNgn(row.theft_loss_ngn)}
                        </span>
                      ) : (
                        <span className="text-[#4edea3]">—</span>
                      )}
                    </td>
                    <td className="px-6 py-3">
                      <StatusBadge status={row.status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="border-t border-[#434656] bg-[#0b1326] text-sm font-semibold text-[#dae2fd]">
              <tr>
                <td className="px-6 py-3">Total</td>
                <td className="px-6 py-3" />
                <td className="px-6 py-3 font-mono">{totalDistance.toLocaleString()} km</td>
                <td className="px-6 py-3 font-mono">{totalFuel.toFixed(0)} L</td>
                <td className="px-6 py-3 font-mono">
                  {avgEfficiency != null ? `${avgEfficiency.toFixed(1)} km/L` : '—'}
                </td>
                <td className="px-6 py-3" />
                <td className="px-6 py-3 font-mono">{formatNgn(totalCost)}</td>
                <td className="px-6 py-3 font-mono text-[#ffb4ab]">
                  {totalTheft > 0 ? formatNgn(totalTheft) : '—'}
                </td>
                <td className="px-6 py-3" />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
