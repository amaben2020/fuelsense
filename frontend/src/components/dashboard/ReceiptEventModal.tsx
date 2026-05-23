'use client';

import { AlertTriangle, Key, Receipt, Shield, X, Zap } from 'lucide-react';
import { FuelPurchase, formatNgn } from '@/lib/api';

function formatReceiptDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-NG', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: 'Africa/Lagos',
  });
}

const EVENT_ICONS = {
  purchase: Receipt,
  obd: Zap,
  ignition: Key,
} as const;

const EVENT_COLORS = {
  purchase: 'text-[#b8c3ff] bg-[#b8c3ff]/15 border-[#b8c3ff]/30',
  obd: 'text-[#4edea3] bg-[#4edea3]/15 border-[#4edea3]/30',
  ignition: 'text-[#ffb95f] bg-[#ffb95f]/15 border-[#ffb95f]/30',
} as const;

function probabilityTone(probability: number) {
  if (probability >= 70) return 'text-[#ffb4ab] bg-[#93000a]/20 border-[#93000a]/40';
  if (probability >= 40) return 'text-[#ffb95f] bg-[#ffb95f]/10 border-[#ffb95f]/30';
  if (probability >= 20) return 'text-[#b8c3ff] bg-[#2e5bff]/10 border-[#2e5bff]/30';
  return 'text-[#4edea3] bg-[#4edea3]/10 border-[#4edea3]/30';
}

