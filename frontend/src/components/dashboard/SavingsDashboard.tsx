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
              {/* "OBD" was wrong on GPS-only vehicles, and falling back to the
                  receipt total presented money paid as fuel measured. */}
              {summary.total_telemetry_cost_ngn != null
                ? `Tracker-measured burn ${formatNgn(summary.total_telemetry_cost_ngn)}`
                : 'Burn not measured this period'}{' '}
              vs expected {formatNgn(summary.total_expected_cost_ngn)} at{' '}
              {formatFuelPricePerLiter(summary.price_per_liter_ngn)}
            </p>
          </div>
          {/* The annualised projection and the "recoverable" figure both used
              to sit here. The Operations page removed its own copy of the
              annualisation for a reason that applies just as much here: one
              period's loss × 365/period is a forecast dressed as a
              measurement, and a bad week reads as a catastrophic year.
              "Recoverable" was worse — total loss × 0.9, a recovery rate
              invented outright. Neither survived, and nothing replaces them,
              because the honest version of both is the period figure already
              shown on the left. */}
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
