'use client';

import { Fragment, useMemo, useState } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Droplet,
  Fuel,
  Gauge,
  MapPin,
  Play,
  TrendingUp,
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

  const fuelSpend =
    efficiencySummary?.total_actual_cost_ngn ??
    efficiencySummary?.total_telemetry_cost_ngn ??
    summary?.total_fuel_cost_ngn ??
    0;

  // A naira total on its own says nothing — ₦1,651 is either cheap or ruinous
  // depending on how far the fleet went for it. Everything here turns the spend
  // into rates a manager can judge, and compares them with the industry figures
  // already used as each vehicle's baseline.
  const fuelContext = useMemo(() => {
    const distanceKm = efficiencySummary?.total_distance_km ?? 0;
    const liters = efficiencySummary?.total_fuel_used_liters ?? 0;
    if (!efficiencySummary || distanceKm <= 0 || liters <= 0) return null;

    const costPerKm = fuelSpend / distanceKm;
    const kmPerLiter = distanceKm / liters;
    const litersPer100km = (liters / distanceKm) * 100;

    // Distance-weighted, so a vehicle that barely moved cannot drag the fleet
    // benchmark around.
    const weighted = efficiency.reduce(
      (acc, row) => {
        if (!row.expected_efficiency_km_l || !row.distance_km) return acc;
        return {
          km: acc.km + row.distance_km,
          weighted: acc.weighted + row.expected_efficiency_km_l * row.distance_km,
        };
      },
      { km: 0, weighted: 0 }
    );
    const benchmarkKmPerLiter = weighted.km > 0 ? weighted.weighted / weighted.km : null;
    const benchmarkCostPerKm =
      benchmarkKmPerLiter && benchmarkKmPerLiter > 0
        ? efficiencySummary.price_per_liter_ngn / benchmarkKmPerLiter
        : null;

    // What the same distance should have cost at the benchmark, and therefore
    // what was saved or overspent against it. Shown with its arithmetic so the
    // number can be checked rather than taken on trust.
    const benchmarkLiters =
      benchmarkKmPerLiter && benchmarkKmPerLiter > 0 ? distanceKm / benchmarkKmPerLiter : null;
    const benchmarkCost =
      benchmarkLiters != null ? benchmarkLiters * efficiencySummary.price_per_liter_ngn : null;
    const savedNgn = benchmarkCost != null ? benchmarkCost - fuelSpend : null;

    return {
      distanceKm,
      liters,
      costPerKm,
      kmPerLiter,
      litersPer100km,
      benchmarkKmPerLiter,
      benchmarkCostPerKm,
      benchmarkLiters,
      benchmarkCost,
      savedNgn,
      variancePercent:
        benchmarkKmPerLiter && benchmarkKmPerLiter > 0
          ? ((kmPerLiter - benchmarkKmPerLiter) / benchmarkKmPerLiter) * 100
          : null,
      monthlyRunRate: (fuelSpend / periodDays) * 30,
      pricePerLiter: efficiencySummary.price_per_liter_ngn,
    };
  }, [efficiencySummary, efficiency, fuelSpend, periodDays]);

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
        detail: `Fuel level fell ${event.liters_stolen.toFixed(1)}L while parked`,
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
            ? `Receipt ${flag.declared_liters}L · measured ${obd}L`
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
        reasons: [],
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
        detail: `Possible loss ${formatNgn(row.theft_loss_ngn)}, verify with replay`,
        reasons: [],
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
      <div className="rounded-xl border border-edge bg-panel p-8 text-center text-sm text-ink-dim">
        Loading operational snapshot…
      </div>
    );
  }

  return (
    <>
      {replayTarget && (
        <EventReplayPanel target={replayTarget} onClose={() => setReplayTarget(null)} />
      )}

      {/* 1. Snapshot bento — one hero tile carries the money so the eye has
          somewhere to land; every other tile states exactly one fact. */}
      <section>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-ink-dim">
            Operational snapshot
          </h2>
          <p className="text-xs text-ink-dim">{TRUST_COPY.notVerdict}</p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-12">
          <Tile
            tone="hero"
            className="flex flex-col p-5 sm:col-span-2 sm:p-6 lg:col-span-6 lg:row-span-2"
          >
            <div className="flex items-center gap-2 text-ink-dim">
              <Fuel className="h-4 w-4" />
              <span className="text-[10px] font-medium uppercase tracking-[0.14em]">
                Fuel spend · last {periodDays} days
              </span>
            </div>
            <p className="mt-2 text-4xl font-bold tabular-nums text-ink sm:text-5xl">
              {fuelSpend > 0 ? formatNgn(fuelSpend) : '—'}
            </p>
            <p className="mt-1.5 text-xs text-ink-dim">
              {fuelContext
                ? `${Math.round(fuelContext.distanceKm)} km · ${fuelContext.liters.toFixed(
                    1
                  )} L at ${formatNgn(fuelContext.pricePerLiter)}/L`
                : 'Telemetry-based spend'}
            </p>

            {fuelContext && (
              <div className="mt-5 grid grid-cols-2 gap-4 border-t border-edge pt-4">
                <Rate
                  label="Cost per km"
                  value={formatNgn(fuelContext.costPerKm)}
                  benchmark={
                    fuelContext.benchmarkCostPerKm != null
                      ? `vs ${formatNgn(fuelContext.benchmarkCostPerKm)} typical`
                      : null
                  }
                />
                <Rate
                  label="Economy"
                  value={`${fuelContext.kmPerLiter.toFixed(1)} km/L`}
                  benchmark={
                    fuelContext.benchmarkKmPerLiter != null
                      ? `vs ${fuelContext.benchmarkKmPerLiter.toFixed(1)} benchmark`
                      : null
                  }
                />
              </div>
            )}

            {fuelContext && fuelContext.savedNgn != null && fuelContext.benchmarkCost != null && (
              <div className="mt-4 rounded-lg border border-edge bg-canvas p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-xs text-ink-dim">
                    {fuelContext.savedNgn >= 0 ? 'Money saved' : 'Overspent'} vs benchmark (
                    {periodDays}d)
                  </p>
                  <p
                    className={`font-mono text-lg font-semibold ${
                      // Green means one thing only: money genuinely kept.
                      fuelContext.savedNgn > 0 ? 'text-good' : 'text-ink'
                    }`}
                  >
                    {formatNgn(Math.abs(fuelContext.savedNgn))}
                  </p>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-dim">
                  {Math.round(fuelContext.distanceKm)} km at the{' '}
                  {fuelContext.benchmarkKmPerLiter?.toFixed(1)} km/L benchmark ={' '}
                  {fuelContext.benchmarkLiters?.toFixed(1)} L, which at{' '}
                  {formatNgn(fuelContext.pricePerLiter)}/L is{' '}
                  {formatNgn(fuelContext.benchmarkCost)}. Actual spend was{' '}
                  {formatNgn(fuelSpend)}, a {fuelContext.savedNgn >= 0 ? 'saving' : 'shortfall'} of{' '}
                  {formatNgn(Math.abs(fuelContext.savedNgn))}.
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={() => setFinancialDetailsOpen((v) => !v)}
              className="mt-auto flex w-full items-center justify-between gap-2 pt-4 text-xs text-accent"
            >
              <span>{financialDetailsOpen ? 'Hide' : 'Show'} loss breakdown</span>
              {financialDetailsOpen ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
            {financialDetailsOpen && efficiencySummary && (
              <div className="mt-3 grid gap-x-6 gap-y-3 border-t border-edge pt-3 text-[11px] sm:grid-cols-3">
                <div>
                  <p className="text-ink-dim">Suspicious fuel patterns</p>
                  <p className="font-mono text-sm text-bad">
                    {formatNgn(efficiencySummary.total_theft_loss_ngn)}
                  </p>
                </div>
                <div>
                  <p className="text-ink-dim">Efficiency gap</p>
                  <p className="font-mono text-sm text-warn">
                    {formatNgn(efficiencySummary.total_efficiency_loss_ngn)}
                  </p>
                </div>
                <div>
                  <p className="text-ink-dim">Recoverable ({periodDays}d)</p>
                  <p className="font-mono text-sm text-ink">
                    {formatNgn(efficiencySummary.recoverable_ngn)}
                  </p>
                </div>
              </div>
            )}
          </Tile>

          <StatTile
            icon={Droplet}
            label={`Preventable loss · ${periodDays}d`}
            value={formatNgn(preventableLoss)}
            hint="Anomalies plus the efficiency gap"
            tone={preventableLoss > 0 ? 'bad' : 'good'}
            className="lg:col-span-3"
          />
          <StatTile
            icon={AlertTriangle}
            label="Active alerts"
            value={String(summary.active_alerts)}
            hint={`${summary.online_vehicles}/${summary.total_vehicles} vehicles online`}
            tone={summary.active_alerts > 0 ? 'warn' : 'good'}
            className="lg:col-span-3"
          />
          <StatTile
            icon={TrendingUp}
            label="If this week repeated all year"
            value={formatMillionsNgn(annualSavingsOpportunity)}
            hint={`Straight projection of ${formatNgn(preventableLoss)} — a scale, not a forecast`}
            className="lg:col-span-3"
          />
          <StatTile
            icon={Gauge}
            label="Fleet health"
            value={healthScore != null ? `${healthScore}/100` : '—'}
            hint="Offline trackers, open alerts, vehicles off baseline"
            tone={healthTone}
            className="lg:col-span-3"
          />
        </div>
      </section>

      {/* 2. Work bento — the queue dominates, the rail is deliberately quieter */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        <Tile className="overflow-hidden lg:col-span-8">
          {/* 2. What needs attention */}
          <div>
            <header className="border-b border-edge px-5 py-4">
              <h2 className="text-lg font-semibold text-ink">What needs attention?</h2>
              <p className="mt-0.5 text-xs text-ink-dim">
                Operational intelligence for investigations. Use evidence replay before deciding
              </p>
            </header>
            {attentionItems.length === 0 ? (
              <p className="px-5 py-8 text-sm text-good">
                No critical issues right now. Fleet is operating within expected bounds.
              </p>
            ) : (
              <ul className="divide-y divide-divider">
                {attentionItems.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-start gap-3 px-5 py-4 hover:bg-panel-hover/40"
                  >
                    <span
                      className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                        item.severity === 'critical'
                          ? 'bg-bad-deep/40 text-bad'
                          : 'bg-warn-deep/30 text-warn'
                      }`}
                    >
                      {item.severity === 'critical' ? (
                        <AlertOctagon className="h-4 w-4" />
                      ) : (
                        <AlertTriangle className="h-4 w-4" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-ink">{item.title}</p>
                        <ConfidenceBadge
                          confidence={item.confidence}
                          severity={item.severityLevel}
                        />
                      </div>
                      <p className="mt-0.5 text-sm text-ink-mid">
                        Vehicle <span className="font-mono text-ink">{item.vehicle}</span>
                        <span className="ml-2 text-ink-dim">· {item.source}</span>
                      </p>
                      <p className="mt-1 text-xs text-ink-mid">{item.detail}</p>
                      {/* One wrapped line rather than a bulleted paragraph — the
                          reasons are supporting detail, not the headline. */}
                      {item.reasons.length > 0 && (
                        <p className="mt-1.5 text-xs leading-relaxed text-ink-dim">
                          {item.reasons.join(' · ')}
                        </p>
                      )}
                      {item.lossNgn != null && item.lossNgn > 0 && (
                        <p className="mt-2 text-xs text-warn">
                          Est. impact {formatNgn(item.lossNgn)} · {TRUST_COPY.requiresReview}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                      {item.replayTarget && (
                        <button
                          type="button"
                          onClick={() => setReplayTarget(item.replayTarget!)}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-2.5 text-xs font-semibold text-white shadow-lg shadow-accent/20"
                        >
                          <Play className="h-4 w-4" /> {TRUST_COPY.investigateCta} ▶
                        </button>
                      )}
                      {item.vehicleId && (
                        <button
                          type="button"
                          onClick={() => onViewOnMap(item.vehicleId!)}
                          className="rounded-lg border border-edge px-3 py-2 text-xs text-ink-mid"
                        >
                          Live
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <footer className="border-t border-edge px-5 py-3">
              <button
                type="button"
                onClick={onOpenAnomalies}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent hover:underline"
              >
                <Play className="h-3.5 w-3.5" /> {TRUST_COPY.viewEvidenceCta}, all events
              </button>
            </footer>
          </div>
        </Tile>

        <div className="grid gap-3 sm:grid-cols-2 lg:col-span-4 lg:grid-cols-1 lg:content-start">
          {/* Evidence replay — the one tile allowed to shout */}
          <Tile tone="accent" className="p-5 sm:col-span-2 lg:col-span-1">
            <p className="text-sm font-semibold text-ink">Evidence replay</p>
            <p className="mt-1 text-xs text-ink-dim">
              Map + fuel graph + timeline — closes disputes with data, not accusations
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={onOpenAnomalies}
                className="flex items-center justify-center gap-2 rounded-lg bg-accent py-3 text-sm font-semibold text-white shadow-lg shadow-accent/25"
              >
                <Play className="h-4 w-4" /> {TRUST_COPY.viewEvidenceCta} ▶
              </button>
              <button
                type="button"
                onClick={() => onOpenLive()}
                className="rounded-lg border border-edge py-2.5 text-sm text-ink-mid"
              >
                Live monitoring map
              </button>
            </div>
          </Tile>

          {/* Vehicle health */}
          <Tile className="p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Truck className="h-4 w-4 text-ink-dim" /> Vehicle health
            </h2>
            {vehicleHealth.length === 0 ? (
              <p className="mt-3 text-sm text-good">All tracked vehicles look healthy.</p>
            ) : (
              <ul className="mt-3 divide-y divide-divider">
                {vehicleHealth.map((v) => (
                  <li key={v.id}>
                    <button
                      type="button"
                      onClick={() => onViewOnMap(v.id)}
                      className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-panel-hover"
                    >
                      <span className="font-mono text-ink">{v.plate}</span>
                      <span
                        className={
                          v.severity === 'bad'
                            ? 'text-xs text-bad'
                            : v.severity === 'warn'
                              ? 'text-xs text-warn'
                              : 'text-xs text-ink-dim'
                        }
                      >
                        {v.issue}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Tile>

          {/* Driver accountability */}
          <Tile className="p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Users className="h-4 w-4 text-ink-dim" /> Driver efficiency
            </h2>
            <ol className="mt-3 divide-y divide-divider">
              {driverRanking.length === 0 ? (
                <li className="text-sm text-ink-dim">No driver data.</li>
              ) : (
                driverRanking.map((d, i) => (
                  <li key={d.name} className="flex items-center justify-between gap-3 py-2">
                    <span className="truncate text-sm text-ink-mid">
                      <span className="mr-2 text-ink-dim">{i + 1}.</span>
                      {d.name}
                    </span>
                    <span
                      className={`font-mono text-sm font-semibold ${
                        d.score >= 75
                          ? 'text-good'
                          : d.score >= 50
                            ? 'text-warn'
                            : 'text-bad'
                      }`}
                    >
                      {d.score}/100
                      {d.score < 50 ? ' ⚠' : ''}
                    </span>
                  </li>
                ))
              )}
            </ol>
          </Tile>
        </div>
      </div>

      {/* 3. Daily fleet efficiency — full width, it is an eight-column table */}
      <section className="overflow-hidden rounded-xl border border-edge bg-panel">
        <header className="border-b border-edge px-5 py-4">
          <h2 className="font-semibold text-ink">Fleet efficiency</h2>
          <p className="mt-0.5 text-xs text-ink-dim">
            Last {efficiency[0]?.period_days ?? 7} days · tap a row for detail
          </p>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-canvas text-xs uppercase tracking-wider text-ink-dim">
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
            <tbody className="divide-y divide-divider text-ink-mid">
              {efficiency.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-6 text-ink-dim">
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
                        className="cursor-pointer hover:bg-panel-hover/50"
                        onClick={() =>
                          setExpandedVehicle(open ? null : row.vehicle_id)
                        }
                      >
                        <td className="px-5 py-3">
                          {open ? (
                            <ChevronDown className="h-4 w-4 text-ink-dim" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-ink-dim" />
                          )}
                        </td>
                        <td className="px-5 py-3 font-medium text-ink">
                          {row.license_plate}
                        </td>
                        <td className="px-5 py-3">{row.driver_name ?? '—'}</td>
                        <td className="px-5 py-3 font-mono">{row.distance_km} km</td>
                        <td className="px-5 py-3 font-mono">{row.fuel_used_liters.toFixed(1)}L</td>
                        <td className="px-5 py-3 font-mono text-ink">
                          {row.efficiency_km_l != null
                            ? `${row.efficiency_km_l.toFixed(1)} km/L`
                            : '—'}
                        </td>
                        <td className="px-5 py-3 font-mono text-ink-dim">
                          {row.expected_efficiency_km_l.toFixed(1)} km/L
                        </td>
                        <td className="px-5 py-3">
                          <StatusChip label={st.label} tone={st.tone} />
                        </td>
                      </tr>
                      {open && (
                        <tr className="bg-canvas/60">
                          <td colSpan={8} className="px-5 py-3 text-xs text-ink-dim">
                            <ul className="grid gap-1 sm:grid-cols-2">
                              <li>
                                Preventable loss:{' '}
                                <span className="text-bad">
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
                              className="mt-2 inline-flex items-center gap-1 text-accent"
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
    </>
  );
}

/* Every panel on this page is one of these, so weight is expressed by tone and
   span rather than by each card inventing its own border and background. */
function Tile({
  children,
  className = '',
  tone = 'panel',
}: {
  children: React.ReactNode;
  className?: string;
  tone?: 'panel' | 'hero' | 'accent';
}) {
  const toneCls = {
    panel: 'border-edge bg-panel',
    hero: 'border-edge bg-panel-deep',
    accent: 'border-accent/40 bg-accent/10',
  }[tone];
  return <div className={`rounded-xl border ${toneCls} ${className}`}>{children}</div>;
}

function StatTile({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'default',
  className = '',
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'good' | 'warn' | 'bad';
  className?: string;
}) {
  const valueColor = {
    default: 'text-ink',
    good: 'text-good',
    warn: 'text-warn',
    bad: 'text-bad',
  }[tone];

  return (
    <Tile className={`flex flex-col justify-between p-4 sm:p-5 ${className}`}>
      <div className="flex items-center gap-1.5 text-ink-dim">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="text-[10px] font-medium uppercase tracking-[0.14em]">{label}</span>
      </div>
      <div className="mt-3">
        <p className={`text-2xl font-bold tabular-nums ${valueColor}`}>{value}</p>
        {hint && <p className="mt-1 text-[11px] leading-snug text-ink-dim">{hint}</p>}
      </div>
    </Tile>
  );
}

function Rate({
  label,
  value,
  benchmark,
}: {
  label: string;
  value: string;
  benchmark: string | null;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.14em] text-ink-dim">{label}</p>
      <p className="mt-1 font-mono text-lg text-ink">{value}</p>
      {benchmark && <p className="text-[11px] text-ink-dim">{benchmark}</p>}
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
    good: 'bg-good/15 text-good',
    warn: 'bg-warn/15 text-warn',
    bad: 'bg-bad/15 text-bad',
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
    HIGH: 'bg-bad/20 text-bad',
    MEDIUM: 'bg-warn/20 text-warn',
    LOW: 'bg-ink-dim/20 text-ink-mid',
  }[severity];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${severityCls}`}
    >
      {severity} · {confidence}%
    </span>
  );
}
