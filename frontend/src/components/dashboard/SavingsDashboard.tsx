'use client';

import { useState } from 'react';
import { HelpCircle, Receipt, TrendingDown } from 'lucide-react';
import { FleetEfficiencySummary, formatFuelPricePerLiter, formatNgn } from '@/lib/api';

import { SavingsExplanationModal } from './SavingsExplanationModal';

export function SavingsDashboard({
  summary,
}: {
  summary: FleetEfficiencySummary | null;
}) {
  const [explainOpen, setExplainOpen] = useState(false);
  if (!summary) return null;

  const periodDays = summary.period_days;
  const annualizedLoss = Math.round((summary.total_loss_ngn / periodDays) * 365);
  const recoverable = summary.recoverable_ngn;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[#434656] bg-gradient-to-r from-[#171f33] to-[#222a3d] p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm text-[#c4c5d9]">Your {periodDays}-day preventable fuel loss</p>
            <p className="mt-1 text-4xl font-bold text-[#ffb4ab]">
              {formatNgn(summary.total_loss_ngn)}
            </p>
            <p className="mt-1 text-xs text-[#8e90a2]">
              Actual {formatNgn(summary.total_actual_cost_ngn)} vs expected{' '}
              {formatNgn(summary.total_expected_cost_ngn)} at{' '}
              {formatFuelPricePerLiter(summary.price_per_liter_ngn)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm text-[#c4c5d9]">Annualized loss</p>
            <p className="text-2xl font-bold text-[#ffb4ab]">{formatNgn(annualizedLoss)}</p>
            <p className="mt-1 text-xs text-[#4edea3]">
              ~{formatNgn(recoverable)} recoverable ({periodDays}d × 90%)
            </p>
          </div>
          <button
            type="button"
            onClick={() => setExplainOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-[#434656] bg-[#0b1326] px-3 py-2 text-xs text-[#b8c3ff] hover:bg-[#222a3d]"
          >
            <HelpCircle className="h-4 w-4" /> How is this calculated?
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-[#434656] bg-[#171f33] p-4">
          <div className="mb-3 flex items-center gap-2">
            <Receipt className="h-4 w-4 text-[#ffb4ab]" />
            <h3 className="font-semibold text-[#dae2fd]">Theft & receipt fraud</h3>
          </div>
          <p className="text-2xl font-bold text-[#ffb4ab]">
            {formatNgn(summary.total_theft_loss_ngn)}
          </p>
          <p className="mt-1 text-xs text-[#8e90a2]">
            Receipt vs OBD mismatch + siphon alerts
          </p>
        </div>

        <div className="rounded-lg border border-[#434656] bg-[#171f33] p-4">
          <div className="mb-3 flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-[#ffb95f]" />
            <h3 className="font-semibold text-[#dae2fd]">Inefficiency loss</h3>
          </div>
          <p className="text-2xl font-bold text-[#ffb95f]">
            {formatNgn(summary.total_efficiency_loss_ngn)}
          </p>
          <p className="mt-1 text-xs text-[#8e90a2]">
            Extra fuel vs manufacturer baseline efficiency
          </p>
        </div>
      </div>

      {explainOpen && (
        <SavingsExplanationModal summary={summary} onClose={() => setExplainOpen(false)} />
      )}
    </div>
  );
}
