'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Droplet,
  Play,
  Receipt,
  Shield,
} from 'lucide-react';
import {
  FuelEventsResponse,
  ReceiptFlagRow,
  SiphonEventRow,
  api,
  formatNgn,
} from '@/lib/api';
import { EventReplayPanel } from '@/components/dashboard/EventReplayPanel';
import { ReplayTarget } from '@/lib/replay-target';

export function countActiveFuelEvents(data: FuelEventsResponse | null) {
  if (!data) return 0;
  const siphon = data.siphon_events.filter(
    (e) => e.status !== 'resolved' && e.status !== 'false_alarm'
  ).length;
  const receipt = data.receipt_flags.filter((r) => r.status === 'flagged').length;
  return siphon + receipt;
}

export function FuelAnomaliesPanel({
  active = true,
  onViewOnMap,
}: {
  active?: boolean;
  onViewOnMap?: (lat: number, lng: number, vehicleId: string) => void;
}) {
  const [data, setData] = useState<FuelEventsResponse | null>(null);
  const [activeTab, setActiveTab] = useState<'siphon' | 'receipt'>('siphon');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [replayTarget, setReplayTarget] = useState<ReplayTarget | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<FuelEventsResponse>('/fuel-events');
      setData(result);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  const resolveSiphon = async (id: string) => {
    await api(`/fuel-events/siphon-events/${id}/resolve`, { method: 'PATCH' });
    setSelectedId(null);
    load();
  };

  const resolveReceipt = async (id: string) => {
    await api(`/fuel-events/receipts/${id}/resolve`, { method: 'PATCH' });
    load();
  };

  const siphonEvents = (data?.siphon_events ?? []).filter(
    (e) => e.status !== 'resolved' && e.status !== 'false_alarm'
  );
  const receiptFlags = (data?.receipt_flags ?? []).filter((r) => r.status === 'flagged');

  return (
    <>
      {replayTarget && (
        <EventReplayPanel target={replayTarget} onClose={() => setReplayTarget(null)} />
      )}

      <div className="rounded-lg border border-[#434656] bg-[#171f33]">
        <div className="border-b border-[#434656] px-6 py-4">
          <h2 className="flex items-center gap-2 text-xl font-bold text-[#dae2fd]">
            <AlertTriangle className="h-5 w-5 text-[#ffb4ab]" /> Fuel anomalies
          </h2>
          <p className="mt-1 text-xs text-[#8e90a2]">
            Siphon detection + receipt fraud — click Replay to see timeline, map, and OBD evidence
          </p>
        </div>

        <div className="mx-4 mt-4 rounded-lg border border-[#ffb4ab]/30 bg-[#ffb4ab]/10 p-3 sm:mx-6">
          <p className="text-xs text-[#8e90a2]">Total preventable loss</p>
          <p className="text-2xl font-bold text-[#ffb4ab]">
            {formatNgn(data?.total_preventable_loss_ngn ?? 0)}
          </p>
        </div>

        <div className="mt-4 flex border-b border-[#434656] px-2 sm:px-4">
          <TabButton
            active={activeTab === 'siphon'}
            onClick={() => setActiveTab('siphon')}
            label={`Siphon (${siphonEvents.length})`}
            icon={Droplet}
          />
          <TabButton
            active={activeTab === 'receipt'}
            onClick={() => setActiveTab('receipt')}
            label={`Receipt fraud (${receiptFlags.length})`}
            icon={Receipt}
          />
        </div>

        <div className="space-y-3 p-4 sm:p-6">
          {loading && <p className="text-sm text-[#8e90a2]">Loading…</p>}

          {activeTab === 'siphon' &&
            (siphonEvents.length === 0 ? (
              <EmptyState message="No active siphon events" />
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {siphonEvents.map((event) => (
                  <SiphonCard
                    key={event.id}
                    event={event}
                    expanded={selectedId === event.id}
                    onToggle={() => setSelectedId(selectedId === event.id ? null : event.id)}
                    onResolve={() => resolveSiphon(event.id)}
                    onReplay={() => setReplayTarget({ kind: 'siphon', id: event.id })}
                    onViewMap={() => {
                      if (event.latitude != null && event.longitude != null && onViewOnMap) {
                        onViewOnMap(Number(event.latitude), Number(event.longitude), event.vehicle_id);
                      }
                    }}
                  />
                ))}
              </div>
            ))}

          {activeTab === 'receipt' &&
            (receiptFlags.length === 0 ? (
              <EmptyState message="No receipt fraud flagged" />
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {receiptFlags.map((flag) => (
                  <ReceiptFlagCard
                    key={flag.id}
                    flag={flag}
                    onResolve={() => resolveReceipt(flag.id)}
                    onReplay={() => setReplayTarget({ kind: 'receipt', id: flag.id })}
                  />
                ))}
              </div>
            ))}
        </div>
      </div>
    </>
  );
}

