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
  Truck,
  Users,
  X,
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
  kmLToMpg,
} from '@/lib/api';
import { DistanceBreakdownCard } from '@/components/dashboard/DistanceBreakdownCard';
import { EventReplayPanel } from '@/components/dashboard/EventReplayPanel';
import { IconTile } from '@/components/ui/chrome';
import { ReplayTarget } from '@/lib/replay-target';
import {
  TRUST_COPY,
  anomalyConfidence,
  anomalyContextLines,
  lossReasonLines,
  lossReasonSummary,
  receiptMismatchConfidence,
  receiptMismatchContextLines,
  severityLabel,
  siphonConfidence,
  siphonContextLines,
} from '@/lib/trust-language';

/**
 * Minimum share of the fuel a distance should have burned that must actually
 * appear in the tracker's measurements before a km/L or ₦/km ratio is shown.
 *
 * Mirrors `FUEL_COVERAGE_FLOOR` in the backend's driver report, which withholds
 * the same ratio for the same reason. Kept in step by hand: the two must agree,
 * or the driver panel and the fleet panel disagree about the same vehicle.
 */
const FUEL_COVERAGE_FLOOR = 0.6;

function activityDateKey(iso: string) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}

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

/**
 * Driving/fuel health only — not connectivity.
 *
 * Connectivity already has its own number: the "Active alerts" tile's
 * "N/M vehicles online" line. Folding `offline * 4` in here too meant a
 * single-vehicle pilot with one disconnected tracker could never score above
 * ~96 no matter how well the vehicle was driven, and worse, every open alert
 * — including the routine, informational ones like a driver simply filing a
 * receipt — cost 5 points apiece. On a real fleet that accumulates a dozen
 * alerts in a week, that alone floors the score before theft or efficiency
 * are even weighed, which is exactly the "looks broken, not unhealthy"
 * problem: two different questions (is the fleet reachable, is it being
 * driven and fuelled well) were being answered with one number.
 */
