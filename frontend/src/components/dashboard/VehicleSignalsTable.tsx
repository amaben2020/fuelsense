'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  Battery,
  Fuel,
  Gauge,
  Info,
  Navigation,
  Radio,
  Signal,
} from 'lucide-react';
import {
  VehicleSignal,
  VehicleSignalsResponse,
  getVehicleSignals,
} from '@/lib/api';

const RANGES = [
  { days: 1, label: 'Today' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
];

const GROUP_META: Record<
  VehicleSignal['group'],
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  engine: { label: 'Engine', icon: Activity },
  fuel: { label: 'Fuel', icon: Fuel },
  movement: { label: 'Movement', icon: Navigation },
  electrical: { label: 'Electrical', icon: Battery },
  network: { label: 'Network', icon: Signal },
  gnss: { label: 'GNSS', icon: Radio },
  other: { label: 'Unmapped elements', icon: Gauge },
};

const GROUP_ORDER: VehicleSignal['group'][] = [
  'engine',
  'movement',
  'fuel',
  'electrical',
  'gnss',
  'network',
  'other',
];

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return n == null || Number.isNaN(n) ? 0 : n;
};

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const formatClock = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

const TIP_WIDTH = 288;
// How much room a tooltip needs below the trigger before it flips above it.
const TIP_FLIP_MARGIN = 180;

interface TipAnchor {
  x: number;
  y: number;
  above: boolean;
}

// Rendered through a portal because the signal table scrolls horizontally, and
// an absolutely-positioned tooltip inside a scroll container gets clipped by it.
function SignalHelp({ label, description }: { label: string; description: string }) {
  const [anchor, setAnchor] = useState<TipAnchor | null>(null);

  const open = (event: { currentTarget: HTMLElement }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const above = window.innerHeight - rect.bottom < TIP_FLIP_MARGIN;
    setAnchor({
      // Keep the panel on screen when the trigger sits near the right edge.
      x: Math.max(16, Math.min(rect.left, window.innerWidth - TIP_WIDTH - 16)),
      y: above ? rect.top - 8 : rect.bottom + 8,
      above,
    });
  };
  const close = () => setAnchor(null);

  return (
    <>
      <button
        type="button"
        aria-label={`What is ${label}?`}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        className="text-ink-dim/60 transition-colors hover:text-ink focus-visible:text-ink"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      {anchor &&
        createPortal(
          <div
            role="tooltip"
            style={{
              left: anchor.x,
              top: anchor.y,
              width: TIP_WIDTH,
              // Anchoring by transform means the flip works without knowing
              // the rendered height of the text.
              transform: anchor.above ? 'translateY(-100%)' : undefined,
            }}
            className="pointer-events-none fixed z-50 rounded-md border border-edge bg-panel-deep p-3 shadow-xl"
          >
            <p className="text-xs font-semibold text-ink">{label}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-dim">{description}</p>
          </div>,
          document.body
        )}
    </>
  );
}

