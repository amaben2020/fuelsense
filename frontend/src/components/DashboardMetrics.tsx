import { FleetVehicle, fleetMetrics } from '@/lib/api';

function MetricCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string | number;
  hint?: string;
  accent?: 'emerald' | 'amber' | 'red' | 'slate';
}) {
  const accentClass = {
    emerald: 'text-emerald-600',
    amber: 'text-amber-600',
    red: 'text-red-600',
    slate: 'text-slate-900',
  }[accent ?? 'slate'];

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200/60">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-2 text-3xl font-bold tabular-nums ${accentClass}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function DashboardMetrics({
  fleet,
  alertCount,
}: {
  fleet: FleetVehicle[];
  alertCount: number;
}) {
  const m = fleetMetrics(fleet);

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        label="Fleet size"
        value={m.total}
        hint={`${m.online} online · ${m.offline} offline`}
        accent="slate"
      />
      <MetricCard
        label="On map"
        value={m.onMap}
        hint={m.onMap === m.total ? 'All vehicles located' : 'Vehicles with GPS fix'}
        accent="emerald"
      />
      <MetricCard
        label="Avg fuel"
        value={m.avgFuel != null ? `${m.avgFuel.toFixed(1)} L` : '—'}
        hint={
          m.lowFuel > 0
            ? `${m.lowFuel} vehicle${m.lowFuel === 1 ? '' : 's'} below 20 L`
            : 'Across reporting vehicles'
        }
        accent={m.lowFuel > 0 ? 'amber' : 'slate'}
      />
      <MetricCard
        label="Active alerts"
        value={alertCount}
        hint={alertCount > 0 ? 'Requires attention' : 'No open alerts'}
        accent={alertCount > 0 ? 'red' : 'emerald'}
      />
    </div>
  );
}
