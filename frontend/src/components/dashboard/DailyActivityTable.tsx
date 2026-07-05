'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Gauge,
  Play,
} from 'lucide-react';
import {
  api,
  DailyActivityFlagRow,
  DailyActivityResponse,
  DailyActivityRow,
  DailyActivityStatus,
} from '@/lib/api';
import { EventReplayPanel } from '@/components/dashboard/EventReplayPanel';
import { ReplayTarget } from '@/lib/replay-target';

const PAGE_SIZE = 20;

const STATUS_STYLES: Record<
  DailyActivityStatus,
  { className: string; icon?: boolean }
> = {
  normal: { className: 'text-good' },
  low_efficiency: { className: 'text-bad', icon: true },
  high_usage: { className: 'text-warn', icon: true },
  data_anomaly: { className: 'text-bad-bright font-semibold', icon: true },
  unknown: { className: 'text-ink-dim' },
};

const SEVERITY_STYLES: Record<string, string> = {
  low: 'bg-ink-dim/20 text-ink-mid',
  medium: 'bg-warn/20 text-warn',
  high: 'bg-bad/20 text-bad',
  critical: 'bg-bad-bright/20 text-bad-bright',
};

function formatActivityDate(row: DailyActivityRow) {
  if (row.activity_date_display) return row.activity_date_display;
  const iso = row.activity_date.slice(0, 10);
  const date = new Date(`${iso}T12:00:00Z`);
  return date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function Pagination({
  page,
  totalPages,
  total,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (p: number) => void;
}) {
  return (
    <div className="flex items-center justify-between border-t border-edge bg-canvas px-6 py-3">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className="rounded-lg border border-edge px-3 py-1 text-xs disabled:opacity-40"
      >
        Previous
      </button>
      <span className="text-xs text-ink-dim">
        Page {page} of {totalPages} · {total} records
      </span>
      <button
        type="button"
        disabled={page >= totalPages}
        onClick={() => onPage(page + 1)}
        className="rounded-lg border border-edge px-3 py-1 text-xs disabled:opacity-40"
      >
        Next
      </button>
    </div>
  );
}

export function DailyActivityTable({
  onViewDay,
}: {
  onViewDay?: (vehicleId: string, activityDate: string) => void;
}) {
  const [data, setData] = useState<DailyActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [replayTarget, setReplayTarget] = useState<ReplayTarget | null>(null);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api<DailyActivityResponse>(
        `/telemetry/daily-activity?days=30&page=${p}&limit=${PAGE_SIZE}`
      );
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load daily activity');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(page);
  }, [page, load]);

  const flagsByRow = useMemo(() => {
    const map = new Map<string, DailyActivityFlagRow[]>();
    for (const flag of data?.active_flags ?? []) {
      const key = `${flag.vehicle_id}-${flag.activity_date}`;
      const list = map.get(key) ?? [];
      list.push(flag);
      map.set(key, list);
    }
    return map;
  }, [data?.active_flags]);

  const todayFlags = data?.active_flags ?? [];

  return (
    <>
      {replayTarget && (
        <EventReplayPanel target={replayTarget} onClose={() => setReplayTarget(null)} />
      )}
    <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
      <div className="overflow-hidden rounded-lg border border-edge bg-panel">
        <div className="border-b border-edge px-6 py-4">
          <h2 className="flex items-center gap-2 font-semibold text-ink">
            <Gauge className="h-4 w-4" /> Fleet efficiency overview (daily)
          </h2>
          <p className="mt-1 text-xs text-ink-dim">
            Daily metrics with plain-language status and insight — flags shown separately →
          </p>
        </div>

        {error && <p className="px-6 py-3 text-sm text-bad">{error}</p>}

        {loading ? (
          <p className="p-6 text-sm text-ink-dim">Loading daily activity…</p>
        ) : (data?.rows.length ?? 0) === 0 ? (
          <p className="p-6 text-sm text-ink-dim">No daily activity in this period.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="bg-canvas text-xs uppercase tracking-wider text-ink-dim">
                  <tr>
                    <th className="w-8 px-2 py-3" />
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Vehicle</th>
                    <th className="px-4 py-3">Driver</th>
                    <th className="px-4 py-3">Distance</th>
                    <th className="px-4 py-3">Fuel used</th>
                    <th className="px-4 py-3">L/100km</th>
                    <th className="px-4 py-3">Target</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Insight</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-divider text-ink-mid">
                  {data?.rows.map((row) => {
                    const key = `${row.vehicle_id}-${row.activity_date}`;
                    const expanded = expandedKey === key;
                    const rowFlags = flagsByRow.get(key) ?? [];
                    return (
                      <ActivityRowBlock
                        key={key}
                        row={row}
                        expanded={expanded}
                        rowFlags={rowFlags}
                        onToggle={() => setExpandedKey(expanded ? null : key)}
                        onViewDay={onViewDay}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination
              page={data?.page ?? 1}
              totalPages={data?.total_pages ?? 1}
              total={data?.total ?? 0}
              onPage={setPage}
            />
          </>
        )}
      </div>

      <ActiveFlagsPanel
        flags={todayFlags}
        loading={loading}
        onReplay={(flag) =>
          setReplayTarget({
            kind: 'daily',
            vehicleId: flag.vehicle_id,
            activityDate: flag.activity_date.slice(0, 10),
            flagType: flag.flag_type,
          })
        }
      />
    </div>
    </>
  );
}

function ActivityRowBlock({
  row,
  expanded,
  rowFlags,
  onToggle,
  onViewDay,
}: {
  row: DailyActivityRow;
  expanded: boolean;
  rowFlags: DailyActivityFlagRow[];
  onToggle: () => void;
  onViewDay?: (vehicleId: string, activityDate: string) => void;
}) {
  const statusStyle = STATUS_STYLES[row.status] ?? STATUS_STYLES.unknown;
  const deviation = row.efficiency_deviation_percent;

  return (
    <>
      <tr className="hover:bg-canvas/40">
        <td className="px-2 py-2.5">
          <button
            type="button"
            onClick={onToggle}
            className="rounded p-0.5 text-ink-dim hover:bg-divider"
            aria-label={expanded ? 'Collapse row' : 'Expand row'}
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </td>
        <td className="whitespace-nowrap px-4 py-2.5 text-xs text-ink">
          {formatActivityDate(row)}
        </td>
        <td className="px-4 py-2.5 font-medium text-brand">{row.license_plate}</td>
        <td className="px-4 py-2.5">{row.driver_name ?? '—'}</td>
        <td className="px-4 py-2.5 font-mono">{row.distance_km} km</td>
        <td className="px-4 py-2.5 font-mono">{row.fuel_used_liters.toFixed(1)} L</td>
        <td className="px-4 py-2.5 font-mono">
          {row.data_anomaly
            ? '—'
            : row.efficiency_l_100km != null
              ? `${row.efficiency_l_100km.toFixed(1)} L/100km`
              : '—'}
        </td>
        <td className="px-4 py-2.5 font-mono text-ink-dim">
          {row.expected_efficiency_l_100km.toFixed(1)} L/100km
        </td>
        <td className={`px-4 py-2.5 text-xs ${statusStyle.className}`}>
          {statusStyle.icon && row.status !== 'normal' && <span className="mr-1">⚠</span>}
          {row.status_label}
        </td>
        <td className="max-w-xs px-4 py-2.5 text-xs leading-relaxed text-ink-dim">
          {row.insight ?? '—'}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-canvas/60">
          <td colSpan={10} className="px-6 py-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Detail
                label="Target"
                value={`${row.expected_efficiency_l_100km.toFixed(1)} L/100km (${row.model ?? 'fleet default'})`}
              />
              <Detail
                label="Deviation"
                value={
                  deviation != null
                    ? `${deviation > 0 ? '+' : ''}${deviation.toFixed(0)}% vs L/100km target`
                    : '—'
                }
                highlight={deviation != null && deviation > 10}
              />
              <Detail
                label="Consumption"
                value={
                  row.data_anomaly
                    ? row.raw_efficiency_l_100km != null
                      ? `${row.raw_efficiency_l_100km.toFixed(1)} L/100km (unreliable)`
                      : '— (data anomaly)'
                    : row.efficiency_l_100km != null
                      ? `${row.efficiency_l_100km.toFixed(1)} L/100km`
                      : '—'
                }
                highlight={row.data_anomaly}
              />
              <Detail label="Idle time" value={`${row.idle_hours.toFixed(1)} hrs`} />
              <Detail label="Trips" value={String(row.trip_count)} />
              <Detail
                label="Expected distance"
                value={`${row.expected_distance_min_km}–${row.expected_distance_max_km} km/day`}
              />
            </div>
            {rowFlags.length > 0 && (
              <div className="mt-4 rounded-lg border border-edge bg-panel p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-dim">
                  Flags for this day
                </p>
                <ul className="mt-2 space-y-1 text-sm text-ink-mid">
                  {rowFlags.map((f) => (
                    <li key={f.id}>
                      • {f.flag_label}: {f.reason}
                      {f.suggestion ? ` — ${f.suggestion}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {onViewDay && (
              <button
                type="button"
                onClick={() => onViewDay(row.vehicle_id, row.activity_date)}
                className="mt-4 inline-flex items-center gap-1 rounded-lg border border-accent/40 bg-accent/15 px-3 py-2 text-xs font-medium text-brand"
              >
                <Play className="h-3.5 w-3.5" /> View day on map
              </button>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function Detail({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-ink-dim">{label}</p>
      <p className={`mt-0.5 font-mono text-sm ${highlight ? 'text-bad' : 'text-ink'}`}>
        {value}
      </p>
    </div>
  );
}

function ActiveFlagsPanel({
  flags,
  loading,
  onReplay,
}: {
  flags: DailyActivityFlagRow[];
  loading: boolean;
  onReplay: (flag: DailyActivityFlagRow) => void;
}) {
  return (
    <div className="h-fit rounded-lg border border-edge bg-panel xl:sticky xl:top-6">
      <div className="border-b border-edge px-5 py-4">
        <h3 className="flex items-center gap-2 font-semibold text-ink">
          <AlertTriangle className="h-4 w-4 text-bad" /> Active flags
        </h3>
        <p className="mt-1 text-xs text-ink-dim">
          Business intelligence — separate from raw metrics
        </p>
      </div>
      <div className="max-h-[520px] space-y-2 overflow-y-auto p-4">
        {loading && <p className="text-sm text-ink-dim">Loading flags…</p>}
        {!loading && flags.length === 0 && (
          <p className="py-8 text-center text-sm text-good">No active flags in this period</p>
        )}
        {flags.map((flag) => (
          <div
            key={flag.id}
            className="rounded-lg border border-divider bg-canvas p-3 text-sm"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-medium text-brand">{flag.license_plate}</p>
                <p className="text-xs text-ink-dim">{flag.flag_label}</p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] capitalize ${SEVERITY_STYLES[flag.severity] ?? SEVERITY_STYLES.medium}`}
              >
                {flag.severity}
              </span>
            </div>
            <p className="mt-2 text-xs text-ink-mid">{flag.reason}</p>
            <p className="mt-1 text-xs text-bad">{flag.impact}</p>
            {flag.suggestion && (
              <p className="mt-2 text-[10px] text-ink-dim">→ {flag.suggestion}</p>
            )}
            <button
              type="button"
              onClick={() => onReplay(flag)}
              className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-accent/50 bg-accent/15 py-2 text-xs font-semibold text-brand transition-colors hover:bg-accent/25"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              Replay & verify
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
