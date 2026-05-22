import { MapPin } from 'lucide-react';
import { Alert, formatNgn } from '@/lib/api';

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
                {alert.message}
              </p>
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
                    {Number(alert.latitude).toFixed(5)}, {Number(alert.longitude).toFixed(5)}
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

export function TheftAlertBanner({
  alerts,
  onViewOnMap,
}: {
  alerts: Alert[];
  onViewOnMap: (alert: Alert) => void;
}) {
  const theftAlerts = alerts.filter((a) => a.alert_type === 'fuel_theft');
  if (theftAlerts.length === 0) return null;

  const totalLossNgn = theftAlerts.reduce(
    (sum, a) => sum + (Number(a.estimated_loss_ngn) || 0),
    0
  );

  return (
    <div className="mb-6 rounded-lg border-l-4 border-l-[#ffb4ab] bg-[#93000a]/20 p-4">
      <p className="font-semibold text-[#ffb4ab]">
        Fuel theft detected ({theftAlerts.length})
        {totalLossNgn > 0 && (
          <span className="ml-2 font-mono text-sm">· {formatNgn(totalLossNgn)} est. loss</span>
        )}
      </p>
      {theftAlerts.slice(0, 2).map((alert) => (
        <div key={alert.id} className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-[#ffb4ab]/90">
            {alert.license_plate ? `${alert.license_plate}: ` : ''}
            {alert.message}
          </p>
          <button
            type="button"
            onClick={() => onViewOnMap(alert)}
            className="rounded-lg border border-[#ffb4ab]/40 px-3 py-1 text-xs font-medium text-[#ffb4ab] hover:bg-[#93000a]/40"
          >
            View on map
          </button>
        </div>
      ))}
    </div>
  );
}
