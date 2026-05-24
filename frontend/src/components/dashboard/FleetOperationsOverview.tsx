'use client';

import { Fragment, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Droplet,
  Fuel,
  MapPin,
  Play,
  Radio,
  Shield,
  Truck,
  Users,
} from 'lucide-react';
import {
  Alert,
  DashboardSummary,
  FleetEfficiency,
  FleetEfficiencySummary,
  FleetVehicle,
  FuelAnomaly,
  FuelEventsResponse,
  formatNgn,
} from '@/lib/api';
import { EventReplayPanel } from '@/components/dashboard/EventReplayPanel';
import { ReplayTarget } from '@/lib/replay-target';
import {
  TRUST_COPY,
  anomalyConfidence,
  anomalyContextLines,
  formatMillionsNgn,
  receiptMismatchConfidence,
  receiptMismatchContextLines,
  severityLabel,
  siphonConfidence,
  siphonContextLines,
} from '@/lib/trust-language';

type AttentionItem = {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  vehicle: string;
  detail: string;
  reasons: string[];
  confidence: number;
  severityLevel: 'HIGH' | 'MEDIUM' | 'LOW';
  source: string;
  lossNgn?: number;
  replayTarget?: ReplayTarget;
  vehicleId?: string;
};

function fleetHealthScore(summary: DashboardSummary, efficiency: FleetEfficiency[]) {
  let score = 100;
  const offline = summary.total_vehicles - summary.online_vehicles;
  score -= offline * 4;
  score -= summary.active_alerts * 5;
  score -= summary.theft_alerts * 10;
  const under = efficiency.filter((e) => e.status !== 'verified').length;
  score -= under * 7;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function driverScore(row: FleetEfficiency) {
  const actual = row.efficiency_km_l;
  const expected = row.expected_efficiency_km_l;
  if (actual == null || expected <= 0) return 50;
  const ratio = actual / expected;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

function efficiencyStatus(row: FleetEfficiency): { label: string; tone: 'good' | 'warn' | 'bad' } {
  if (row.status === 'theft_alert') return { label: 'REVIEW', tone: 'warn' };
  if (row.status === 'underperforming') return { label: 'LOW', tone: 'warn' };
  const actual = row.efficiency_km_l;
  const expected = row.expected_efficiency_km_l;
  if (actual != null && expected > 0 && actual >= expected * 0.85) {
    return { label: 'GOOD', tone: 'good' };
  }
  return { label: 'OK', tone: 'good' };
}

function formatEventTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-NG', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Africa/Lagos',
  });
}

