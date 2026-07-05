'use client';

import { useState } from 'react';
import {
  AlertTriangle,
  HelpCircle,
  Shield,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import {
  FleetEfficiency,
  FleetEfficiencySummary,
  formatFuelPricePerLiter,
  formatNgn,
} from '@/lib/api';
import { SavingsExplanationModal } from './SavingsExplanationModal';

function StatusBadge({ status }: { status: FleetEfficiency['status'] }) {
  if (status === 'theft_alert') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-bad-deep/20 px-2 py-1 text-xs text-bad">
        <AlertTriangle className="h-3 w-3" /> Review needed
      </span>
    );
  }
  if (status === 'underperforming') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-warn-deep/20 px-2 py-1 text-xs text-warn">
        <TrendingDown className="h-3 w-3" /> Underperforming
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-good/20 px-2 py-1 text-xs text-good">
      <Shield className="h-3 w-3" /> Verified
    </span>
  );
}

function LossCell({ amount }: { amount: number }) {
  if (amount === 0) {
    return <span className="font-mono text-good">—</span>;
  }
  return (
    <span className="font-mono font-semibold text-bad">
      −{formatNgn(amount)}
    </span>
  );
}

export function FleetEfficiencyReport({
  rows,
  summary,
}: {
  rows: FleetEfficiency[];
  summary: FleetEfficiencySummary | null;
}) {
  const [explainOpen, setExplainOpen] = useState(false);
  const periodDays = summary?.period_days ?? rows[0]?.period_days ?? 7;
  const pricePerLiter =
    summary?.price_per_liter_ngn ?? rows[0]?.price_per_liter_ngn ?? 1300;

  const totalDistance =
    summary?.total_distance_km ?? rows.reduce((s, r) => s + r.distance_km, 0);
  const totalFuel =
    summary?.total_fuel_used_liters ??
    rows.reduce((s, r) => s + r.fuel_used_liters, 0);
  const totalExpected =
    summary?.total_expected_cost_ngn ??
    rows.reduce((s, r) => s + r.expected_cost_ngn, 0);
  const totalActual =
    summary?.total_actual_cost_ngn ??
    rows.reduce((s, r) => s + r.actual_cost_ngn, 0);
  const totalLoss =
    summary?.total_loss_ngn ?? rows.reduce((s, r) => s + r.total_loss_ngn, 0);
  const totalTheft =
    summary?.total_theft_loss_ngn ??
    rows.reduce((s, r) => s + r.theft_loss_ngn, 0);
  const fleetEfficiencyL100 =
    totalDistance > 0 && totalFuel >= 0.5
      ? (totalFuel / totalDistance) * 100
      : null;
  const fleetExpectedL100 =
    rows.length > 0
      ? rows.reduce((s, r) => s + (r.expected_efficiency_l_100km ?? 0), 0) / rows.length
      : null;

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-edge bg-panel">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-edge px-6 py-4">
          <div>
            <h2 className="font-semibold text-ink">
              Fleet efficiency & savings report
            </h2>
            <p className="mt-1 text-xs text-ink-dim">
              Last {periodDays} days · {formatFuelPricePerLiter(pricePerLiter)}{' '}
              diesel · OBD telemetry
            </p>
          </div>
          <button
            type="button"
            onClick={() => setExplainOpen(true)}
            className="inline-flex items-center gap-1 rounded-lg border border-edge px-3 py-1.5 text-xs text-brand"
          >
            <HelpCircle className="h-3.5 w-3.5" /> How savings work
          </button>
        </div>

        {rows.length === 0 ? (
          <p className="p-6 text-sm text-ink-dim">
            No efficiency data yet. Vehicles need at least one completed trip to appear here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1400px] text-left text-sm">
              <thead className="bg-canvas text-xs uppercase tracking-wider text-ink-dim">
                <tr>
                  <th className="px-3 py-3">Vehicle</th>
                  <th className="px-3 py-3">Driver</th>
                  <th className="px-3 py-3">{periodDays}d km</th>
                  <th className="px-3 py-3">Fuel used</th>
                  <th className="px-3 py-3">Actual L/100km</th>
                  <th className="px-3 py-3">Target</th>
                  <th className="px-3 py-3">vs target</th>
                  <th className="px-3 py-3">This tank km</th>
                  <th className="px-3 py-3">Tank L/100km</th>
                  <th className="px-3 py-3">OBD fill</th>
                  <th className="px-3 py-3">Expected ₦</th>
                  <th className="px-3 py-3">Actual ₦</th>
                  <th className="px-3 py-3">Loss ₦</th>
                  <th className="px-3 py-3">Anomaly ₦</th>
                  <th className="px-3 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divider text-ink-mid">
                {rows.map((row) => {
                  const variance = row.variance_percent;
                  const tankEff = row.tank_efficiency_l_100km;
                  const tankDist =
                    row.tank_distance_km ?? row.distance_since_purchase_km ?? 0;
                  return (
                    <tr key={row.vehicle_id} className="hover:bg-panel-hover">
                      <td className="px-3 py-3 font-medium text-brand">
                        {row.license_plate}
                      </td>
                      <td className="px-3 py-3">{row.driver_name ?? '—'}</td>
                      <td className="px-3 py-3 font-mono">
                        {row.distance_km.toLocaleString()}
                      </td>
                      <td className="px-3 py-3 font-mono">
                        {row.fuel_used_liters.toFixed(1)} L
                      </td>
                      <td className="px-3 py-3 font-mono font-bold text-ink">
                        {row.efficiency_l_100km != null
                          ? row.efficiency_l_100km.toFixed(1)
                          : '—'}
                      </td>
                      <td className="px-3 py-3 font-mono text-ink-dim">
                        {row.expected_efficiency_l_100km.toFixed(1)} L/100km
                      </td>
                      <td className="px-3 py-3">
                        {variance != null ? (
                          <span
                            className={`inline-flex items-center gap-0.5 font-mono text-xs ${
                              variance <= 10
                                ? 'text-good'
                                : 'text-bad'
                            }`}
                          >
                            {variance <= 10 ? (
                              <TrendingDown className="h-3 w-3" />
                            ) : (
                              <TrendingUp className="h-3 w-3" />
                            )}
                            {variance > 0 ? '+' : ''}
                            {variance.toFixed(1)}%
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-3 font-mono">{tankDist} km</td>
                      <td
                        className={`px-3 py-3 font-mono ${
                          tankEff != null &&
                          tankEff <= (row.expected_efficiency_l_100km ?? 999) * 1.05
                            ? 'text-good'
                            : 'text-warn'
                        }`}
                      >
                        {tankEff != null ? tankEff.toFixed(1) : '—'}
                      </td>
                      <td
                        className="px-3 py-3 font-mono text-xs text-good"
                        title="Liters added at last refuel (OBD sensor)"
                      >
                        {row.last_fuel_added_liters != null
                          ? `${row.last_fuel_added_liters.toFixed(1)} L`
                          : '—'}
                      </td>
                      <td className="px-3 py-3 font-mono text-ink-dim">
                        {formatNgn(row.expected_cost_ngn)}
                      </td>
                      <td className="px-3 py-3 font-mono">
                        {formatNgn(row.actual_cost_ngn)}
                      </td>
                      <td className="px-3 py-3">
                        <LossCell amount={row.total_loss_ngn} />
                      </td>
                      <td className="px-3 py-3">
                        {row.theft_loss_ngn > 0 ? (
                          <span className="font-mono text-xs text-bad">
                            {formatNgn(row.theft_loss_ngn)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <StatusBadge status={row.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="border-t border-edge bg-canvas text-xs font-semibold text-ink">
                <tr>
                  <td className="px-3 py-3">Total</td>
                  <td className="px-3 py-3" />
                  <td className="px-3 py-3 font-mono">
                    {totalDistance.toLocaleString()} km
                  </td>
                  <td className="px-3 py-3 font-mono">
                    {totalFuel.toFixed(0)} L
                  </td>
                  <td className="px-3 py-3 font-mono">
                    {fleetEfficiencyL100 != null
                      ? `${fleetEfficiencyL100.toFixed(1)} L/100km`
                      : '—'}
                  </td>
                  <td className="px-3 py-3 font-mono text-ink-dim">
                    {fleetExpectedL100 != null
                      ? `${fleetExpectedL100.toFixed(1)} avg`
                      : '—'}
                  </td>
                  <td className="px-3 py-3" colSpan={4} />
                  <td className="px-3 py-3 font-mono">
                    {formatNgn(totalExpected)}
                  </td>
                  <td className="px-3 py-3 font-mono">
                    {formatNgn(totalActual)}
                  </td>
                  <td className="px-3 py-3 font-mono text-bad">
                    −{formatNgn(totalLoss)}
                  </td>
                  <td className="px-3 py-3 font-mono text-bad">
                    {totalTheft > 0 ? formatNgn(totalTheft) : '—'}
                  </td>
                  <td className="px-3 py-3" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {totalLoss > 0 && (
          <div className="border-t border-edge bg-bad-deep/10 px-6 py-3 text-xs text-bad">
            {rows.some(
              (r) => r.receipt_fraud_loss_ngn && r.receipt_fraud_loss_ngn > 0,
            ) && (
              <span>
                Receipt mismatch flagged on{' '}
                {rows
                  .filter((r) => (r.receipt_fraud_loss_ngn ?? 0) > 0)
                  .map((r) => r.license_plate)
                  .join(', ')}
                .{' '}
              </span>
            )}
            {rows.some((r) => (r.alert_theft_loss_ngn ?? 0) > 0) && (
              <span>Fuel anomaly patterns flagged for review. </span>
            )}
            Preventable gap {formatNgn(totalLoss)} vs baseline — investigate with evidence replay.
          </div>
        )}
      </div>

      {explainOpen && (
        <SavingsExplanationModal
          summary={summary}
          onClose={() => setExplainOpen(false)}
        />
      )}
    </>
  );
}
