import { useState } from 'react';
import { MapPin, Play } from 'lucide-react';
import { Alert, formatNgn } from '@/lib/api';
import { TRUST_COPY } from '@/lib/trust-language';

/**
 * Alerts span everything from theft to a driver doing exactly the right
 * thing (filing a receipt), so severity can't be a fuel_theft/not-fuel_theft
 * switch — that put "receipt filed" in the same amber-warning card as
 * "overspeeding". Anything not listed here defaults to `warn`, since an
 * unrecognised alert type is more likely a new anomaly than routine noise.
 */
const ALERT_TONE: Record<string, 'bad' | 'warn' | 'good' | 'neutral'> = {
  fuel_theft: 'bad',
  receipt_fraud: 'bad',
  unlogged_fill: 'warn',
  excessive_idle: 'warn',
  idle_fuel_waste: 'warn',
  route_deviation: 'warn',
  fuel_discrepancy: 'warn',
  low_fuel: 'warn',
  overspeeding: 'warn',
  geofence_entry: 'neutral',
  geofence_exit: 'neutral',
  trip_start: 'neutral',
  receipt_uploaded: 'good',
};

const ALERT_TONE_CLASS: Record<'bad' | 'warn' | 'good' | 'neutral', string> = {
  bad: 'border-l-2 border-l-bad bg-bad-deep/20',
  warn: 'border-l-2 border-l-warn bg-warn-deep/20',
  good: 'border-l-2 border-l-good bg-good/10',
  neutral: 'border-l-2 border-l-ink-dim bg-panel-deep/60',
};

export function AlertsList({
  alerts,
  onViewOnMap,
  onDismiss,
}: {
  alerts: Alert[];
  onViewOnMap?: (alert: Alert) => void;
  /** Acknowledge an alert. Omitted where the list is read-only. */
  onDismiss?: (alert: Alert) => void;
}) {
  // Rows leave the list under their own animation rather than vanishing on the
  // next render — an alert that disappears the instant it is touched gives no
  // confirmation that the right one went.
  const [leaving, setLeaving] = useState<Set<Alert['id']>>(new Set());

  const dismiss = (alert: Alert) => {
    if (!onDismiss) return;
    setLeaving((prev) => new Set(prev).add(alert.id));
    window.setTimeout(() => onDismiss(alert), 260);
  };

  if (alerts.length === 0) {
    return <p className="text-sm text-ink-dim">No open alerts.</p>;
  }

  return (
    <ul className="space-y-3">
      {alerts.map((alert, i) => (
        <li
          key={alert.id}
          // Double-click rather than single: these rows are also the thing you
          // click to investigate, and a single-click dismiss would throw away
          // the alert you were trying to open.
          onDoubleClick={() => dismiss(alert)}
          title={onDismiss ? 'Double-click to dismiss' : undefined}
          style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
          className={`alert-row rounded-lg p-3 text-sm ${
            leaving.has(alert.id) ? 'is-leaving' : ''
          } ${ALERT_TONE_CLASS[ALERT_TONE[alert.alert_type] ?? 'warn']}`}
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
              {alert.alert_type === 'fuel_theft' &&
                alert.fuel_level_liters != null &&
                alert.fuel_drop_liters != null && (
                  <div className="mt-2 inline-flex items-center gap-2 rounded-lg bg-canvas px-2.5 py-1.5 font-mono text-xs">
                    <span className="text-ink-mid">
                      {(
                        Number(alert.fuel_level_liters) + Number(alert.fuel_drop_liters)
                      ).toFixed(1)}{' '}
                      L
                    </span>
                    <span className="text-ink-dim">→</span>
                    <span className="font-semibold text-bad">
                      {Number(alert.fuel_level_liters).toFixed(1)} L
                    </span>
                    <span className="text-ink-dim">before / after</span>
                  </div>
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
