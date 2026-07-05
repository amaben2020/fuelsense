'use client';

import { X } from 'lucide-react';
import { FleetEfficiencySummary, formatNgn } from '@/lib/api';

export function SavingsExplanationModal({
  summary,
  onClose,
}: {
  summary: FleetEfficiencySummary | null;
  onClose: () => void;
}) {
  if (!summary) return null;

  const price = summary.price_per_liter_ngn;
  const exampleDistance = 2558;
  const exampleExpected = 7.5;
  const exampleExpectedFuel = exampleDistance / exampleExpected;
  const exampleExpectedCost = Math.round(exampleExpectedFuel * price);
  const exampleActual = summary.total_actual_cost_ngn
    ? Math.round(summary.total_actual_cost_ngn / Math.max(summary.period_days, 1) * 7)
    : 249275;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/70"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-edge bg-panel p-6 shadow-xl">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded p-1 text-ink-dim hover:text-ink"
        >
          <X className="h-5 w-5" />
        </button>

        <h3 className="text-lg font-bold text-ink">How we calculate your savings</h3>
        <p className="mt-1 text-xs text-ink-dim">
          Period: last {summary.period_days} days · Fuel price: {formatNgn(price)}/L
        </p>

        <div className="mt-6 space-y-4">
          <Step n={1} title="Expected fuel">
            <p className="text-sm text-ink-mid">
              Distance ÷ baseline efficiency (manufacturer spec for each model)
            </p>
            <code className="mt-2 block rounded bg-canvas p-3 font-mono text-xs">
              Expected fuel = {exampleDistance} km ÷ {exampleExpected} km/L ={' '}
              {exampleExpectedFuel.toFixed(1)} L
            </code>
          </Step>

          <Step n={2} title="Expected cost">
            <p className="text-sm text-ink-mid">Expected fuel × diesel price paid</p>
            <code className="mt-2 block rounded bg-canvas p-3 font-mono text-xs">
              Expected cost = {exampleExpectedFuel.toFixed(1)} L × {formatNgn(price)} ={' '}
              {formatNgn(exampleExpectedCost)}
            </code>
          </Step>

          <Step n={3} title="OBD consumption cost">
            <p className="text-sm text-ink-mid">
              FMC150 fuel used in the period × diesel price — the ground truth for efficiency
            </p>
            <code className="mt-2 block rounded bg-canvas p-3 font-mono text-xs">
              OBD cost = {summary.total_fuel_used_liters.toFixed(1)} L × {formatNgn(price)} ={' '}
              {formatNgn(summary.total_telemetry_cost_ngn ?? summary.total_actual_cost_ngn)}
            </code>
          </Step>

          <Step n={4} title="Preventable loss" highlight>
            <p className="text-sm text-ink-mid">
              Suspicious fuel patterns (receipt vs OBD, siphon alerts) plus extra burn above baseline efficiency.
            </p>
            <code className="mt-2 block rounded bg-canvas p-3 font-mono text-xs">
              Preventable loss = {formatNgn(summary.total_theft_loss_ngn)} (anomalies) +{' '}
              {formatNgn(summary.total_efficiency_loss_ngn)} (inefficiency) ={' '}
              {formatNgn(summary.total_loss_ngn)}
            </code>
            <p className="mt-2 text-xs text-bad">
              Inefficiency = max(0, OBD cost − expected cost) per vehicle, summed across fleet
            </p>
          </Step>
        </div>

        <div className="mt-6 rounded-lg border border-accent/30 bg-accent/10 p-4">
          <div className="flex flex-wrap justify-between gap-4">
            <div>
              <p className="text-xs text-ink-dim">{summary.period_days}-day loss</p>
              <p className="text-xl font-bold text-bad">
                {formatNgn(summary.total_loss_ngn)}
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-dim">Recoverable (~90%)</p>
              <p className="text-xl font-bold text-good">
                {formatNgn(summary.recoverable_ngn)}
              </p>
            </div>
          </div>
        </div>

        <p className="mt-4 text-xs text-ink-dim">
          <strong className="text-ink">This tank</strong> efficiency uses km since last OBD
          refuel ÷ fuel consumed since that fill — the correct way to coach drivers per tank.
        </p>
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  children,
  highlight,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg bg-canvas p-4 ${highlight ? 'border-l-2 border-l-bad' : ''}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
            highlight ? 'bg-bad/20 text-bad' : 'bg-accent/20 text-brand'
          }`}
        >
          {n}
        </span>
        <h4 className="font-semibold text-ink">{title}</h4>
      </div>
      <div className="pl-8">{children}</div>
    </div>
  );
}
