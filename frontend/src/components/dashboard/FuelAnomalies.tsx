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
}: {
  anomalies: FuelAnomaly[];
  liveConnected?: boolean;
  onAcknowledge: (id: string) => void;
  onViewOnMap?: (anomaly: FuelAnomaly) => void;
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const unacknowledged = anomalies.filter((a) => !a.acknowledged);
  const criticalCount = unacknowledged.filter((a) => a.severity === 'critical').length;

  const handleRefreshClick = () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 600);
  };

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-[#434656] bg-[#171f33]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#434656] px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <AlertTriangle
                className={`h-5 w-5 ${criticalCount > 0 ? 'text-[#ffb4ab]' : 'text-[#c4c5d9]'}`}
              />
              {unacknowledged.length > 0 && (
                <span className="absolute -right-2 -top-2 flex h-4 w-4 items-center justify-center rounded-full bg-[#ffb4ab] text-[10px] font-bold text-[#690005]">
                  {unacknowledged.length}
                </span>
              )}
            </div>
            <div>
              <h2 className="font-semibold text-[#dae2fd]">Fuel anomalies</h2>
              <p className="text-xs text-[#8e90a2]">Live alerts from TCP telemetry</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div
              className={`flex items-center gap-2 rounded px-2 py-1 ${
                liveConnected !== false ? 'bg-[#4edea3]/10' : 'bg-[#ffb4ab]/10'
              }`}
            >
              {liveConnected !== false ? (
                <Wifi className="h-3 w-3 text-[#4edea3]" />
              ) : (
                <WifiOff className="h-3 w-3 text-[#ffb4ab]" />
              )}
              <span
                className={`text-xs ${liveConnected !== false ? 'text-[#4edea3]' : 'text-[#ffb4ab]'}`}
              >
                {liveConnected !== false ? 'Live' : 'Reconnecting…'}
              </span>
            </div>
            <button
              type="button"
              onClick={handleRefreshClick}
              className="rounded-lg p-1.5 transition-colors hover:bg-[#2d3449]"
              aria-label="Refresh"
            >
              <RefreshCw
                className={`h-4 w-4 text-[#c4c5d9] ${refreshing ? 'animate-spin' : ''}`}
              />
            </button>
            <button
              type="button"
              onClick={() => setIsModalOpen(true)}
              className="rounded-lg p-1.5 transition-colors hover:bg-[#2d3449]"
              aria-label="Explain anomalies"
            >
              <Eye className="h-4 w-4 text-[#c4c5d9]" />
            </button>
          </div>
        </div>

        <div className="max-h-[420px] divide-y divide-[#2d3449] overflow-y-auto">
          {anomalies.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#4edea3]/10">
                <Shield className="h-6 w-6 text-[#4edea3]" />
              </div>
              <p className="text-[#c4c5d9]">Waiting for telemetry…</p>
              <p className="mt-1 text-xs text-[#8e90a2]">
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
          <div className="border-t border-[#434656] bg-[#0b1326] px-6 py-3">
            <p className="text-xs text-[#c4c5d9]">
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
      className={`px-6 py-4 ${!anomaly.acknowledged ? 'bg-[#ffb4ab]/5' : 'opacity-70'}`}
    >
      <div className="flex items-start gap-4">
        <div
          className={`shrink-0 rounded-lg p-2 ${
            isCritical ? 'bg-[#ffb4ab]/10' : 'bg-[#ffb95f]/10'
          }`}
        >
          <Icon className={`h-5 w-5 ${isCritical ? 'text-[#ffb4ab]' : 'text-[#ffb95f]'}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-[#dae2fd]">
              {anomaly.vehicle_plate ?? 'Unknown'}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                isCritical ? 'bg-[#ffb4ab]/20 text-[#ffb4ab]' : 'bg-[#ffb95f]/20 text-[#ffb95f]'
              }`}
            >
              {isCritical ? 'Critical' : 'Warning'}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                severity === 'HIGH'
                  ? 'bg-[#ffb4ab]/20 text-[#ffb4ab]'
                  : severity === 'MEDIUM'
                    ? 'bg-[#ffb95f]/20 text-[#ffb95f]'
                    : 'bg-[#8e90a2]/20 text-[#c4c5d9]'
              }`}
            >
              {severity} · {confidence}%
            </span>
            {!anomaly.acknowledged && (
              <span className="text-xs text-[#ffb4ab]">● New</span>
            )}
          </div>
          <p className="text-sm font-medium text-[#dae2fd]">{displayTitle}</p>
          {displayTitle !== anomaly.message && (
            <p className="mt-0.5 text-xs text-[#8e90a2]">{anomaly.message}</p>
          )}
          <p className="mt-0.5 text-xs text-[#c4c5d9]">{anomaly.details}</p>
          <ul className="mt-2 space-y-0.5">
            {reasons.map((line) => (
              <li key={line} className="text-xs text-[#8e90a2]">
                • {line}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-4 text-xs">
            {anomaly.liters_lost != null && (
              <span className="inline-flex items-center gap-1 font-mono text-[#ffb4ab]">
                <Fuel className="h-3 w-3" /> {anomaly.liters_lost.toFixed(1)} L lost
              </span>
            )}
            {anomaly.amount_lost_ngn != null && anomaly.amount_lost_ngn > 0 && (
              <span className="inline-flex items-center gap-1 font-mono text-[#ffb4ab]">
                <Receipt className="h-3 w-3" /> {formatNgn(anomaly.amount_lost_ngn)} est.
              </span>
            )}
            <span className="inline-flex items-center gap-1 text-[#8e90a2]">
              <Clock className="h-3 w-3" />
              {new Date(anomaly.timestamp).toLocaleString()}
            </span>
            {anomaly.latitude && anomaly.longitude && (
              <span className="inline-flex items-center gap-1 text-[#8e90a2]">
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
              className="whitespace-nowrap text-xs text-[#b8c3ff] hover:underline"
            >
              Acknowledge
            </button>
          ) : (
            <span className="flex items-center gap-1 text-xs text-[#8e90a2]">
              <CheckCircle className="h-3 w-3" /> Done
            </span>
          )}
          {onViewOnMap && anomaly.vehicle_id && (anomaly.type === 'theft' || anomaly.type === 'fraud') && (
            <button
              type="button"
              onClick={() => onViewOnMap(anomaly)}
              className="whitespace-nowrap text-xs text-[#ffb4ab] hover:underline"
            >
              View on map
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
