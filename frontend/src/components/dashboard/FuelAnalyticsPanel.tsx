import {
  FleetEfficiency,
  FleetEfficiencySummary,
  FuelAnomaly,
  formatNgn,
} from '@/lib/api';
import { FuelAnomalies } from './FuelAnomalies';

export function FuelAnalyticsPanel({
  efficiency,
  efficiencySummary,
  anomalies,
  onAcknowledgeAnomaly,
  onViewOnMap,
}: {
  efficiency: FleetEfficiency[];
  efficiencySummary?: FleetEfficiencySummary | null;
  anomalies: FuelAnomaly[];
  onAcknowledgeAnomaly: (id: string) => void;
  onViewOnMap?: (anomaly: FuelAnomaly) => void;
}) {
  const sortedByLoss = [...efficiency].sort(
    (a, b) => b.total_loss_ngn - a.total_loss_ngn,
  );

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <div className="xl:col-span-2">
        <FuelAnomalies
          anomalies={anomalies}
          liveConnected={true}
          onAcknowledge={onAcknowledgeAnomaly}
          onViewOnMap={onViewOnMap}
        />
      </div>

      <div className="rounded-lg border border-edge bg-panel p-6">
        <h2 className="font-semibold text-ink">Loss by vehicle</h2>
        <p className="mt-1 text-xs text-ink-dim">
          Actual vs expected ·{' '}
          {efficiencySummary
            ? formatNgn(efficiencySummary.price_per_liter_ngn)
            : '₦1300'}
          /L
        </p>
        {sortedByLoss.length === 0 ? (
          <p className="mt-4 text-sm text-ink-dim">
            No consumption data yet.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {sortedByLoss.slice(0, 6).map((row) => (
              <li
                key={row.vehicle_id}
                className="flex items-center justify-between gap-3 rounded-lg bg-canvas px-3 py-2"
              >
                <div>
                  <p className="font-medium text-ink">
                    {row.license_plate}
                  </p>
                  <p className="text-xs text-ink-dim">
                    {row.fuel_used_liters.toFixed(1)} L · {row.distance_km} km ·{' '}
                    {row.efficiency_l_100km?.toFixed(1) ?? '—'} L/100km vs target{' '}
                    {row.expected_efficiency_l_100km?.toFixed(1) ?? '—'}
                  </p>
                </div>
                <p
                  className={`font-mono text-sm ${
                    row.total_loss_ngn > 0 ? 'text-bad' : 'text-good'
                  }`}
                >
                  {row.total_loss_ngn > 0
                    ? `−${formatNgn(row.total_loss_ngn)}`
                    : 'On track'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
