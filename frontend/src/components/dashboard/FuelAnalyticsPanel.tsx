import { FleetEfficiency, FuelAnomaly, formatNgn } from '@/lib/api';
import { FuelAnomalies } from './FuelAnomalies';

export function FuelAnalyticsPanel({
  efficiency,
  anomalies,
  onAcknowledgeAnomaly,
  onViewOnMap,
}: {
  efficiency: FleetEfficiency[];
  anomalies: FuelAnomaly[];
  onAcknowledgeAnomaly: (id: string) => void;
  onViewOnMap?: (anomaly: FuelAnomaly) => void;
}) {
  const sortedCosts = [...efficiency].sort((a, b) => b.fuel_cost_ngn - a.fuel_cost_ngn);

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

      <div className="rounded-lg border border-[#434656] bg-[#171f33] p-6">
        <h2 className="font-semibold text-[#dae2fd]">Cost by vehicle</h2>
        <p className="mt-1 text-xs text-[#8e90a2]">Last 7 days · all amounts in NGN</p>
        {sortedCosts.length === 0 ? (
          <p className="mt-4 text-sm text-[#8e90a2]">No consumption data yet.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {sortedCosts.map((row) => (
              <li
                key={row.vehicle_id}
                className="flex items-center justify-between gap-3 rounded-lg bg-[#0b1326] px-3 py-2"
              >
                <div>
                  <p className="font-medium text-[#dae2fd]">{row.license_plate}</p>
                  <p className="text-xs text-[#8e90a2]">
                    {row.fuel_used_liters.toFixed(1)} L · {row.distance_km} km
                  </p>
                </div>
                <p className="font-mono text-sm text-[#4edea3]">
                  {formatNgn(row.fuel_cost_ngn)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