function fleetHealthScore(summary: DashboardSummary, efficiency: FleetEfficiency[]) {
  let score = 100;
  // Only alerts that actually indicate a driving/fuel problem count here —
  // reuses the same bad/warn severity classification the alerts feed itself
  // uses, so a receipt upload or a routine trip-start note never touches
  // this score. Weighted lighter than before: one open alert is a thing to
  // look at, not a tenth of the fleet's health gone.
  const concerning = summary.active_alerts - summary.theft_alerts;
  score -= concerning * 2;
  score -= summary.theft_alerts * 10;
  const under = efficiency.filter((e) => e.status !== 'verified').length;
  score -= under * 7;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Vehicles reachable right now — the connectivity half of "is this fleet
 *  even being watched", kept separate from driving/fuel health. */
function connectivityScore(summary: DashboardSummary): number {
  if (summary.total_vehicles <= 0) return 100;
  return Math.round((summary.online_vehicles / summary.total_vehicles) * 100);
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
  periodDays: periodDaysProp,
  onPeriodChange,
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
  /** Days the snapshot aggregates over; the API caps this at 90. */
  periodDays: number;
  onPeriodChange: (days: number) => void;
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
  // The naira-per-km figure and the litre-by-litre reconciliation below it are
  // the two things a manager actually budgets and argues against — starting
  // collapsed buried the best evidence on the page behind a click nobody knew
  // to make.
  const [financialDetailsOpen, setFinancialDetailsOpen] = useState(true);
  /** The row whose full evidence is open. Null = queue view. */
  const [detailItem, setDetailItem] = useState<AttentionItem | null>(null);

  // Prefer what the API actually aggregated over what was asked for, so the
  // label never claims a window the data does not cover.
  const periodDays = efficiencySummary?.period_days ?? periodDaysProp;
  const preventableLoss = efficiencySummary?.total_loss_ngn ?? summary?.estimated_theft_loss_ngn ?? 0;

  // Only receipts are money that actually left someone's hands. The telemetry
  // figure is fuel *burned*, and falling back to it under a "paid at the pump"
  // caption reported ₦52 of idling as a pump purchase on a day with no receipts.
  const pumpSpend = efficiencySummary?.total_actual_cost_ngn ?? 0;
  const fuelSpend =
    efficiencySummary?.total_actual_cost_ngn ??
    efficiencySummary?.total_telemetry_cost_ngn ??
    summary?.total_fuel_cost_ngn ??
    0;

  // A naira total on its own says nothing — ₦1,651 is either cheap or ruinous
  // depending on how far the fleet went for it. Everything here turns the spend
  // into rates a manager can judge, and compares them with the industry figures
  // already used as each vehicle's baseline.
  //
  // Every rate below is costed on fuel *burned*, never on what was paid at the
  // pump. A ₦15,000 fill against 11 km of driving is not a ₦1,364/km vehicle —
  // most of that fuel is still in the tank. Spend and burn are different
  // questions and mixing them produced a fictional "overspend".
  const fuelContext = useMemo(() => {
    const distanceKm = efficiencySummary?.total_distance_km ?? 0;
    const liters = efficiencySummary?.total_fuel_used_liters ?? 0;
    if (!efficiencySummary || distanceKm <= 0 || liters <= 0) return null;

    const burnedCost =
      efficiencySummary.total_telemetry_cost_ngn ??
      liters * efficiencySummary.price_per_liter_ngn;
    const costPerKm = burnedCost / distanceKm;
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

    // What this distance should have burned at the benchmark, and therefore how
    // much of the burn was extra. Both sides are modelled litres rather than
    // sensed ones, so this is a comparison of two estimates — useful for
    // spotting drift, not proof of loss. Shown with its arithmetic so the
    // number can be checked.
    const benchmarkLiters =
      efficiencySummary.total_expected_fuel_liters ??
      (benchmarkKmPerLiter && benchmarkKmPerLiter > 0 ? distanceKm / benchmarkKmPerLiter : null);
    const benchmarkCost =
      efficiencySummary.total_expected_cost_ngn ??
      (benchmarkLiters != null ? benchmarkLiters * efficiencySummary.price_per_liter_ngn : null);
    const savedNgn = benchmarkCost != null ? benchmarkCost - burnedCost : null;
    const savedLiters = benchmarkLiters != null ? benchmarkLiters - liters : null;

    // Whether enough of the fuel this distance must have burned actually
    // reached the tracker for a ratio to mean anything.
    //
    // The per-vehicle rows already carry this judgement — the API returns
    // `efficiency_km_l: null` below a 0.6 coverage floor — but this panel
    // divides the summary totals itself and so bypassed it. With AVL 12
    // under-reporting, 3.58 km against 0.1 measured litres was published as
    // "40.0 km/L" and "₦42/km vs ₦186 typical": a RAV4 apparently beating its
    // benchmark six-fold. The same floor is applied here, against the expected
    // litres the summary already provides.
    const fuelCoverage =
      benchmarkLiters != null && benchmarkLiters > 0 ? liters / benchmarkLiters : null;
    const fuelComplete = fuelCoverage == null || fuelCoverage >= FUEL_COVERAGE_FLOOR;

    // What this period's fuel actually averaged, derived from the cost the
    // backend already priced per period rather than from any single declared
    // figure. Falls back to the current price only when nothing was burned.
    const blendedPricePerLiter =
      liters > 0 ? burnedCost / liters : efficiencySummary.price_per_liter_ngn;

    // What idling cost, in the unit a manager already thinks in.
    //
    // This replaces an "Economy 12.6 mpg vs benchmark" readout that could not
    // fail. The tank is modelled — every litre is charged as distance × the
    // rate entered on the vehicle, plus idle time × the idle rate — so
    // distance ÷ litres just returns the entered rate diluted by idling. It
    // agreed with the vehicle's own settings by construction and told the
    // manager nothing about the vehicle.
    //
    // The same two numbers do say something real once the idle share is split
    // out: how much economy idling is costing, which is a thing a manager can
    // act on. It is still arithmetic on a model, so it is labelled as such.
    const idleLiters = efficiencySummary.total_idle_fuel_liters ?? 0;
    const drivingLiters = liters - idleLiters;
    const ratedKmPerLiter = drivingLiters > 0 ? distanceKm / drivingLiters : null;
    const idleDrag = {
      idleLiters,
      idleHours: efficiencySummary.total_idle_hours ?? 0,
      idleCost: idleLiters * blendedPricePerLiter,
      ratedKmPerLiter,
      // Only meaningful when some of the burn was actually idle.
      idleDragKmPerLiter:
        ratedKmPerLiter != null && idleLiters > 0 ? ratedKmPerLiter - kmPerLiter : null,
    };

    return {
      distanceKm,
      liters,
      burnedCost,
      costPerKm,
      kmPerLiter,
      blendedPricePerLiter,
      fuelCoverage,
      fuelComplete,
      litersPer100km,
      benchmarkKmPerLiter,
      benchmarkCostPerKm,
      benchmarkLiters,
      benchmarkCost,
      savedNgn,
      savedLiters,
      variancePercent:
        benchmarkKmPerLiter && benchmarkKmPerLiter > 0
          ? ((kmPerLiter - benchmarkKmPerLiter) / benchmarkKmPerLiter) * 100
          : null,
      monthlyRunRate: (burnedCost / periodDays) * 30,
      pricePerLiter: efficiencySummary.price_per_liter_ngn,
      ...idleDrag,
    };
  }, [efficiencySummary, efficiency, periodDays]);

  const lossLines = useMemo(
    () => lossReasonLines(efficiencySummary?.loss_reason),
    [efficiencySummary]
  );

  const healthScore = summary ? fleetHealthScore(summary, efficiency) : null;
  const healthTone =
    healthScore == null ? 'default' : healthScore >= 75 ? 'good' : healthScore >= 50 ? 'warn' : 'bad';
  const connScore = summary ? connectivityScore(summary) : null;
  const offlineCount = summary ? summary.total_vehicles - summary.online_vehicles : 0;

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
        // Without this, "Fill with no receipt" / "Off expected route" /
        // "Excessive idling" rows — most of what actually lands in this list —
        // had no way to open a replay at all, in the modal or from the tile's
        // own "View evidence replay" CTA.
        //
        // No `at` here deliberately: `a.timestamp` is when this alert row was
        // *written* by a sweep job, not when the incident happened — it can
        // trail the real event by hours. The replay's SQL hard-filters to a
        // ±5-minute window around `at`, so centering on the wrong moment
        // doesn't just mis-scrub the timeline, it returns zero rows. Leaving
        // `at` unset loads the whole day instead, same as `buildDailyReplay`
        // already falls back to when a centred window comes up empty.
        replayTarget: a.vehicle_id
          ? {
              kind: 'daily',
              vehicleId: a.vehicle_id,
              activityDate: activityDateKey(a.timestamp),
            }
          : undefined,
      });
    }

    for (const row of efficiency.filter((e) => e.status === 'underperforming').slice(0, 3)) {
      items.push({
        id: `eff-${row.vehicle_id}`,
        severity: 'warning',
        title: TRUST_COPY.efficiencyFlagTitle,
        vehicle: row.license_plate,
        detail: `${row.efficiency_km_l?.toFixed(1) ?? '—'} km/L vs ${row.expected_efficiency_km_l.toFixed(1)} km/L baseline`,
        // Measured causes, not guesses about route or load.
        reasons: lossReasonLines(row.loss_reason),
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

  // Mirrors the real snapshot grid below — same tile spans, same row height —
  // so nothing reflows once `summary` lands and this swaps for the real cards.
  if (!summary) {
    return (
      <section role="status" aria-live="polite" aria-label="Loading operational snapshot">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-ink-dim">
            Operational snapshot
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-12">
          <div className="flex flex-col rounded-xl border border-edge bg-panel-deep p-5 sm:col-span-2 sm:p-6 lg:col-span-6 lg:row-span-2">
            <span className="skeleton-shimmer h-3 w-40 rounded-full" />
            <span className="skeleton-shimmer mt-4 h-12 w-56 rounded-lg" />
            <span className="skeleton-shimmer mt-3 h-3 w-64 rounded-full" />
            <span className="skeleton-shimmer mt-2 h-3 w-72 rounded-full" />
            <div className="mt-6 grid grid-cols-2 gap-4 border-t border-edge pt-5">
              <span className="skeleton-shimmer h-8 w-20 rounded-lg" />
              <span className="skeleton-shimmer h-8 w-20 rounded-lg" />
            </div>
          </div>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-edge bg-panel p-5 lg:col-span-3">
              <div className="flex items-start gap-2.5">
                <span className="skeleton-shimmer h-11 w-11 shrink-0 rounded-2xl" />
                <span className="skeleton-shimmer mt-1 h-3 w-20 rounded-full" />
              </div>
              <span className="skeleton-shimmer mt-4 block h-8 w-16 rounded-lg" />
              <span className="skeleton-shimmer mt-3 block h-3 w-full rounded-full" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <>
      {replayTarget && (
        <EventReplayPanel target={replayTarget} onClose={() => setReplayTarget(null)} />
      )}

      {/* Full evidence for one queue row. Everything the compact row omits
          lives here, so the queue stays scannable without losing the detail a
          manager needs before putting anything to a driver. */}
      {detailItem && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label={detailItem.title}
          onClick={() => setDetailItem(null)}
        >
          <div
            className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-edge bg-panel sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 border-b border-edge px-5 py-4">
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                  detailItem.severity === 'critical'
                    ? 'bg-bad-deep/40 text-bad'
                    : 'bg-warn-deep/30 text-warn'
                }`}
              >
                {detailItem.severity === 'critical' ? (
                  <AlertOctagon className="h-5 w-5" />
                ) : (
                  <AlertTriangle className="h-5 w-5" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-bold tracking-tight text-ink">{detailItem.title}</h3>
                  <ConfidenceBadge
                    confidence={detailItem.confidence}
                    severity={detailItem.severityLevel}
                  />
                </div>
                <p className="mt-0.5 text-xs text-ink-dim">
                  Vehicle <span className="font-mono text-ink-mid">{detailItem.vehicle}</span> ·{' '}
                  {detailItem.source}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDetailItem(null)}
                aria-label="Close"
                className="shrink-0 rounded-lg p-1 text-ink-dim hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 px-5 py-4">
              <p className="text-sm leading-relaxed text-ink-mid">{detailItem.detail}</p>

              {detailItem.reasons.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
                    How this was determined
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {detailItem.reasons.map((reason) => (
                      <li key={reason} className="flex gap-2 text-xs leading-relaxed text-ink-mid">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-warn" />
                        {reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {detailItem.lossNgn != null && detailItem.lossNgn > 0 && (
                <div className="rounded-xl border border-warn/30 bg-warn-deep/15 px-4 py-3">
                  <p className="text-sm font-semibold text-warn">
                    Est. impact {formatNgn(detailItem.lossNgn)}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-dim">{TRUST_COPY.requiresReview}</p>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {detailItem.replayTarget && (
                  <button
                    type="button"
                    onClick={() => {
                      setReplayTarget(detailItem.replayTarget!);
                      setDetailItem(null);
                    }}
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent-y px-4 py-2.5 text-xs font-semibold text-accent-y-ink"
                  >
                    <Play className="h-4 w-4" /> {TRUST_COPY.investigateCta}
                  </button>
                )}
                {detailItem.vehicleId && (
                  <button
                    type="button"
                    onClick={() => {
                      onViewOnMap(detailItem.vehicleId!);
                      setDetailItem(null);
                    }}
                    className="rounded-xl border border-edge px-4 py-2.5 text-xs font-medium text-ink-mid hover:bg-panel-hover"
                  >
                    View live
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 1. Snapshot bento — one hero tile carries the money so the eye has
          somewhere to land; every other tile states exactly one fact. */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-ink-dim">
              Operational snapshot
            </h2>
            {/* Real windows only. The summary API caps `days` at 90, so an
                annual option could not be backed by data. */}
            <label className="relative inline-flex items-center">
              <span className="sr-only">Snapshot period</span>
              <select
                value={periodDaysProp}
                onChange={(e) => onPeriodChange(Number(e.target.value))}
                className="appearance-none rounded-full border border-edge bg-panel py-1.5 pl-3.5 pr-8 text-xs font-medium text-ink focus:border-accent-y focus:outline-none"
              >
                <option value={1}>Today</option>
                <option value={7}>Last 7 days</option>
                <option value={30}>Last 30 days</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-ink-dim" />
            </label>
          </div>
          <p className="text-xs text-ink-dim">{TRUST_COPY.notVerdict}</p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-12">
          <Tile
            tone="hero"
            className="flex flex-col p-5 sm:col-span-2 sm:p-6 lg:col-span-6 lg:row-span-2"
          >
            <div className="flex items-center gap-2.5 text-ink-dim">
              <Fuel className="h-5 w-5" strokeWidth={1.75} />
              <span className="text-xs font-semibold uppercase tracking-[0.12em]">
                Fuel burned · last {periodDays} days
              </span>
            </div>
            {/* An em-dash read as "broken". A fleet that burned nothing burned
                ₦0 — say so, and show the litres beside it so the figure has a
                unit rather than being a bare currency amount. */}
            <p className="mt-3 text-5xl font-bold leading-none tracking-tight tabular-nums text-ink sm:text-6xl">
              {formatNgn(fuelContext?.burnedCost ?? 0)}
            </p>
            <p className="mt-1.5 text-sm text-ink-mid tabular-nums">
              {(fuelContext?.liters ?? 0).toFixed(1)} L burned ·{' '}
              {Math.round(fuelContext?.distanceKm ?? 0).toLocaleString()} km driven
            </p>
            {/* The blended rate this period actually worked out at, not the
                latest declared price. Every litre is already valued at the
                price in force when it burned, so quoting today's figure
                misrepresented the total above it: a week spanning ₦1,300 and
                ₦1,275 cost ₦1,290.73/L and the caption claimed ₦1,275. */}
            <p className="mt-2.5 text-sm text-ink-mid">
              {fuelContext
                ? `${fuelContext.liters.toFixed(1)} L over ${Math.round(
                    fuelContext.distanceKm
                  )} km at ${formatNgn(fuelContext.blendedPricePerLiter)}/L average`
                : 'No distance in this window, so this is idling'}
            </p>
            {/* Bought and burned are different questions. Keeping the receipt
                total visible but subordinate stops the two being read as one. */}
            {pumpSpend > 0 ? (
              <p className="mt-1 text-xs text-ink-dim">
                {formatNgn(pumpSpend)} paid at the pump this period — the rest is still in the tank
              </p>
            ) : (
              <p className="mt-1 text-xs text-ink-dim">No fuel bought in this period</p>
            )}

            {fuelContext && (
              <div className="mt-6 border-t border-edge pt-5">
                {fuelContext.fuelComplete ? (
                  <div className="grid grid-cols-2 gap-4">
                    <Rate
                      label="Cost per km"
                      value={formatNgn(fuelContext.costPerKm)}
                      benchmark={
                        fuelContext.benchmarkCostPerKm != null
                          ? `vs ${formatNgn(fuelContext.benchmarkCostPerKm)} typical`
                          : null
                      }
                      emphasis
                    />
                    {/* What idling is costing, rather than an economy figure
                        that only ever restates the vehicle's own settings.
                        Shown in mpg because that is what is on the dash of
                        most imports here. */}
                    {fuelContext.idleDragKmPerLiter != null &&
                    fuelContext.ratedKmPerLiter != null ? (
                      <Rate
                        label="Idle drag"
                        value={`${kmLToMpg(fuelContext.ratedKmPerLiter)?.toFixed(1) ?? '—'} → ${
                          kmLToMpg(fuelContext.kmPerLiter)?.toFixed(1) ?? '—'
                        } mpg`}
                        benchmark={`${fuelContext.idleLiters.toFixed(1)} L idling · ${formatNgn(
                          fuelContext.idleCost
                        )}`}
                      />
                    ) : (
                      <Rate
                        label="Idle drag"
                        value="—"
                        benchmark="no idling recorded this period"
                      />
                    )}
                  </div>
                ) : (
                  /* Says which figure is missing and why, rather than dividing
                     a full distance by a partial litre count and publishing a
                     flattering number with nothing behind it. */
                  <div className="grid grid-cols-2 gap-4">
                    <Rate label="Cost per km" value="—" benchmark="not enough fuel data" />
                    <Rate label="Idle drag" value="—" benchmark="not enough fuel data" />
                  </div>
                )}
                {/* Stated once, plainly, wherever litres appear as money: this
                    fleet's trackers carry no fuel sensor and no CAN link, so
                    the litres are inferred from distance and idle time. */}
                <p className="mt-3 text-[11px] leading-relaxed text-ink-dim">
                  Litres are modelled from distance driven and idle time, not read
                  from a fuel sensor. Money is valued at the price in force when
                  each litre burned.
                </p>
                {!fuelContext.fuelComplete && (
                  <p className="mt-3 text-[11px] leading-relaxed text-ink-dim">
                    The model charges {fuelContext.liters.toFixed(1)} L over{' '}
                    {Math.round(fuelContext.distanceKm)} km — about{' '}
                    {Math.round((fuelContext.fuelCoverage ?? 0) * 100)}% of the{' '}
                    {(fuelContext.benchmarkLiters ?? 0).toFixed(1)} L this distance should have
                    burned. Too little of the fuel record is present for a rate to mean anything.
                  </p>
                )}
              </div>
            )}

            {/* Same coverage gate: "under benchmark by ₦499" is only a saving
                if the litres it is measured against are real. Under-measured
                burn would otherwise be reported to a manager as money kept. */}
            {fuelContext &&
              fuelContext.fuelComplete &&
              fuelContext.savedNgn != null &&
              fuelContext.benchmarkCost != null && (
              <div className="mt-5 rounded-lg border border-edge bg-canvas p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-xs font-medium uppercase tracking-[0.1em] text-ink-dim">
                    {fuelContext.savedNgn >= 0 ? 'Under benchmark' : 'Over benchmark'} ·{' '}
                    {periodDays}d
                  </p>
                  <p
                    className={`font-mono text-xl font-semibold tabular-nums ${
                      // Green means one thing only: money genuinely kept.
                      fuelContext.savedNgn > 0 ? 'text-good' : 'text-ink'
                    }`}
                  >
                    {formatNgn(Math.abs(fuelContext.savedNgn))}
                  </p>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-dim">
                  {Math.round(fuelContext.distanceKm)} km at the{' '}
                  {fuelContext.benchmarkKmPerLiter?.toFixed(1)} km/L baseline should burn{' '}
                  {fuelContext.benchmarkLiters?.toFixed(1)} L ({formatNgn(fuelContext.benchmarkCost)}
                  ). The model charges {fuelContext.liters.toFixed(1)} L (
                  {formatNgn(fuelContext.burnedCost)}) —{' '}
                  {Math.abs(fuelContext.savedLiters ?? 0).toFixed(1)} L{' '}
                  {fuelContext.savedNgn >= 0 ? 'less' : 'more'} than expected.
                </p>
                {/* Never show a loss without saying what caused it. */}
                {lossLines.length > 0 && (
                  <ul className="mt-3 space-y-1.5 border-t border-edge pt-3">
                    {lossLines.map((line) => (
                      <li key={line} className="flex gap-2 text-xs leading-relaxed text-ink-mid">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-warn" />
                        {line}
                      </li>
                    ))}
                  </ul>
                )}
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
            hint={
              offlineCount > 0
                ? `${summary.online_vehicles}/${summary.total_vehicles} online — offline vehicles show their last known state, not live data`
                : `${summary.online_vehicles}/${summary.total_vehicles} vehicles online`
            }
            tone={summary.active_alerts > 0 ? 'warn' : 'good'}
            className="lg:col-span-3"
          />
          {/* The annualised projection was removed deliberately. Multiplying one
              week of preventable loss by 52 produces a large, alarming number
              that no evidence supports — a single bad week is not a year, and
              the figure reads as a forecast however it is captioned. */}
          {/* Fleet health used to stretch the full width of row two purely to
              fill the hole the removed projection left. One score does not
              need six columns, so the slack now carries a breakdown of the
              distance behind every other figure on this screen. */}
          <StatTile
            icon={Gauge}
            label="Fleet health"
            value={healthScore != null ? `${healthScore}/100` : '—'}
            // Connectivity used to be folded into this number, so one
            // disconnected tracker could floor it regardless of how well the
            // fleet was actually driven — a different problem (needs a
            // technician) answered with the same number as a driving one
            // (needs a word with the driver). It now shows separately, right
            // in this tile's hint, rather than inventing a sixth grid tile.
            hint={
              connScore != null
                ? `Driving & fuel only · connectivity ${connScore}%${offlineCount > 0 ? ` (${offlineCount} offline)` : ''}`
                : 'Theft flags, efficiency, open issues'
            }
            tone={healthTone}
            className="lg:col-span-3"
          />
          <DistanceBreakdownCard
            periodDays={periodDays}
            idleHours={fuelContext?.idleHours}
            idleCostNgn={fuelContext?.idleCost}
            className="sm:col-span-2 lg:col-span-3"
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
                  <li key={item.id}>
                    {/* One scannable line each. The full narrative — reasons,
                        source, confidence, cost — moves into the modal, because
                        six paragraphs of prose is not a triage queue. */}
                    <button
                      type="button"
                      onClick={() => setDetailItem(item)}
                      className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-panel-hover/40"
                    >
                      <span
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
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
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-ink">{item.title}</span>
                          <ConfidenceBadge
                            confidence={item.confidence}
                            severity={item.severityLevel}
                          />
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-ink-dim">
                          <span className="font-mono text-ink-mid">{item.vehicle}</span>
                          {item.lossNgn != null && item.lossNgn > 0
                            ? ` · est. ${formatNgn(item.lossNgn)}`
                            : ''}
                          {` · ${item.source}`}
                        </span>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-ink-dim" />
                    </button>
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

        <div className="grid gap-3 sm:grid-cols-2 lg:col-span-4 lg:flex lg:flex-col">
          {/* Evidence replay — the one tile allowed to shout */}
          <Tile tone="accent" className="p-5 sm:col-span-2 lg:col-span-1">
            <p className="text-sm font-semibold text-ink">Evidence replay</p>
            <p className="mt-1 text-xs text-ink-dim">
              Map + fuel graph + timeline — closes disputes with data, not accusations
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => {
                  // The tile promises "closes disputes with data" right next to
                  // the day's actual flagged items — it used to instead navigate
                  // to the unrelated siphon/receipt-flag list, which was almost
                  // always empty even when the attention queue above had real
                  // rows. Open the top item's own replay directly; only fall
                  // back to the list when nothing here has one.
                  const topReplayable = attentionItems.find((item) => item.replayTarget);
                  if (topReplayable?.replayTarget) {
                    setReplayTarget(topReplayable.replayTarget);
                  } else {
                    onOpenAnomalies();
                  }
                }}
                className="flex items-center justify-center gap-2 rounded-lg bg-accent py-3 text-sm font-semibold text-accent-y-ink shadow-lg shadow-accent/25"
              >
                <Play className="h-4 w-4" /> {TRUST_COPY.viewEvidenceCta} ▶
              </button>
              <button
                type="button"
                onClick={() => onOpenLive()}
                className="rounded-lg border border-ink-mid/40 py-2.5 text-sm text-ink"
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

          {/* Driver accountability. `lg:flex-1` lets this absorb the slack so
              the rail's bottom edge lines up with the queue's instead of
              stopping short of it. */}
          <Tile className="p-5 lg:flex-1">
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
                  const reasonSummary = lossReasonSummary(row.loss_reason);
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
                          {/* The cause travels with the flag, so a LOW status
                              is never just a verdict without evidence. */}
                          {reasonSummary && (
                            <span className="mt-0.5 block text-[11px] font-normal text-ink-dim">
                              {reasonSummary}
                            </span>
                          )}
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
                          <td colSpan={8} className="px-5 py-4 text-xs text-ink-dim">
                            {/* The loss is stated with its cause attached — a
                                number on its own starts the wrong conversation
                                with the driver. */}
                            {row.efficiency_loss_ngn > 0 && (
                              <div className="mb-3 rounded-lg border border-edge bg-panel p-3">
                                <p className="text-sm leading-relaxed text-ink">
                                  Burned {row.fuel_used_liters.toFixed(1)} L over {row.distance_km}{' '}
                                  km where the {row.expected_efficiency_km_l.toFixed(1)} km/L
                                  baseline expects{' '}
                                  {row.expected_fuel_liters?.toFixed(1) ?? '—'} L —{' '}
                                  <span className="text-warn">
                                    {formatNgn(row.efficiency_loss_ngn)} extra
                                  </span>
                                  .
                                </p>
                                <ul className="mt-2 space-y-1">
                                  {lossReasonLines(row.loss_reason).map((line) => (
                                    <li key={line} className="flex gap-2 leading-relaxed">
                                      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-warn" />
                                      {line}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
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

  // A full-card diagonal wash tinted the whole surface and fought the panel
  // colour, so the tone is now carried by the icon tile alone — a contained
  // glow behind the glyph rather than a gradient across the card.
  const tileTone = {
    default: 'neutral',
    good: 'good',
    warn: 'warn',
    bad: 'bad',
  }[tone] as 'neutral' | 'good' | 'warn' | 'bad';

  /*
   * These tiles are grid-stretched to the tallest cell in the row, so the old
   * `justify-between` dumped the inherited height into a hole between label and
   * value. The value block now takes the slack with `flex-1`, and the hint is
   * pinned to the bottom edge — the card fills instead of leaving a void.
   *
   * Deliberately no sparkline: none of these figures arrives with a time series
   * behind it, and drawing one would mean inventing history.
   */
  return (
    <Tile className={`relative flex flex-col overflow-hidden p-5 ${className}`}>
      <div className="relative flex items-start gap-2.5">
        <IconTile icon={Icon} tone={tileTone} size={44} float className="mt-0.5" />
        <span className="text-xs font-semibold uppercase leading-tight tracking-[0.1em] text-ink-dim">
          {label}
        </span>
      </div>
      <div className="relative mt-4 flex flex-1 flex-col justify-center">
        <p
          className={`text-4xl font-bold leading-none tracking-tight tabular-nums ${valueColor}`}
        >
          {value}
        </p>
      </div>
      {hint && <p className="relative mt-3 text-xs leading-snug text-ink-dim">{hint}</p>}
    </Tile>
  );
}

function Rate({
  label,
  value,
  benchmark,
  emphasis = false,
}: {
  label: string;
  value: string;
  benchmark: string | null;
  /** Cost per km is what an owner actually budgets against — it earns the
   *  same visual weight as the hero figure above it, not a secondary stat. */
  emphasis?: boolean;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-dim">{label}</p>
      <p
        className={`mt-1.5 font-mono font-semibold tabular-nums text-ink ${emphasis ? 'text-4xl' : 'text-2xl'}`}
      >
        {value}
      </p>
      {benchmark && <p className="mt-0.5 text-xs text-ink-dim">{benchmark}</p>}
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
