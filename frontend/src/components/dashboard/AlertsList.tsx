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
    return <p className="text-sm text-ink-dim">No open alerts.</p>;
  }

  return (
    <ul className="space-y-3">
      {alerts.map((alert) => (
        <li
          key={alert.id}
          className={`rounded-lg p-3 text-sm ${
            alert.alert_type === 'fuel_theft'
              ? 'border-l-2 border-l-bad bg-bad-deep/20'
              : 'border-l-2 border-l-warn bg-warn-deep/20'
          }`}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-medium text-ink">
                {alert.license_plate ? `${alert.license_plate}: ` : ''}
                {alert.alert_type === 'fuel_theft'
                  ? TRUST_COPY.alertFuelTitle
                  : alert.message}
              </p>
              {alert.alert_type === 'fuel_theft' && (
                <p className="mt-0.5 text-xs text-ink-dim">{alert.message}</p>
              )}
              <p className="mt-1 text-xs text-ink-dim">
                {new Date(alert.created_at).toLocaleString()}
                {alert.fuel_drop_liters != null && (
                  <span className="ml-2 text-warn">
                    −{Number(alert.fuel_drop_liters).toFixed(1)} L
                  </span>
                )}
                {alert.estimated_loss_ngn != null && (
                  <span className="ml-2 text-bad">
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
                  className="shrink-0 rounded-lg border border-bad/40 bg-bad-deep/30 px-3 py-1.5 text-xs font-medium text-bad hover:bg-bad-deep/50"
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
    <div className="sticky top-0 mb-6 rounded-lg border-l-4 border-l-warn bg-warn-deep/15 p-4">
      <p className="font-semibold text-warn">
        {TRUST_COPY.siphonTitle} ({fuelAlerts.length})
        {totalLossNgn > 0 && (
          <span className="ml-2 font-mono text-sm font-normal text-ink-mid">
            · {formatNgn(totalLossNgn)} est. impact · {TRUST_COPY.requiresReview}
          </span>
        )}
      </p>
      <p className="mt-1 text-xs text-ink-dim">{TRUST_COPY.notVerdict}</p>
      {fuelAlerts.slice(0, 2).map((alert) => (
        <div
          key={alert.id}
          className="mt-2 flex flex-wrap items-center justify-between gap-2"
        >
          <p className="text-sm text-ink-mid">
            {alert.license_plate ? `${alert.license_plate}: ` : ''}
            {alert.message}
          </p>
          <button
            type="button"
            onClick={() => onViewOnMap(alert)}
            className="inline-flex items-center gap-1 rounded-lg border border-accent/40 bg-accent/15 px-3 py-1 text-xs font-medium text-brand hover:bg-accent/25"
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