export function FleetOperationsOverview({
  summary,
  todaySummary,
  efficiency,
  efficiencySummary,
  alerts,
  anomalies,
  fuelEvents,
  fleet,
  onOpenLive,
  onOpenAnomalies,
  onViewOnMap,
}: {
  summary: DashboardSummary | null;
  todaySummary: DashboardSummary | null;
  efficiency: FleetEfficiency[];
  efficiencySummary: FleetEfficiencySummary | null;
  alerts: Alert[];
  anomalies: FuelAnomaly[];
  fuelEvents: FuelEventsResponse | null;
  fleet: FleetVehicle[];
  onOpenLive: (vehicleId?: string) => void;
  onOpenAnomalies: () => void;
  onViewOnMap: (vehicleId: string) => void;
}) {
  const [expandedVehicle, setExpandedVehicle] = useState<string | null>(null);
  const [replayTarget, setReplayTarget] = useState<ReplayTarget | null>(null);
  const [financialDetailsOpen, setFinancialDetailsOpen] = useState(false);

  const periodDays = efficiencySummary?.period_days ?? 7;
  const preventableLoss = efficiencySummary?.total_loss_ngn ?? summary?.estimated_theft_loss_ngn ?? 0;
  const annualSavingsOpportunity = Math.round((preventableLoss / periodDays) * 365);

  const healthScore = summary ? fleetHealthScore(summary, efficiency) : null;
  const healthTone =
    healthScore == null ? 'default' : healthScore >= 75 ? 'good' : healthScore >= 50 ? 'warn' : 'bad';

  const attentionItems = useMemo(() => {
    const items: AttentionItem[] = [];

    for (const event of fuelEvents?.siphon_events ?? []) {
      if (event.status === 'resolved' || event.status === 'false_alarm') continue;
      const confidence = siphonConfidence(event);
      items.push({
        id: `siphon-${event.id}`,
        severity: 'critical',
        title: TRUST_COPY.siphonTitle,
        vehicle: event.vehicle_plate,
        detail: `OBD shows −${event.liters_stolen.toFixed(1)}L while parked · ${TRUST_COPY.requiresReview}`,
        reasons: siphonContextLines(event),
        confidence,
        severityLevel: severityLabel(confidence),
        source: 'OBD + idle correlation',
        lossNgn: event.estimated_loss_ngn,
        replayTarget: { kind: 'siphon', id: event.id },
        vehicleId: event.vehicle_id,
      });
    }

    for (const flag of fuelEvents?.receipt_flags ?? []) {
      if (flag.status !== 'flagged') continue;
      const confidence = receiptMismatchConfidence(flag);
      const obd = flag.obd_actual_liters;
      items.push({
        id: `receipt-${flag.id}`,
        severity: 'warning',
        title: TRUST_COPY.receiptMismatchTitle,
        vehicle: flag.vehicle_plate,
        detail:
          obd != null
            ? `Receipt ${flag.declared_liters}L · OBD ${obd}L — ${TRUST_COPY.requiresReview}`
            : `${flag.merchant_name ?? 'Station'} · OBD match pending`,
        reasons: receiptMismatchContextLines(flag),
        confidence,
        severityLevel: severityLabel(confidence),
        source: 'Receipt + FMC150 OBD',
        lossNgn: flag.estimated_loss_ngn,
        replayTarget: { kind: 'receipt', id: flag.id },
      });
    }

    for (const alert of alerts
      .filter((a) => a.alert_type === 'fuel_theft' || a.alert_type === 'receipt_fraud')
      .slice(0, 3)) {
      const confidence = 76;
      items.push({
        id: `alert-${alert.id}`,
        severity: 'critical',
        title:
          alert.alert_type === 'receipt_fraud'
            ? TRUST_COPY.alertReceiptTitle
            : TRUST_COPY.alertFuelTitle,
        vehicle: alert.license_plate ?? 'Unknown',
        detail: alert.message,
        reasons: ['Live telemetry pattern flagged', TRUST_COPY.notVerdict],
        confidence,
        severityLevel: severityLabel(confidence),
        source: 'FMC150 telemetry',
        lossNgn: alert.estimated_loss_ngn ?? undefined,
        vehicleId: alert.vehicle_id,
      });
    }

    for (const a of anomalies.filter((x) => !x.acknowledged)) {
      const confidence = anomalyConfidence(a);
      items.push({
        id: `anomaly-${a.id}`,
        severity: a.severity === 'critical' ? 'critical' : 'warning',
        title: a.type === 'theft' ? TRUST_COPY.siphonTitle : a.message,
        vehicle: a.vehicle_plate ?? 'Unknown',
        detail: a.details,
        reasons: anomalyContextLines(a),
        confidence,
        severityLevel: severityLabel(confidence),
        source: 'Live telemetry',
        lossNgn: a.amount_lost_ngn,
        vehicleId: a.vehicle_id ?? undefined,
      });
    }

    for (const row of efficiency.filter((e) => e.status === 'underperforming').slice(0, 3)) {
      items.push({
        id: `eff-${row.vehicle_id}`,
        severity: 'warning',
        title: TRUST_COPY.efficiencyFlagTitle,
        vehicle: row.license_plate,
        detail: `${row.efficiency_km_l?.toFixed(1) ?? '—'} km/L vs ${row.expected_efficiency_km_l.toFixed(1)} km/L baseline`,
        reasons: ['Higher fuel burn than model baseline', 'May be route, load, or driving pattern'],
        confidence: 62,
        severityLevel: 'MEDIUM',
        source: 'OBD efficiency model',
        lossNgn: row.efficiency_loss_ngn,
        vehicleId: row.vehicle_id,
      });
    }

    for (const row of efficiency.filter((e) => e.status === 'theft_alert').slice(0, 2)) {
      items.push({
        id: `theft-${row.vehicle_id}`,
        severity: 'warning',
        title: TRUST_COPY.siphonTitle,
        vehicle: row.license_plate,
        detail: `Possible loss ${formatNgn(row.theft_loss_ngn)} — verify with replay`,
        reasons: ['Receipt or OBD pattern flagged', TRUST_COPY.requiresReview],
        confidence: 70,
        severityLevel: 'MEDIUM',
        source: 'OBD + receipts',
        lossNgn: row.theft_loss_ngn,
        vehicleId: row.vehicle_id,
      });
    }

    const order = { critical: 0, warning: 1, info: 2 };
    return items.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 6);
  }, [alerts, anomalies, efficiency, fuelEvents]);

  const liveFeed = useMemo(() => {
    type FeedItem = {
      id: string;
      time: string;
      label: string;
      vehicle: string;
      detail: string;
      reasons: string[];
      confidence: number;
      severityLevel: 'HIGH' | 'MEDIUM' | 'LOW';
      source: string;
      replayTarget?: ReplayTarget;
    };
    const items: FeedItem[] = [];

    for (const e of fuelEvents?.siphon_events ?? []) {
      const confidence = siphonConfidence(e);
      items.push({
        id: `s-${e.id}`,
        time: e.occurred_at,
        label: TRUST_COPY.siphonTitle,
        vehicle: e.vehicle_plate,
        detail: `Δ −${e.liters_stolen.toFixed(1)}L · est. ${formatNgn(e.estimated_loss_ngn)}`,
        reasons: siphonContextLines(e).slice(0, 3),
        confidence,
        severityLevel: severityLabel(confidence),
        source: 'OBD + idle',
        replayTarget: { kind: 'siphon', id: e.id },
      });
    }

    for (const f of fuelEvents?.receipt_flags ?? []) {
      const confidence = receiptMismatchConfidence(f);
      items.push({
        id: `r-${f.id}`,
        time: f.transaction_date,
        label: f.status === 'flagged' ? TRUST_COPY.receiptMismatchTitle : 'Refuel logged',
        vehicle: f.vehicle_plate,
        detail: `${f.declared_liters}L receipt · OBD ${f.obd_actual_liters ?? 'pending'}L`,
        reasons: receiptMismatchContextLines(f).slice(0, 3),
        confidence,
        severityLevel: severityLabel(confidence),
        source: 'Receipt + OBD',
        replayTarget: f.status === 'flagged' ? { kind: 'receipt', id: f.id } : undefined,
      });
    }

    for (const a of anomalies.slice(0, 5)) {
      const confidence = anomalyConfidence(a);
      items.push({
        id: `a-${a.id}`,
        time: a.timestamp,
        label: a.type === 'idle' ? 'Excessive idle' : TRUST_COPY.siphonTitle,
        vehicle: a.vehicle_plate ?? '—',
        detail: a.details,
        reasons: anomalyContextLines(a).slice(0, 3),
        confidence,
        severityLevel: severityLabel(confidence),
        source: 'Telemetry',
      });
    }

    return items
      .sort((x, y) => new Date(y.time).getTime() - new Date(x.time).getTime())
      .slice(0, 8);
  }, [anomalies, fuelEvents]);

  const driverRanking = useMemo(() => {
    const byDriver = new Map<string, { name: string; scores: number[]; loss: number }>();
    for (const row of efficiency) {
      const name = row.driver_name ?? 'Unassigned';
      const entry = byDriver.get(name) ?? { name, scores: [], loss: 0 };
      entry.scores.push(driverScore(row));
      entry.loss += row.total_loss_ngn;
      byDriver.set(name, entry);
    }
    return [...byDriver.values()]
      .map((d) => ({
        name: d.name,
        score: Math.round(d.scores.reduce((s, v) => s + v, 0) / Math.max(d.scores.length, 1)),
        loss: d.loss,
      }))
      .sort((a, b) => b.score - a.score);
  }, [efficiency]);

  const vehicleHealth = useMemo(() => {
    return fleet
      .map((v) => {
        const eff = efficiency.find((e) => e.vehicle_id === v.id);
        let issue = '';
        let severity: 'warn' | 'bad' | 'info' = 'info';
        if (v.connection_status === 'offline') {
          issue = 'Tracker offline';
          severity = 'bad';
        } else if (v.connection_status === 'no_device') {
          issue = 'No device linked';
          severity = 'warn';
        } else if (v.fuel_level_liters != null && Number(v.fuel_level_liters) < 15) {
          issue = `Low fuel (${Number(v.fuel_level_liters).toFixed(0)}L)`;
          severity = 'warn';
        } else if (v.ignition_on === false && (v.speed_kph ?? 0) === 0) {
          issue = 'Parked · engine off';
          severity = 'info';
        } else if (eff?.status === 'theft_alert') {
          issue = 'Flagged for review';
          severity = 'warn';
        } else if (eff?.status === 'underperforming') {
          issue = 'Below efficiency baseline';
          severity = 'warn';
        } else {
          return null;
        }
        return { plate: v.license_plate, issue, severity, id: v.id };
      })
      .filter(Boolean)
      .slice(0, 6) as Array<{
      plate: string;
      issue: string;
      severity: 'warn' | 'bad' | 'info';
      id: string;
    }>;
  }, [efficiency, fleet]);

  if (!summary) {
    return (
      <div className="rounded-xl border border-[#434656] bg-[#171f33] p-8 text-center text-sm text-[#8e90a2]">
        Loading operational snapshot…
      </div>
    );
  }

  const fuelSpend =
    efficiencySummary?.total_actual_cost_ngn ??
    efficiencySummary?.total_telemetry_cost_ngn ??
    summary.total_fuel_cost_ngn;

  return (
    <>
      {replayTarget && (
        <EventReplayPanel target={replayTarget} onClose={() => setReplayTarget(null)} />
      )}

      {/* 1. Top summary — money first, minimal */}
      <section className="rounded-xl border border-[#434656] bg-[#171f33] px-4 py-4 sm:px-6">
        <p className="mb-1 text-xs font-medium uppercase tracking-wider text-[#8e90a2]">
          Operational snapshot
        </p>
        <p className="mb-4 text-xs text-[#8e90a2]">{TRUST_COPY.notVerdict}</p>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          <MetricPill
            icon={Fuel}
            label={`Fuel spend (${periodDays}d)`}
            value={fuelSpend > 0 ? formatNgn(fuelSpend) : '—'}
            hint="Telemetry-based spend"
          />
          <MetricPill
            icon={Droplet}
            label={`Preventable loss (${periodDays}d)`}
            value={formatNgn(preventableLoss)}
            hint="Anomalies + efficiency gap"
            tone={preventableLoss > 0 ? 'bad' : 'good'}
          />
          <MetricPill
            icon={AlertTriangle}
            label="Active alerts"
            value={String(summary.active_alerts)}
            hint={`${summary.online_vehicles}/${summary.total_vehicles} vehicles online`}
            tone={summary.active_alerts > 0 ? 'warn' : 'good'}
          />
        </div>
        <button
          type="button"
          onClick={() => setFinancialDetailsOpen((v) => !v)}
          className="mt-4 flex w-full items-center justify-between rounded-lg border border-[#434656] bg-[#0b1326] px-3 py-2 text-xs text-[#b8c3ff]"
        >
          <span>{financialDetailsOpen ? 'Hide' : 'Show'} breakdown & savings projection</span>
          {financialDetailsOpen ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>
        {financialDetailsOpen && efficiencySummary && (
          <div className="mt-3 grid gap-3 border-t border-[#434656] pt-4 sm:grid-cols-2">
            <div className="rounded-lg bg-[#0b1326] p-3">
              <p className="text-xs text-[#8e90a2]">Suspicious fuel patterns</p>
              <p className="font-mono text-lg text-[#ffb4ab]">
                {formatNgn(efficiencySummary.total_theft_loss_ngn)}
              </p>
            </div>
            <div className="rounded-lg bg-[#0b1326] p-3">
              <p className="text-xs text-[#8e90a2]">Efficiency gap</p>
              <p className="font-mono text-lg text-[#ffb95f]">
                {formatNgn(efficiencySummary.total_efficiency_loss_ngn)}
              </p>
            </div>
            <div className="rounded-lg bg-[#4edea3]/10 p-3 sm:col-span-2">
              <p className="text-xs text-[#4edea3]">Potential annual savings opportunity</p>
              <p className="text-2xl font-bold text-[#dae2fd]">
                {formatMillionsNgn(annualSavingsOpportunity)}
              </p>
              <p className="mt-1 text-xs text-[#8e90a2]">
                ~{formatNgn(efficiencySummary.recoverable_ngn)} recoverable in last {periodDays}{' '}
                days if addressed
              </p>
            </div>
            {healthScore != null && (
              <div className="rounded-lg bg-[#0b1326] p-3 sm:col-span-2">
                <p className="text-xs text-[#8e90a2]">Fleet health score</p>
                <p className={`text-lg font-bold ${healthTone === 'good' ? 'text-[#4edea3]' : healthTone === 'warn' ? 'text-[#ffb95f]' : 'text-[#ffb4ab]'}`}>
                  {healthScore}/100
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          {/* 2. What needs attention */}
          <section className="rounded-xl border border-[#434656] bg-[#171f33]">
            <header className="border-b border-[#434656] px-5 py-4">
              <h2 className="text-lg font-semibold text-[#dae2fd]">What needs attention?</h2>
              <p className="mt-0.5 text-xs text-[#8e90a2]">
                Operational intelligence for investigations — use evidence replay before deciding
              </p>
            </header>
            {attentionItems.length === 0 ? (
              <p className="px-5 py-8 text-sm text-[#4edea3]">
                No critical issues right now. Fleet is operating within expected bounds.
              </p>
            ) : (
              <ul className="divide-y divide-[#2d3449]">
                {attentionItems.map((item, index) => (
                  <li key={item.id} className="flex flex-wrap items-start gap-3 px-5 py-4">
                    <span
                      className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                        item.severity === 'critical'
                          ? 'bg-[#93000a]/40 text-[#ffb4ab]'
                          : 'bg-[#996100]/30 text-[#ffb95f]'
                      }`}
                    >
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-[#dae2fd]">{item.title}</p>
                        <ConfidenceBadge
                          confidence={item.confidence}
                          severity={item.severityLevel}
                        />
                      </div>
                      <p className="mt-0.5 text-sm text-[#c4c5d9]">
                        Vehicle <span className="font-mono text-[#b8c3ff]">{item.vehicle}</span>
                        <span className="ml-2 text-[#8e90a2]">· {item.source}</span>
                      </p>
                      <p className="mt-1 text-xs text-[#c4c5d9]">{item.detail}</p>
                      <ul className="mt-2 space-y-0.5">
                        {item.reasons.map((line) => (
                          <li key={line} className="flex gap-1.5 text-xs text-[#8e90a2]">
                            <span className="text-[#b8c3ff]">•</span>
                            {line}
                          </li>
                        ))}
                      </ul>
                      {item.lossNgn != null && item.lossNgn > 0 && (
                        <p className="mt-2 text-xs text-[#ffb95f]">
                          Est. impact {formatNgn(item.lossNgn)} · {TRUST_COPY.requiresReview}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                      {item.replayTarget && (
                        <button
                          type="button"
                          onClick={() => setReplayTarget(item.replayTarget!)}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#2e5bff] px-4 py-2.5 text-xs font-semibold text-white shadow-lg shadow-[#2e5bff]/20"
                        >
                          <Play className="h-4 w-4" /> {TRUST_COPY.investigateCta} ▶
                        </button>
                      )}
                      {item.vehicleId && (
                        <button
                          type="button"
                          onClick={() => onViewOnMap(item.vehicleId!)}
                          className="rounded-lg border border-[#434656] px-3 py-2 text-xs text-[#c4c5d9]"
                        >
                          Live
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <footer className="border-t border-[#434656] px-5 py-3">
              <button
                type="button"
                onClick={onOpenAnomalies}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#b8c3ff] hover:underline"
              >
                <Play className="h-3.5 w-3.5" /> {TRUST_COPY.viewEvidenceCta} — all events
              </button>
            </footer>
          </section>

          {/* 3. Daily fleet efficiency */}
          <section className="overflow-hidden rounded-xl border border-[#434656] bg-[#171f33]">
            <header className="border-b border-[#434656] px-5 py-4">
              <h2 className="font-semibold text-[#dae2fd]">Fleet efficiency</h2>
              <p className="mt-0.5 text-xs text-[#8e90a2]">
                Last {efficiency[0]?.period_days ?? 7} days · tap a row for detail
              </p>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="bg-[#0b1326] text-xs uppercase tracking-wider text-[#8e90a2]">
                  <tr>
                    <th className="px-5 py-3" />
                    <th className="px-5 py-3">Vehicle</th>
                    <th className="px-5 py-3">Driver</th>
                    <th className="px-5 py-3">Distance</th>
                    <th className="px-5 py-3">Fuel</th>
                    <th className="px-5 py-3">Efficiency</th>
                    <th className="px-5 py-3">Baseline</th>
                    <th className="px-5 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#2d3449] text-[#c4c5d9]">
                  {efficiency.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-5 py-6 text-[#8e90a2]">
                        No efficiency data yet.
                      </td>
                    </tr>
                  ) : (
                    efficiency.map((row) => {
                      const st = efficiencyStatus(row);
                      const open = expandedVehicle === row.vehicle_id;
                      return (
                        <Fragment key={row.vehicle_id}>
                          <tr
                            className="cursor-pointer hover:bg-[#222a3d]/50"
                            onClick={() =>
                              setExpandedVehicle(open ? null : row.vehicle_id)
                            }
                          >
                            <td className="px-5 py-3">
                              {open ? (
                                <ChevronDown className="h-4 w-4 text-[#8e90a2]" />
                              ) : (
                                <ChevronRight className="h-4 w-4 text-[#8e90a2]" />
                              )}
                            </td>
                            <td className="px-5 py-3 font-medium text-[#dae2fd]">
                              {row.license_plate}
                            </td>
                            <td className="px-5 py-3">{row.driver_name ?? '—'}</td>
                            <td className="px-5 py-3 font-mono">{row.distance_km} km</td>
                            <td className="px-5 py-3 font-mono">{row.fuel_used_liters.toFixed(1)}L</td>
                            <td className="px-5 py-3 font-mono text-[#b8c3ff]">
                              {row.efficiency_km_l != null
                                ? `${row.efficiency_km_l.toFixed(1)} km/L`
                                : '—'}
                            </td>
                            <td className="px-5 py-3 font-mono text-[#8e90a2]">
                              {row.expected_efficiency_km_l.toFixed(1)} km/L
                            </td>
                            <td className="px-5 py-3">
                              <StatusChip label={st.label} tone={st.tone} />
                            </td>
                          </tr>
                          {open && (
                            <tr className="bg-[#0b1326]/60">
                              <td colSpan={8} className="px-5 py-3 text-xs text-[#8e90a2]">
                                <ul className="grid gap-1 sm:grid-cols-2">
                                  <li>
                                    Preventable loss:{' '}
                                    <span className="text-[#ffb4ab]">
                                      {formatNgn(row.total_loss_ngn)}
                                    </span>
                                  </li>
                                  <li>
                                    Suspicious patterns: {formatNgn(row.theft_loss_ngn)}
                                  </li>
                                  <li>
                                    Efficiency gap: {formatNgn(row.efficiency_loss_ngn)}
                                  </li>
                                  {row.last_purchase_merchant && (
                                    <li>
                                      Last refuel: {row.last_purchase_merchant} (
                                      {row.last_receipt_liters}L)
                                    </li>
                                  )}
                                </ul>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onViewOnMap(row.vehicle_id);
                                  }}
                                  className="mt-2 inline-flex items-center gap-1 text-[#b8c3ff]"
                                >
                                  <MapPin className="h-3 w-3" /> View on live map
                                </button>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* 4. Live fuel events */}
          <section className="rounded-xl border border-[#434656] bg-[#171f33]">
            <header className="flex items-center justify-between border-b border-[#434656] px-5 py-4">
              <div>
                <h2 className="flex items-center gap-2 font-semibold text-[#dae2fd]">
                  <Radio className="h-4 w-4 text-[#4edea3]" />
                  Fuel anomalies feed
                </h2>
                <p className="mt-0.5 text-xs text-[#8e90a2]">
                  Confidence, context, and replay for each flag
                </p>
              </div>
              <span className="rounded-full bg-[#4edea3]/15 px-2 py-0.5 text-[10px] uppercase text-[#4edea3]">
                Live
              </span>
            </header>
            {liveFeed.length === 0 ? (
              <p className="px-5 py-6 text-sm text-[#8e90a2]">No recent fuel events.</p>
            ) : (
              <ul className="divide-y divide-[#2d3449]">
                {liveFeed.map((item) => (
                  <li key={item.id} className="px-5 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs text-[#b8c3ff]">
                            {formatEventTime(item.time)}
                          </span>
                          <ConfidenceBadge
                            confidence={item.confidence}
                            severity={item.severityLevel}
                          />
                        </div>
                        <p className="mt-1 text-sm font-medium text-[#dae2fd]">{item.label}</p>
                        <p className="text-xs text-[#c4c5d9]">
                          {item.vehicle} · {item.detail}
                        </p>
                        <p className="mt-1 text-[10px] uppercase text-[#8e90a2]">
                          Why flagged
                        </p>
                        <ul className="mt-0.5 space-y-0.5">
                          {item.reasons.map((line) => (
                            <li key={line} className="text-xs text-[#8e90a2]">
                              • {line}
                            </li>
                          ))}
                        </ul>
                      </div>
                      {item.replayTarget && (
                        <button
                          type="button"
                          onClick={() => setReplayTarget(item.replayTarget!)}
                          className="shrink-0 rounded-lg border border-[#2e5bff]/50 bg-[#2e5bff]/15 px-3 py-2 text-xs font-medium text-[#b8c3ff]"
                        >
                          <Play className="mr-1 inline h-3 w-3" />
                          {TRUST_COPY.investigateCta} ▶
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="space-y-6">
          {/* 6. Hero loss card — product anchor */}
          <section className="rounded-xl border border-[#ffb4ab]/25 bg-gradient-to-b from-[#93000a]/20 to-[#171f33] p-5">
            <p className="text-xs uppercase tracking-wider text-[#ffb4ab]">
              Your {periodDays}-day preventable fuel loss
            </p>
            <p className="mt-2 text-3xl font-bold text-[#dae2fd]">{formatNgn(preventableLoss)}</p>
            <p className="mt-2 text-sm text-[#4edea3]">
              Potential annual savings opportunity:{' '}
              <span className="font-semibold">{formatMillionsNgn(annualSavingsOpportunity)}</span>
            </p>
            <p className="mt-2 text-xs text-[#8e90a2]">
              Investigate flagged events before treating as final — sensor and receipt evidence
              available.
            </p>
          </section>

          {/* 7. Vehicle health */}
          <section className="rounded-xl border border-[#434656] bg-[#171f33] p-5">
            <h2 className="flex items-center gap-2 font-semibold text-[#dae2fd]">
              <Truck className="h-4 w-4" /> Vehicle health
            </h2>
            {vehicleHealth.length === 0 ? (
              <p className="mt-3 text-sm text-[#4edea3]">All tracked vehicles look healthy.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {vehicleHealth.map((v) => (
                  <li key={v.id}>
                    <button
                      type="button"
                      onClick={() => onViewOnMap(v.id)}
                      className="flex w-full items-center justify-between rounded-lg border border-[#434656] bg-[#0b1326] px-3 py-2 text-left text-sm hover:bg-[#222a3d]"
                    >
                      <span className="font-mono text-[#b8c3ff]">{v.plate}</span>
                      <span
                        className={
                          v.severity === 'bad'
                            ? 'text-[#ffb4ab]'
                            : v.severity === 'warn'
                              ? 'text-[#ffb95f]'
                              : 'text-[#8e90a2]'
                        }
                      >
                        {v.issue}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 8. Driver accountability */}
          <section className="rounded-xl border border-[#434656] bg-[#171f33] p-5">
            <h2 className="flex items-center gap-2 font-semibold text-[#dae2fd]">
              <Users className="h-4 w-4" /> Driver efficiency
            </h2>
            <ol className="mt-3 space-y-2">
              {driverRanking.length === 0 ? (
                <li className="text-sm text-[#8e90a2]">No driver data.</li>
              ) : (
                driverRanking.map((d, i) => (
                  <li
                    key={d.name}
                    className="flex items-center justify-between rounded-lg border border-[#434656] bg-[#0b1326] px-3 py-2"
                  >
                    <span className="text-sm text-[#c4c5d9]">
                      <span className="mr-2 text-[#8e90a2]">{i + 1}.</span>
                      {d.name}
                    </span>
                    <span
                      className={`font-mono text-sm font-semibold ${
                        d.score >= 75
                          ? 'text-[#4edea3]'
                          : d.score >= 50
                            ? 'text-[#ffb95f]'
                            : 'text-[#ffb4ab]'
                      }`}
                    >
                      {d.score}/100
                      {d.score < 50 ? ' ⚠' : ''}
                    </span>
                  </li>
                ))
              )}
            </ol>
          </section>

          {/* Evidence replay — primary differentiator */}
          <section className="rounded-xl border-2 border-[#2e5bff]/40 bg-[#2e5bff]/10 p-5">
            <p className="text-sm font-semibold text-[#dae2fd]">Evidence replay</p>
            <p className="mt-1 text-xs text-[#8e90a2]">
              Map + fuel graph + timeline — closes disputes with data, not accusations
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={onOpenAnomalies}
                className="flex items-center justify-center gap-2 rounded-lg bg-[#2e5bff] py-3 text-sm font-semibold text-white shadow-lg shadow-[#2e5bff]/25"
              >
                <Play className="h-4 w-4" /> {TRUST_COPY.viewEvidenceCta} ▶
              </button>
              <button
                type="button"
                onClick={() => onOpenLive()}
                className="rounded-lg border border-[#434656] py-2.5 text-sm text-[#c4c5d9]"
              >
                Live monitoring map
              </button>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function MetricPill({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'default',
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  const valueColor = {
    default: 'text-[#dae2fd]',
    good: 'text-[#4edea3]',
    warn: 'text-[#ffb95f]',
    bad: 'text-[#ffb4ab]',
  }[tone];

  return (
    <div>
      <div className="flex items-center gap-1.5 text-[#8e90a2]">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-[10px] uppercase tracking-wider">{label}</span>
      </div>
      <p className={`mt-1 text-xl font-bold tabular-nums sm:text-2xl ${valueColor}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[10px] text-[#8e90a2]">{hint}</p>}
    </div>
  );
}

function StatusChip({
  label,
  tone,
}: {
  label: string;
  tone: 'good' | 'warn' | 'bad';
}) {
  const cls = {
    good: 'bg-[#4edea3]/15 text-[#4edea3]',
    warn: 'bg-[#ffb95f]/15 text-[#ffb95f]',
    bad: 'bg-[#ffb4ab]/15 text-[#ffb4ab]',
  }[tone];
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${cls}`}>
      {label}
    </span>
  );
}

function ConfidenceBadge({
  confidence,
  severity,
}: {
  confidence: number;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
}) {
  const severityCls = {
    HIGH: 'bg-[#ffb4ab]/20 text-[#ffb4ab]',
    MEDIUM: 'bg-[#ffb95f]/20 text-[#ffb95f]',
    LOW: 'bg-[#8e90a2]/20 text-[#c4c5d9]',
  }[severity];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${severityCls}`}
    >
      {severity} · {confidence}%
    </span>
  );
}
