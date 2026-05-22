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
      <div className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-[#434656] bg-[#171f33] p-6 shadow-xl">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded p-1 text-[#8e90a2] hover:text-[#dae2fd]"
        >
          <X className="h-5 w-5" />
        </button>

        <h3 className="text-lg font-bold text-[#dae2fd]">How we calculate your savings</h3>
        <p className="mt-1 text-xs text-[#8e90a2]">
          Period: last {summary.period_days} days · Fuel price: {formatNgn(price)}/L
        </p>

        <div className="mt-6 space-y-4">
          <Step n={1} title="Expected fuel">
            <p className="text-sm text-[#c4c5d9]">
              Distance ÷ baseline efficiency (manufacturer spec for each model)
            </p>
            <code className="mt-2 block rounded bg-[#0b1326] p-3 font-mono text-xs">
              Expected fuel = {exampleDistance} km ÷ {exampleExpected} km/L ={' '}
              {exampleExpectedFuel.toFixed(1)} L
            </code>
          </Step>

          <Step n={2} title="Expected cost">
            <p className="text-sm text-[#c4c5d9]">Expected fuel × diesel price paid</p>
            <code className="mt-2 block rounded bg-[#0b1326] p-3 font-mono text-xs">
              Expected cost = {exampleExpectedFuel.toFixed(1)} L × {formatNgn(price)} ={' '}
              {formatNgn(exampleExpectedCost)}
            </code>
          </Step>

          <Step n={3} title="Actual cost">
            <p className="text-sm text-[#c4c5d9]">
              Sum of fuel receipts (declared liters) in the period, or OBD consumption × price if
              no receipts logged
            </p>
            <code className="mt-2 block rounded bg-[#0b1326] p-3 font-mono text-xs">
              Actual cost = receipt totals (includes overcharging when flagged)
            </code>
          </Step>

          <Step n={4} title="Your loss (or savings)" highlight>
            <p className="text-sm text-[#c4c5d9]">Loss = Actual − Expected. Negative savings = money lost.</p>
            <code className="mt-2 block rounded bg-[#0b1326] p-3 font-mono text-xs">
              Loss = {formatNgn(summary.total_actual_cost_ngn)} −{' '}
              {formatNgn(summary.total_expected_cost_ngn)} ={' '}
              {formatNgn(summary.total_loss_ngn)}
            </code>
            <p className="mt-2 text-xs text-[#ffb4ab]">
              Theft/fraud: {formatNgn(summary.total_theft_loss_ngn)} · Inefficiency:{' '}
              {formatNgn(summary.total_efficiency_loss_ngn)}
            </p>
          </Step>
        </div>

        <div className="mt-6 rounded-lg border border-[#2e5bff]/30 bg-[#2e5bff]/10 p-4">
          <div className="flex flex-wrap justify-between gap-4">
            <div>
              <p className="text-xs text-[#8e90a2]">{summary.period_days}-day loss</p>
              <p className="text-xl font-bold text-[#ffb4ab]">
                {formatNgn(summary.total_loss_ngn)}
              </p>
            </div>
            <div>
              <p className="text-xs text-[#8e90a2]">Recoverable (~90%)</p>
              <p className="text-xl font-bold text-[#4edea3]">
                {formatNgn(summary.recoverable_ngn)}
              </p>
            </div>
          </div>
        </div>

        <p className="mt-4 text-xs text-[#8e90a2]">
          <strong className="text-[#dae2fd]">This tank</strong> efficiency uses km since last OBD
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
      className={`rounded-lg bg-[#0b1326] p-4 ${highlight ? 'border-l-2 border-l-[#ffb4ab]' : ''}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
            highlight ? 'bg-[#ffb4ab]/20 text-[#ffb4ab]' : 'bg-[#2e5bff]/20 text-[#b8c3ff]'
          }`}
        >
          {n}
        </span>
        <h4 className="font-semibold text-[#dae2fd]">{title}</h4>
      </div>
      <div className="pl-8">{children}</div>
    </div>
  );
}