function TabButton({
  active,
  onClick,
  label,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 py-3 text-xs transition-colors ${
        active ? 'border-b-2 border-[#ffb4ab] text-[#ffb4ab]' : 'text-[#8e90a2]'
      }`}
    >
      <span className="inline-flex items-center justify-center gap-1">
        <Icon className="h-3.5 w-3.5" /> {label}
      </span>
    </button>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="py-12 text-center">
      <Shield className="mx-auto mb-3 h-12 w-12 text-[#4edea3]" />
      <p className="text-[#c4c5d9]">{message}</p>
    </div>
  );
}

function SiphonCard({
  event,
  expanded,
  onToggle,
  onResolve,
  onReplay,
  onViewMap,
}: {
  event: SiphonEventRow;
  expanded: boolean;
  onToggle: () => void;
  onResolve: () => void;
  onReplay: () => void;
  onViewMap: () => void;
}) {
  return (
    <div
      className={`cursor-pointer rounded-lg border bg-[#0b1326] p-4 ${expanded ? 'border-[#b8c3ff]' : 'border-[#2d3449]'}`}
      onClick={onToggle}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="font-semibold text-[#dae2fd]">{event.vehicle_plate}</p>
          <p className="text-xs text-[#8e90a2]">{event.driver_name ?? '—'}</p>
        </div>
        <span className="rounded-full bg-[#ffb4ab]/20 px-2 py-0.5 text-xs text-[#ffb4ab]">
          {event.status}
        </span>
      </div>
      <div className="mt-2 space-y-1 text-sm">
        <Row label="Stolen" value={`${event.liters_stolen.toFixed(1)} L`} highlight />
        <Row label="Loss" value={formatNgn(event.estimated_loss_ngn)} highlight />
        <Row label="When" value={new Date(event.occurred_at).toLocaleString()} />
      </div>
      {!expanded && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onReplay();
          }}
          className="mt-3 inline-flex w-full items-center justify-center gap-1 rounded-lg border border-[#2e5bff]/40 bg-[#2e5bff]/15 py-2 text-xs font-medium text-[#b8c3ff]"
        >
          <Play className="h-3.5 w-3.5" /> Replay event
        </button>
      )}
      {expanded && (
        <div className="mt-3 border-t border-[#2d3449] pt-3" onClick={(e) => e.stopPropagation()}>
          <p className="mb-2 text-xs font-semibold text-[#8e90a2]">OBD evidence</p>
          <p className="text-xs text-[#c4c5d9]">
            {event.evidence.fuel_level_before?.toFixed(1)}L → {event.evidence.fuel_level_after?.toFixed(1)}L ·
            engine {event.evidence.engine_state_before ? 'ON' : 'OFF'} →{' '}
            {event.evidence.engine_state_after ? 'ON' : 'OFF'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onReplay}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-[#2e5bff] py-2 text-xs font-medium text-white"
            >
              <Play className="h-3.5 w-3.5" /> Replay
            </button>
            <button
              type="button"
              onClick={onResolve}
              className="flex-1 rounded-lg bg-[#4edea3] py-2 text-xs font-medium text-[#0b1326]"
            >
              Mark resolved
            </button>
            <button
              type="button"
              onClick={onViewMap}
              className="flex-1 rounded-lg border border-[#434656] py-2 text-xs text-[#c4c5d9]"
            >
              View map
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReceiptFlagCard({
  flag,
  onResolve,
  onReplay,
}: {
  flag: ReceiptFlagRow;
  onResolve: () => void;
  onReplay: () => void;
}) {
  return (
    <div className="rounded-lg border border-[#ffb4ab]/30 bg-[#0b1326] p-4">
      <p className="font-semibold text-[#dae2fd]">{flag.vehicle_plate}</p>
      <p className="text-xs text-[#8e90a2]">{flag.driver_name} · {flag.merchant_name}</p>
      <div className="mt-2 space-y-1 text-sm">
        <Row label="Receipt claimed" value={`${flag.declared_liters} L`} />
        <Row label="OBD recorded" value={`${flag.obd_actual_liters ?? '—'} L`} highlight />
        <Row label="Difference" value={`${flag.difference_liters ?? 0} L (${formatNgn(flag.estimated_loss_ngn)})`} highlight />
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onReplay}
          className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-[#2e5bff] py-2 text-xs font-medium text-white"
        >
          <Play className="h-3.5 w-3.5" /> Replay
        </button>
        <button
          type="button"
          onClick={onResolve}
          className="flex-1 rounded-lg bg-[#4edea3] py-2 text-xs font-medium text-[#0b1326]"
        >
          Resolve
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-[#8e90a2]">{label}</span>
      <span className={highlight ? 'font-mono text-[#ffb4ab]' : 'font-mono text-[#dae2fd]'}>{value}</span>
    </div>
  );
}
