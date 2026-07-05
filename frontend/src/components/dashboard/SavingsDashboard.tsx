'use client';

import { useState } from 'react';
import { HelpCircle, Receipt, TrendingDown } from 'lucide-react';
import { FleetEfficiencySummary, formatFuelPricePerLiter, formatNgn } from '@/lib/api';
import { formatMillionsNgn } from '@/lib/trust-language';

import { SavingsExplanationModal } from './SavingsExplanationModal';

export function SavingsDashboard({
  summary,
}: {
  summary: FleetEfficiencySummary | null;
}) {
  const [explainOpen, setExplainOpen] = useState(false);
  if (!summary) return null;

  const periodDays = summary.period_days;
  const annualSavingsOpportunity = Math.round((summary.total_loss_ngn / periodDays) * 365);
  const recoverable = summary.recoverable_ngn;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-edge bg-gradient-to-r from-panel to-panel-hover p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm text-ink-mid">Your {periodDays}-day preventable fuel loss</p>
            <p className="mt-1 text-4xl font-bold text-bad">
              {formatNgn(summary.total_loss_ngn)}
            </p>
            <p className="mt-1 text-xs text-ink-dim">
              OBD spend {formatNgn(summary.total_telemetry_cost_ngn ?? summary.total_actual_cost_ngn)}{' '}
              vs expected {formatNgn(summary.total_expected_cost_ngn)} at{' '}
              {formatFuelPricePerLiter(summary.price_per_liter_ngn)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm text-ink-mid">Potential annual savings opportunity</p>
            <p className="text-2xl font-bold text-good">
              {formatMillionsNgn(annualSavingsOpportunity)}
            </p>
            <p className="mt-1 text-xs text-ink-dim">
              ~{formatNgn(recoverable)} recoverable in last {periodDays} days if addressed
            </p>
          </div>
          <button
            type="button"
            onClick={() => setExplainOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-edge bg-canvas px-3 py-2 text-xs text-brand hover:bg-panel-hover"
          >
            <HelpCircle className="h-4 w-4" /> How is this calculated?
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-edge bg-panel p-4">
          <div className="mb-3 flex items-center gap-2">
            <Receipt className="h-4 w-4 text-bad" />
            <h3 className="font-semibold text-ink">Suspicious fuel patterns</h3>
          </div>
          <p className="text-2xl font-bold text-bad">
            {formatNgn(summary.total_theft_loss_ngn)}
          </p>
          <p className="mt-1 text-xs text-ink-dim">
            Receipt vs OBD mismatch + siphon alerts
          </p>
        </div>

        <div className="rounded-lg border border-edge bg-panel p-4">
          <div className="mb-3 flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-warn" />
            <h3 className="font-semibold text-ink">Inefficiency loss</h3>
          </div>
          <p className="text-2xl font-bold text-warn">
            {formatNgn(summary.total_efficiency_loss_ngn)}
          </p>
          <p className="mt-1 text-xs text-ink-dim">
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
