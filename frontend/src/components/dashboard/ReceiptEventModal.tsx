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
  purchase: 'text-brand bg-brand/15 border-brand/30',
  obd: 'text-good bg-good/15 border-good/30',
  ignition: 'text-warn bg-warn/15 border-warn/30',
} as const;

function probabilityTone(probability: number) {
  if (probability >= 70) return 'text-bad bg-bad-deep/20 border-bad-deep/40';
  if (probability >= 40) return 'text-warn bg-warn/10 border-warn/30';
  if (probability >= 20) return 'text-brand bg-accent/10 border-accent/30';
  return 'text-good bg-good/10 border-good/30';
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
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-edge bg-canvas shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="receipt-event-title"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-edge bg-canvas px-6 py-5">
          <div>
            <p className="text-xs uppercase tracking-wider text-good">Receipt event</p>
            <h2 id="receipt-event-title" className="mt-1 text-xl font-semibold text-ink">
              {purchase.license_plate}
              {purchase.merchant ? ` · ${purchase.merchant}` : ''}
            </h2>
            <p className="mt-1 text-sm text-ink-dim">
              {purchase.driver_name ?? 'Unassigned driver'} ·{' '}
              {formatReceiptDateTime(purchaseTime)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-edge p-2 text-ink-dim hover:bg-panel hover:text-ink"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-6 px-6 py-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricCard label="Receipt (declared)" value={`${purchase.liters_declared} L`} accent="text-brand" />
            <MetricCard
              label="OBD actual"
              value={
                purchase.liters_actual != null ? `${purchase.liters_actual} L` : 'Not matched'
              }
              accent="text-good"
            />
            <MetricCard
              label="Difference"
              value={
                purchase.difference_liters > 0
                  ? `−${purchase.difference_liters} L`
                  : '0 L'
              }
              accent={purchase.difference_liters > 0 ? 'text-bad' : 'text-good'}
            />
          </div>

          {assessment && (
            <div className={`rounded-lg border p-4 ${probabilityTone(probability)}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-wider opacity-80">Review confidence</p>
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
            <h3 className="text-sm font-semibold text-ink">What happened (chronological)</h3>
            <p className="mt-1 text-xs text-ink-dim">
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
                      className={`rounded-lg border p-4 ${color} ${isAnomaly ? 'ring-1 ring-bad/40' : ''}`}
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-canvas/50">
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{event.label}</span>
                            <span className="rounded bg-canvas/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide opacity-80">
                              {event.source}
                            </span>
                          </div>
                          <p className="mt-1 font-mono text-sm">{formatReceiptDateTime(event.at)}</p>
                          <p className="mt-2 text-sm leading-relaxed opacity-90">{event.detail}</p>
                          {event.note && (
                            <p
                              className={`mt-2 text-xs leading-relaxed ${isAnomaly ? 'text-bad' : 'opacity-75'}`}
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
                <p className="text-sm text-ink-dim">
                  No telemetry timestamps matched this receipt yet.
                </p>
              )}
            </div>
          </section>

          {assessment && assessment.reasons.length > 0 && (
            <section className="rounded-lg border border-edge bg-panel p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                {isTheft || probability >= 70 ? (
                  <AlertTriangle className="h-4 w-4 text-bad" />
                ) : (
                  <Shield className="h-4 w-4 text-brand" />
                )}
                {isTheft || probability >= 70
                  ? 'Why this was flagged for review'
                  : 'Assessment notes'}
              </h3>
              <ul className="mt-3 space-y-2">
                {assessment.reasons.map((reason) => (
                  <li key={reason} className="flex gap-2 text-sm leading-relaxed text-ink-mid">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-dim" />
                    {reason}
                  </li>
                ))}
              </ul>
              {assessment.signals.length > 0 && (
                <div className="mt-4 border-t border-edge pt-4">
                  <p className="text-xs uppercase tracking-wider text-ink-dim">Signal breakdown</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {assessment.signals.map((signal) => (
                      <span
                        key={signal.code}
                        className="rounded-full border border-edge bg-canvas px-2.5 py-1 text-[11px] text-ink-mid"
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

        <div className="border-t border-edge px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-lg bg-accent py-2.5 text-sm font-medium text-white hover:bg-accent-soft"
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
    <div className="rounded-lg border border-edge bg-panel p-3">
      <p className="text-[10px] uppercase tracking-wider text-ink-dim">{label}</p>
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
      <span className="inline-flex items-center gap-1 rounded-full bg-bad-deep/30 px-3 py-1 text-xs font-medium text-bad">
        <AlertTriangle className="h-3.5 w-3.5" /> Requires review
      </span>
    );
  }
  if (status === 'pending_receipt' || verdict === 'suspicious') {
    return (
      <span className="rounded-full bg-warn/20 px-3 py-1 text-xs font-medium text-warn">
        Suspicious
      </span>
    );
  }
  if (verdict === 'review') {
    return (
      <span className="rounded-full bg-accent/20 px-3 py-1 text-xs font-medium text-brand">
        Review
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-good/20 px-3 py-1 text-xs font-medium text-good">
      <Shield className="h-3.5 w-3.5" /> Verified
    </span>
  );
}
