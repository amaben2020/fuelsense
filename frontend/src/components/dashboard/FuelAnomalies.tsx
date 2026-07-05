'use client';

import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Droplet,
  Eye,
  Fuel,
  MapPin,
  Receipt,
  RefreshCw,
  Shield,
  TrendingDown,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { FuelAnomaly, formatNgn } from '@/lib/api';
import { TRUST_COPY, anomalyConfidence, anomalyContextLines, severityLabel } from '@/lib/trust-language';
import { FuelAnomalyModal } from './FuelAnomalyModal';

export function FuelAnomalies({
  anomalies,
  liveConnected,
  onAcknowledge,
  onViewOnMap,
  onRefresh,
}: {
  anomalies: FuelAnomaly[];
  liveConnected?: boolean;
  onAcknowledge: (id: string) => void;
  onViewOnMap?: (anomaly: FuelAnomaly) => void;
  onRefresh?: () => void;
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const unacknowledged = anomalies.filter((a) => !a.acknowledged);
  const criticalCount = unacknowledged.filter((a) => a.severity === 'critical').length;

  const handleRefreshClick = () => {
    setRefreshing(true);
    onRefresh?.();
    setTimeout(() => setRefreshing(false), 800);
  };

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-edge bg-panel">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-edge px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <AlertTriangle
                className={`h-5 w-5 ${criticalCount > 0 ? 'text-bad' : 'text-ink-mid'}`}
              />
              {unacknowledged.length > 0 && (
                <span className="absolute -right-2 -top-2 flex h-4 w-4 items-center justify-center rounded-full bg-bad text-[10px] font-bold text-bad-ink">
                  {unacknowledged.length}
                </span>
              )}
            </div>
            <div>
              <h2 className="font-semibold text-ink">Fuel anomalies</h2>
              <p className="text-xs text-ink-dim">Live alerts from TCP telemetry</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div
              className={`flex items-center gap-2 rounded px-2 py-1 ${
                liveConnected !== false ? 'bg-good/10' : 'bg-bad/10'
              }`}
            >
              {liveConnected !== false ? (
                <Wifi className="h-3 w-3 text-good" />
              ) : (
                <WifiOff className="h-3 w-3 text-bad" />
              )}
              <span
                className={`text-xs ${liveConnected !== false ? 'text-good' : 'text-bad'}`}
              >
                {liveConnected !== false ? 'Live' : 'Reconnecting…'}
              </span>
            </div>
            <button
              type="button"
              onClick={handleRefreshClick}
              className="rounded-lg p-1.5 transition-colors hover:bg-divider"
              aria-label="Refresh"
            >
              <RefreshCw
                className={`h-4 w-4 text-ink-mid ${refreshing ? 'animate-spin' : ''}`}
              />
            </button>
            <button
              type="button"
              onClick={() => setIsModalOpen(true)}
              className="rounded-lg p-1.5 transition-colors hover:bg-divider"
              aria-label="Explain anomalies"
            >
              <Eye className="h-4 w-4 text-ink-mid" />
            </button>
          </div>
        </div>

        <div className="max-h-[420px] divide-y divide-divider overflow-y-auto">
          {anomalies.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-good/10">
                <Shield className="h-6 w-6 text-good" />
              </div>
              <p className="text-ink-mid">Waiting for telemetry…</p>
              <p className="mt-1 text-xs text-ink-dim">
                Fleet simulator sends live GPS, fuel, and odometer every 4s. Anomaly flags appear
                within ~1 minute.
              </p>
            </div>
          ) : (
            anomalies.map((anomaly) => (
              <AnomalyRow
                key={anomaly.id}
                anomaly={anomaly}
                onAcknowledge={onAcknowledge}
                onViewOnMap={onViewOnMap}
              />
            ))
          )}
        </div>

        {anomalies.length > 0 && (
          <div className="border-t border-edge bg-canvas px-6 py-3">
            <p className="text-xs text-ink-mid">
              {unacknowledged.length} unacknowledged{' '}
              {unacknowledged.length === 1 ? 'alert' : 'alerts'}
            </p>
          </div>
        )}
      </div>

      <FuelAnomalyModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
    </>
  );
}

