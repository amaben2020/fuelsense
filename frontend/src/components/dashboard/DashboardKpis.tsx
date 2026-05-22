import {
  AlertTriangle,
  Droplet,
  Fuel,
  Shield,
  TrendingUp,
  Truck,
} from 'lucide-react';
import { computeDashboardStats, FleetEfficiency, FleetVehicle, Alert } from '@/lib/api';

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

export function DashboardKpis({
  fleet,
  alerts,
  efficiency,
}: {
  fleet: FleetVehicle[];
  alerts: Alert[];
  efficiency: FleetEfficiency[];
}) {
  const stats = computeDashboardStats(fleet, alerts, efficiency);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      <KpiCard
        title="Active vehicles"
        value={`${stats.online}/${stats.total}`}
        hint={`${stats.offline} offline · ${stats.onMap} on map`}
        icon={Truck}
        tone="success"
      />
      <KpiCard
        title="Fleet fuel"
        value={stats.totalFuel > 0 ? `${stats.totalFuel.toFixed(0)} L` : '—'}
        hint={stats.lowFuel > 0 ? `${stats.lowFuel} below 20 L` : 'Live tank readings'}
        icon={Droplet}
      />
      <KpiCard
        title="Avg efficiency"
        value={stats.avgEfficiency != null ? `${stats.avgEfficiency.toFixed(1)} km/L` : '—'}
        hint={`${stats.totalDistance.toLocaleString()} km this week`}
        icon={TrendingUp}
        tone="success"
      />
      <KpiCard
        title="Weekly fuel cost"
        value={stats.totalFuelCost > 0 ? formatCompactNgn(stats.totalFuelCost) : '—'}
        hint="From telemetry consumption"
        icon={Fuel}
        tone="warning"
      />
      <KpiCard
        title="Theft alerts"
        value={formatCompactNgn(stats.theftLossNgn)}
        hint={`${alerts.filter((a) => a.alert_type === 'fuel_theft').length} active theft events`}
        icon={Shield}
        tone={stats.theftLossNgn > 0 ? 'critical' : 'default'}
      />
      <KpiCard
        title="Open alerts"
        value={stats.criticalAlerts}
        hint="Fuel theft and anomalies"
        icon={AlertTriangle}
        tone={stats.criticalAlerts > 0 ? 'critical' : 'success'}
      />
    </div>
  );
}

function formatCompactNgn(amount: number) {
  if (amount >= 1000) return `₦${Math.round(amount / 1000)}k`;
  return `₦${amount.toLocaleString()}`;
}