function StatCell({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'good' | 'warn';
}) {
  const toneClass =
    tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-warn' : 'text-ink';
  return (
    <div className="rounded-lg border border-edge bg-panel-deep p-3">
      <p className="text-[11px] uppercase tracking-wider text-ink-dim">{label}</p>
      <p className={`mt-1 font-mono text-lg font-semibold ${toneClass}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-ink-dim">{hint}</p>}
    </div>
  );
}

// Everything the tracker knows about this vehicle: how the time was actually
// spent, and the raw signal set behind it. The signal rows come from the last
// frame the device sent, so enabling a new IO element in the configurator
// makes it appear here without a code change.
export function VehicleSignalsTable({
  vehicleId,
  refreshKey = 0,
}: {
  vehicleId: string;
  refreshKey?: number | string;
}) {
  const [days, setDays] = useState(1);
  const [data, setData] = useState<VehicleSignalsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // The previous window's numbers stay on screen until the new ones land —
    // switching range shouldn't blank the panel out.
    getVehicleSignals(vehicleId, days)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [vehicleId, days, refreshKey]);

  const grouped = useMemo(() => {
    const buckets = new Map<VehicleSignal['group'], VehicleSignal[]>();
    for (const signal of data?.signals ?? []) {
      const list = buckets.get(signal.group) ?? [];
      list.push(signal);
      buckets.set(signal.group, list);
    }
    return GROUP_ORDER.flatMap((group) => {
      const rows = buckets.get(group);
      return rows?.length ? [{ group, rows }] : [];
    });
  }, [data]);

  const activity = data?.activity ?? null;
  const engineOn = num(activity?.engine_on_seconds);
  const moving = num(activity?.moving_seconds);
  const idle = num(activity?.idle_seconds);
  const fuelUsed = num(activity?.fuel_used_liters);
  // Idling is only worth flagging when the engine ran long enough for it to
  // cost something — a 30-second start-up is not a finding.
  const idleHeavy = engineOn > 300 && idle / engineOn > 0.5;

  return (
    <div className="rounded-lg border border-edge bg-panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-ink">Vehicle data</h3>
          <p className="text-xs text-ink-dim">
            Every signal the tracker reports, and how the time was spent
          </p>
        </div>
        <div className="flex rounded-md border border-edge bg-panel-deep p-0.5">
          {RANGES.map((range) => (
            <button
              key={range.days}
              type="button"
              onClick={() => setDays(range.days)}
              className={`rounded px-2.5 py-1 text-xs transition-colors ${
                days === range.days
                  ? 'bg-panel-hover font-semibold text-ink'
                  : 'text-ink-dim hover:text-ink'
              }`}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !data ? (
        <p className="mt-4 text-sm text-ink-dim">Loading vehicle data…</p>
      ) : !data || (!activity?.records && !data.signals.length) ? (
        <p className="mt-4 text-sm text-ink-dim">
          No telemetry from this vehicle in the selected window.
        </p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            <StatCell
              label="Time moved"
              value={formatDuration(moving)}
              hint={
                activity?.first_moved_at
                  ? `${formatClock(activity.first_moved_at)} – ${formatClock(activity.last_moved_at)}`
                  : 'vehicle did not move'
              }
              tone={moving > 0 ? 'good' : 'default'}
            />
            <StatCell
              label="Time idling"
              value={formatDuration(idle)}
              hint={idleHeavy ? 'most of the engine time' : 'engine on, not moving'}
              tone={idleHeavy ? 'warn' : 'default'}
            />
            <StatCell
              label="Engine on"
              value={formatDuration(engineOn)}
              hint={`${activity?.ignition_cycles ?? 0} ignition cycle${
                activity?.ignition_cycles === 1 ? '' : 's'
              }`}
            />
            <StatCell
              label="Distance"
              value={`${activity?.distance_km ?? 0} km`}
              hint={
                activity?.avg_moving_speed_kph
                  ? `avg ${activity.avg_moving_speed_kph} km/h moving`
                  : 'no distance recorded'
              }
            />
            <StatCell
              label="Fuel used"
              value={`${fuelUsed.toFixed(2)} L`}
              hint={
                idle > 0 && moving === 0
                  ? 'burned entirely at standstill'
                  : 'from the GPS fuel accumulator'
              }
              tone={idle > 0 && moving === 0 ? 'warn' : 'default'}
            />
            <StatCell
              label="Top speed"
              value={`${activity?.max_speed_kph ?? 0} km/h`}
            />
            <StatCell label="Records" value={String(activity?.records ?? 0)} hint="frames stored" />
            <StatCell
              label="GPS fix"
              value={data.gps_satellites != null ? `${data.gps_satellites} sats` : '—'}
              hint={data.gps_valid ? 'valid fix' : 'no valid fix'}
              tone={data.gps_valid ? 'good' : 'warn'}
            />
          </div>

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="border-b border-edge text-left text-[11px] uppercase tracking-wider text-ink-dim">
                  <th className="pb-2 font-medium">Signal</th>
                  <th className="pb-2 text-right font-medium">Value</th>
                  <th className="pb-2 pl-4 text-right font-medium">AVL</th>
                </tr>
              </thead>
              <tbody>
                {grouped.map(({ group, rows }) => {
                  const meta = GROUP_META[group];
                  const Icon = meta.icon;
                  return (
                    <Fragment key={group}>
                      <tr>
                        <td colSpan={3} className="pt-3 pb-1">
                          <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-dim">
                            <Icon className="h-3 w-3" />
                            {meta.label}
                          </span>
                        </td>
                      </tr>
                      {rows.map((signal) => (
                        <tr
                          key={signal.avl_id}
                          className="border-t border-edge/50 hover:bg-panel-hover/40"
                        >
                          <td className="py-1.5 text-ink">
                            <span className="flex items-center gap-1.5">
                              {signal.label}
                              {signal.description && (
                                <SignalHelp
                                  label={signal.label}
                                  description={signal.description}
                                />
                              )}
                            </span>
                          </td>
                          <td className="py-1.5 text-right font-mono text-ink">
                            {signal.display}
                          </td>
                          <td className="py-1.5 pl-4 text-right font-mono text-xs text-ink-dim">
                            {signal.avl_id}
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-ink-dim">
            {data.frame_at
              ? `Signals from the frame received ${new Date(data.frame_at).toLocaleString()}.`
              : 'No frame stored for this device yet.'}{' '}
            Engine, coolant, RPM and tyre-pressure rows require a CAN adapter or
            TPMS sensors. The tracker alone cannot report them, so they appear
            here only once that hardware is fitted.
          </p>
        </>
      )}
    </div>
  );
}
