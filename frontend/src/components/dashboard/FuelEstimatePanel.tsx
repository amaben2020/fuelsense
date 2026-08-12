'use client';

import { useState } from 'react';
import { Fuel, Receipt, Route, Wallet } from 'lucide-react';
import { formatNgn } from '@/lib/api';
import {
  ESTIMATE_PERIOD_OPTIONS,
  EstimatedConsumptionTableView,
  useEstimatedConsumption,
} from './EstimatedConsumptionTable';

function HeroStat({
  icon: Icon,
  label,
  value,
  detail,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  detail: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-edge bg-canvas p-5">
      <p className="flex items-center gap-2 text-xs uppercase tracking-wider text-ink-dim">
        <Icon className="h-4 w-4" /> {label}
      </p>
      <p className={`mt-3 font-mono text-3xl font-bold ${accent ? 'neon-text' : 'text-ink'}`}>
        {value}
      </p>
      <p className="mt-1 text-xs text-ink-dim">{detail}</p>
    </div>
  );
}

export function FuelEstimatePanel() {
  const [days, setDays] = useState(7);
  const { data, loading, error } = useEstimatedConsumption(days);

  const totals = data?.totals;
  const periodLabel = days === 1 ? 'today' : `last ${days} days`;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-edge bg-panel p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="text-lg font-semibold text-ink">
              We use distance covered to estimate fuel
            </h2>
            <p className="mt-2 text-sm text-ink-mid">
              Your trackers report GPS position, speed and ignition even when no fuel-level
              sensor is connected. We sum the distance each vehicle actually covered, divide it
              by the rate you entered for that vehicle, then add fuel burned while the engine
              idled (running but not moving) — traffic, AC, waiting.
            </p>
            {/* Each day is valued at the rate that applied on that day, so the
                caption names the current rate rather than implying one
                multiplier was used across the whole window. */}
            <p className="mt-2 text-xs text-ink-dim">
              Estimated fuel = distance ÷ your km/L + idle hours × the vehicle&apos;s idle rate
              {data?.price_per_liter_ngn != null
                ? ` · valued at the price in force each day, currently ${formatNgn(
                    data.price_per_liter_ngn
                  )}/L`
                : ' · no fuel price recorded yet, so litres are shown without money'}
            </p>
          </div>
          <div className="flex gap-1">
            {ESTIMATE_PERIOD_OPTIONS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={`rounded-lg border px-3 py-1 text-xs ${
                  days === d
                    ? 'border-good bg-good/10 text-good'
                    : 'border-edge text-ink-mid hover:bg-panel-hover'
                }`}
              >
                {d === 1 ? 'Today' : `${d} days`}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="mt-4 text-sm text-bad">{error}</p>}

        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <HeroStat
            icon={Route}
            label="Distance covered"
            value={
              loading && !totals ? '…' : `${(totals?.distance_km ?? 0).toLocaleString()} km`
            }
            detail={`Fleet total, ${periodLabel}`}
          />
          <HeroStat
            icon={Fuel}
            label="Estimated fuel burned"
            value={
              loading && !totals ? '…' : `${(totals?.estimated_fuel_liters ?? 0).toFixed(1)} L`
            }
            detail="Driving + engine-idle burn"
            accent
          />
          <HeroStat
            icon={Wallet}
            label="Estimated cost"
            value={
              loading && !totals
                ? '…'
                : data?.price_per_liter_ngn == null
                  ? '—'
                  : formatNgn(totals?.estimated_cost_ngn ?? 0)
            }
            detail={
              data == null
                ? ''
                : data.price_per_liter_ngn == null
                  ? 'Set a fuel price to value this'
                  : `At the price in force each day · now ${formatNgn(
                      data.price_per_liter_ngn
                    )}/L`
            }
          />
          <HeroStat
            icon={Receipt}
            label="Fuel purchased"
            value={loading && !data ? '…' : formatNgn(data?.purchases.cost_ngn ?? 0)}
            detail={
              data && data.purchases.count > 0
                ? `${data.purchases.liters.toFixed(0)} L across ${data.purchases.count} receipt${data.purchases.count === 1 ? '' : 's'} — bought ≠ burned, the rest is still in the tank`
                : `No receipts recorded ${periodLabel}`
            }
          />
        </div>
      </div>

      <EstimatedConsumptionTableView
        days={days}
        onDaysChange={setDays}
        data={data}
        loading={loading}
        error={error}
      />
    </div>
  );
}
