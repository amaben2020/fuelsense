import {
  AlertTriangle,
  Droplet,
  Fuel,
  Shield,
  TrendingUp,
  Truck,
} from 'lucide-react';
import { DashboardSummary, formatNgn } from '@/lib/api';

function KpiCard({
  title,
  value,
  hint,
  icon: Icon,
  tone = 'default',
}: {
  title: string;
  value: string | number;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: 'default' | 'success' | 'warning' | 'critical';
}) {
  const toneClass = {
    default: 'text-[#dae2fd]',
    success: 'text-[#4edea3]',
    warning: 'text-[#ffb95f]',
    critical: 'text-[#ffb4ab]',
  }[tone];

  return (
    <div className="rounded-lg border border-[#434656] bg-[#171f33] p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wider text-[#8e90a2]">{title}</p>
          <p className={`mt-1 text-2xl font-bold tabular-nums ${toneClass}`}>{value}</p>
          {hint && <p className="mt-1 text-xs text-[#c4c5d9]">{hint}</p>}
        </div>
        <div className="rounded-lg bg-[#0b1326] p-2">
          <Icon className="h-4 w-4 text-[#b8c3ff]" />
        </div>
      </div>
    </div>
  );
}

export function DashboardKpis({ summary }: { summary: DashboardSummary | null }) {
  if (!summary) {
    return (
      <div className="rounded-lg border border-[#434656] bg-[#171f33] p-6 text-sm text-[#8e90a2]">
        Loading fleet metrics…
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      <KpiCard
        title="Active vehicles"
        value={`${summary.online_vehicles}/${summary.total_vehicles}`}
        hint="Online in last 15 minutes"
        icon={Truck}
        tone="success"
      />
      <KpiCard
        title="Fleet fuel"
        value={summary.total_fuel_liters > 0 ? `${summary.total_fuel_liters.toFixed(0)} L` : '—'}
        hint={
          summary.low_fuel_vehicles > 0
            ? `${summary.low_fuel_vehicles} below 20 L`
            : 'Live tank readings'
        }
        icon={Droplet}
      />
      <KpiCard
        title="Avg efficiency"
        value={
          summary.avg_efficiency_km_l != null
            ? `${summary.avg_efficiency_km_l.toFixed(1)} km/L`
            : '—'
        }
        hint={`${summary.total_distance_km.toLocaleString()} km · ${summary.period_days}d`}
        icon={TrendingUp}
        tone="success"
      />
      <KpiCard
        title="Fuel spend"
        value={summary.total_fuel_cost_ngn > 0 ? formatNgn(summary.total_fuel_cost_ngn) : '—'}
        hint={`@ ${formatNgn(summary.price_per_liter_ngn)}/L from telemetry`}
        icon={Fuel}
        tone="warning"
      />
      <KpiCard
        title="Theft loss"
        value={
          summary.estimated_theft_loss_ngn > 0
            ? formatNgn(summary.estimated_theft_loss_ngn)
            : formatNgn(0)
        }
        hint={`${summary.theft_alerts} active theft alert${summary.theft_alerts === 1 ? '' : 's'}`}
        icon={Shield}
        tone={summary.estimated_theft_loss_ngn > 0 ? 'critical' : 'default'}
      />
      <KpiCard
        title="Open alerts"
        value={summary.active_alerts}
        hint="Fuel theft and anomalies"
        icon={AlertTriangle}
        tone={summary.active_alerts > 0 ? 'critical' : 'success'}
      />
    </div>
  );
}