function AnomalyRow({
  anomaly,
  onAcknowledge,
  onViewOnMap,
}: {
  anomaly: FuelAnomaly;
  onAcknowledge: (id: string) => void;
  onViewOnMap?: (anomaly: FuelAnomaly) => void;
}) {
  const isCritical = anomaly.severity === 'critical';
  const confidence = anomalyConfidence(anomaly);
  const severity = severityLabel(confidence);
  const reasons = anomalyContextLines(anomaly);
  const displayTitle =
    anomaly.type === 'theft' || anomaly.type === 'fraud'
      ? TRUST_COPY.siphonTitle
      : anomaly.message;
  const Icon =
    anomaly.type === 'theft' || anomaly.type === 'fraud'
      ? Droplet
      : anomaly.type === 'idle'
        ? Clock
        : TrendingDown;

  return (
    <div
      className={`px-6 py-4 ${!anomaly.acknowledged ? 'bg-bad/5' : 'opacity-70'}`}
    >
      <div className="flex items-start gap-4">
        <div
          className={`shrink-0 rounded-lg p-2 ${
            isCritical ? 'bg-bad/10' : 'bg-warn/10'
          }`}
        >
          <Icon className={`h-5 w-5 ${isCritical ? 'text-bad' : 'text-warn'}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-ink">
              {anomaly.vehicle_plate ?? 'Unknown'}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                isCritical ? 'bg-bad/20 text-bad' : 'bg-warn/20 text-warn'
              }`}
            >
              {isCritical ? 'Critical' : 'Warning'}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                severity === 'HIGH'
                  ? 'bg-bad/20 text-bad'
                  : severity === 'MEDIUM'
                    ? 'bg-warn/20 text-warn'
                    : 'bg-ink-dim/20 text-ink-mid'
              }`}
            >
              {severity} · {confidence}%
            </span>
            {!anomaly.acknowledged && (
              <span className="text-xs text-bad">● New</span>
            )}
          </div>
          <p className="text-sm font-medium text-ink">{displayTitle}</p>
          {displayTitle !== anomaly.message && (
            <p className="mt-0.5 text-xs text-ink-dim">{anomaly.message}</p>
          )}
          <p className="mt-0.5 text-xs text-ink-mid">{anomaly.details}</p>
          <ul className="mt-2 space-y-0.5">
            {reasons.map((line) => (
              <li key={line} className="text-xs text-ink-dim">
                • {line}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-4 text-xs">
            {anomaly.liters_lost != null && (
              <span className="inline-flex items-center gap-1 font-mono text-bad">
                <Fuel className="h-3 w-3" /> {anomaly.liters_lost.toFixed(1)} L lost
              </span>
            )}
            {anomaly.amount_lost_ngn != null && anomaly.amount_lost_ngn > 0 && (
              <span className="inline-flex items-center gap-1 font-mono text-bad">
                <Receipt className="h-3 w-3" /> {formatNgn(anomaly.amount_lost_ngn)} est.
              </span>
            )}
            <span className="inline-flex items-center gap-1 text-ink-dim">
              <Clock className="h-3 w-3" />
              {new Date(anomaly.timestamp).toLocaleString()}
            </span>
            {anomaly.latitude && anomaly.longitude && (
              <span className="inline-flex items-center gap-1 text-ink-dim">
                <MapPin className="h-3 w-3" />
                {Number(anomaly.latitude).toFixed(4)}, {Number(anomaly.longitude).toFixed(4)}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          {!anomaly.acknowledged ? (
            <button
              type="button"
              onClick={() => onAcknowledge(anomaly.id)}
              className="whitespace-nowrap text-xs text-brand hover:underline"
            >
              Acknowledge
            </button>
          ) : (
            <span className="flex items-center gap-1 text-xs text-ink-dim">
              <CheckCircle className="h-3 w-3" /> Done
            </span>
          )}
          {onViewOnMap && anomaly.vehicle_id && (anomaly.type === 'theft' || anomaly.type === 'fraud') && (
            <button
              type="button"
              onClick={() => onViewOnMap(anomaly)}
              className="whitespace-nowrap text-xs text-bad hover:underline"
            >
              View on map
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
