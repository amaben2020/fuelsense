import { MapPin, Play } from 'lucide-react';
import { Alert, formatNgn } from '@/lib/api';
import { TRUST_COPY } from '@/lib/trust-language';

export function AlertsList({
  alerts,
  onViewOnMap,
}: {
  alerts: Alert[];
  onViewOnMap?: (alert: Alert) => void;
}) {
  if (alerts.length === 0) {
    return <p className="text-sm text-[#8e90a2]">No open alerts.</p>;
  }

  return (
    <ul className="space-y-3">
      {alerts.map((alert) => (
        <li
          key={alert.id}
          className={`rounded-lg p-3 text-sm ${
            alert.alert_type === 'fuel_theft'
              ? 'border-l-2 border-l-[#ffb4ab] bg-[#93000a]/20'
              : 'border-l-2 border-l-[#ffb95f] bg-[#996100]/20'
          }`}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-medium text-[#dae2fd]">
                {alert.license_plate ? `${alert.license_plate}: ` : ''}
                {alert.alert_type === 'fuel_theft'
                  ? TRUST_COPY.alertFuelTitle
                  : alert.message}
              </p>
              {alert.alert_type === 'fuel_theft' && (
                <p className="mt-0.5 text-xs text-[#8e90a2]">{alert.message}</p>
              )}
              <p className="mt-1 text-xs text-[#8e90a2]">
                {new Date(alert.created_at).toLocaleString()}
                {alert.fuel_drop_liters != null && (
                  <span className="ml-2 text-[#ffb95f]">
                    −{Number(alert.fuel_drop_liters).toFixed(1)} L
                  </span>
                )}
                {alert.estimated_loss_ngn != null && (
                  <span className="ml-2 text-[#ffb4ab]">
                    {formatNgn(Number(alert.estimated_loss_ngn))}
                  </span>
                )}
                {alert.latitude && alert.longitude && (
                  <span className="ml-2 inline-flex items-center gap-1">
                    <MapPin className="h-3 w-3" />
                    {Number(alert.latitude).toFixed(5)},{' '}
                    {Number(alert.longitude).toFixed(5)}
                  </span>
                )}
              </p>
            </div>
            {onViewOnMap &&
              alert.alert_type === 'fuel_theft' &&
              alert.vehicle_id && (
                <button
                  type="button"
                  onClick={() => onViewOnMap(alert)}
                  className="shrink-0 rounded-lg border border-[#ffb4ab]/40 bg-[#93000a]/30 px-3 py-1.5 text-xs font-medium text-[#ffb4ab] hover:bg-[#93000a]/50"
                >
                  View on map
                </button>
              )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function FuelAnomalyBanner({
  alerts,
  onViewOnMap,
}: {
  alerts: Alert[];
  onViewOnMap: (alert: Alert) => void;
}) {
  const fuelAlerts = alerts.filter((a) => a.alert_type === 'fuel_theft');
  if (fuelAlerts.length === 0) return null;

  const totalLossNgn = fuelAlerts.reduce(
    (sum, a) => sum + (Number(a.estimated_loss_ngn) || 0),
    0,
  );

  return (
    <div className="sticky top-0 mb-6 rounded-lg border-l-4 border-l-[#ffb95f] bg-[#996100]/15 p-4">
      <p className="font-semibold text-[#ffb95f]">
        {TRUST_COPY.siphonTitle} ({fuelAlerts.length})
        {totalLossNgn > 0 && (
          <span className="ml-2 font-mono text-sm font-normal text-[#c4c5d9]">
            · {formatNgn(totalLossNgn)} est. impact · {TRUST_COPY.requiresReview}
          </span>
        )}
      </p>
      <p className="mt-1 text-xs text-[#8e90a2]">{TRUST_COPY.notVerdict}</p>
      {fuelAlerts.slice(0, 2).map((alert) => (
        <div
          key={alert.id}
          className="mt-2 flex flex-wrap items-center justify-between gap-2"
        >
          <p className="text-sm text-[#c4c5d9]">
            {alert.license_plate ? `${alert.license_plate}: ` : ''}
            {alert.message}
          </p>
          <button
            type="button"
            onClick={() => onViewOnMap(alert)}
            className="inline-flex items-center gap-1 rounded-lg border border-[#2e5bff]/40 bg-[#2e5bff]/15 px-3 py-1 text-xs font-medium text-[#b8c3ff] hover:bg-[#2e5bff]/25"
          >
            <Play className="h-3 w-3" /> Investigate on map
          </button>
        </div>
      ))}
    </div>
  );
}

/** Back-compat alias for dashboard imports */
export { FuelAnomalyBanner as TheftAlertBanner };