export function ReceiptEventModal({
  purchase,
  onClose,
}: {
  purchase: FuelPurchase;
  onClose: () => void;
}) {
  const assessment = purchase.event_assessment;
  const purchaseTime = purchase.purchased_at ?? purchase.timestamp;
  const isTheft = purchase.status === 'flagged_theft';
  const probability = assessment?.theft_probability ?? (isTheft ? 78 : 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-[#434656] bg-[#0b1326] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="receipt-event-title"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-[#434656] bg-[#0b1326] px-6 py-5">
          <div>
            <p className="text-xs uppercase tracking-wider text-[#4edea3]">Receipt event</p>
            <h2 id="receipt-event-title" className="mt-1 text-xl font-semibold text-[#dae2fd]">
              {purchase.license_plate}
              {purchase.merchant ? ` · ${purchase.merchant}` : ''}
            </h2>
            <p className="mt-1 text-sm text-[#8e90a2]">
              {purchase.driver_name ?? 'Unassigned driver'} ·{' '}
              {formatReceiptDateTime(purchaseTime)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[#434656] p-2 text-[#8e90a2] hover:bg-[#171f33] hover:text-[#dae2fd]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-6 px-6 py-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricCard label="Receipt (declared)" value={`${purchase.liters_declared} L`} accent="text-[#b8c3ff]" />
            <MetricCard
              label="OBD actual"
              value={
                purchase.liters_actual != null ? `${purchase.liters_actual} L` : 'Not matched'
              }
              accent="text-[#4edea3]"
            />
            <MetricCard
              label="Difference"
              value={
                purchase.difference_liters > 0
                  ? `−${purchase.difference_liters} L`
                  : '0 L'
              }
              accent={purchase.difference_liters > 0 ? 'text-[#ffb4ab]' : 'text-[#4edea3]'}
            />
          </div>

          {assessment && (
            <div className={`rounded-lg border p-4 ${probabilityTone(probability)}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-wider opacity-80">Fraud probability</p>
                  <p className="mt-1 text-3xl font-bold">{probability}%</p>
                </div>
                <StatusBadge status={purchase.status} verdict={assessment.verdict} />
              </div>
              <p className="mt-3 text-sm leading-relaxed opacity-95">{assessment.summary}</p>
              {assessment.estimated_loss_ngn > 0 && (
                <p className="mt-2 text-sm font-medium">
                  Estimated loss: {formatNgn(assessment.estimated_loss_ngn)}
                </p>
              )}
            </div>
          )}

          <section>
            <h3 className="text-sm font-semibold text-[#dae2fd]">What happened (chronological)</h3>
            <p className="mt-1 text-xs text-[#8e90a2]">
              {assessment?.expected_sequence ??
                'Typical refuel: pump purchase → fuel enters tank (OBD rise) → ignition on to depart.'}
            </p>
            <div className="mt-4 space-y-3">
              {(assessment?.chronological_timeline ?? []).length > 0 ? (
                assessment!.chronological_timeline!.map((event, index) => {
                  const Icon = EVENT_ICONS[event.key as keyof typeof EVENT_ICONS] ?? Receipt;
                  const color =
                    EVENT_COLORS[event.key as keyof typeof EVENT_COLORS] ?? EVENT_COLORS.purchase;
                  const isAnomaly = Boolean(
                    event.note?.includes('earlier trip') ||
                      event.note?.includes('before the logged') ||
                      event.note?.includes('inconsistency')
                  );

                  return (
                    <div
                      key={`${event.key}-${event.at}`}
                      className={`rounded-lg border p-4 ${color} ${isAnomaly ? 'ring-1 ring-[#ffb4ab]/40' : ''}`}
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#0b1326]/50">
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{event.label}</span>
                            <span className="rounded bg-[#0b1326]/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide opacity-80">
                              {event.source}
                            </span>
                          </div>
                          <p className="mt-1 font-mono text-sm">{formatReceiptDateTime(event.at)}</p>
                          <p className="mt-2 text-sm leading-relaxed opacity-90">{event.detail}</p>
                          {event.note && (
                            <p
                              className={`mt-2 text-xs leading-relaxed ${isAnomaly ? 'text-[#ffb4ab]' : 'opacity-75'}`}
                            >
                              {isAnomaly && index > 0 ? '⚠ ' : ''}
                              {event.note}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <p className="text-sm text-[#8e90a2]">
                  No telemetry timestamps matched this receipt yet.
                </p>
              )}
            </div>
          </section>

          {assessment && assessment.reasons.length > 0 && (
            <section className="rounded-lg border border-[#434656] bg-[#171f33] p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-[#dae2fd]">
                {isTheft || probability >= 70 ? (
                  <AlertTriangle className="h-4 w-4 text-[#ffb4ab]" />
                ) : (
                  <Shield className="h-4 w-4 text-[#b8c3ff]" />
                )}
                {isTheft || probability >= 70
                  ? 'Why we think this is theft'
                  : 'Assessment notes'}
              </h3>
              <ul className="mt-3 space-y-2">
                {assessment.reasons.map((reason) => (
                  <li key={reason} className="flex gap-2 text-sm leading-relaxed text-[#c4c5d9]">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#8e90a2]" />
                    {reason}
                  </li>
                ))}
              </ul>
              {assessment.signals.length > 0 && (
                <div className="mt-4 border-t border-[#434656] pt-4">
                  <p className="text-xs uppercase tracking-wider text-[#8e90a2]">Signal breakdown</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {assessment.signals.map((signal) => (
                      <span
                        key={signal.code}
                        className="rounded-full border border-[#434656] bg-[#0b1326] px-2.5 py-1 text-[11px] text-[#c4c5d9]"
                      >
                        +{signal.weight}% · {signal.message}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}
        </div>

        <div className="border-t border-[#434656] px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-lg bg-[#2e5bff] py-2.5 text-sm font-medium text-white hover:bg-[#3d6bff]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="rounded-lg border border-[#434656] bg-[#171f33] p-3">
      <p className="text-[10px] uppercase tracking-wider text-[#8e90a2]">{label}</p>
      <p className={`mt-1 font-mono text-lg font-semibold ${accent}`}>{value}</p>
    </div>
  );
}

function StatusBadge({
  status,
  verdict,
}: {
  status: FuelPurchase['status'];
  verdict?: string;
}) {
  if (status === 'flagged_theft' || verdict === 'likely_theft') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#93000a]/30 px-3 py-1 text-xs font-medium text-[#ffb4ab]">
        <AlertTriangle className="h-3.5 w-3.5" /> Likely theft
      </span>
    );
  }
  if (status === 'pending_receipt' || verdict === 'suspicious') {
    return (
      <span className="rounded-full bg-[#ffb95f]/20 px-3 py-1 text-xs font-medium text-[#ffb95f]">
        Suspicious
      </span>
    );
  }
  if (verdict === 'review') {
    return (
      <span className="rounded-full bg-[#2e5bff]/20 px-3 py-1 text-xs font-medium text-[#b8c3ff]">
        Review
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#4edea3]/20 px-3 py-1 text-xs font-medium text-[#4edea3]">
      <Shield className="h-3.5 w-3.5" /> Verified
    </span>
  );
}
