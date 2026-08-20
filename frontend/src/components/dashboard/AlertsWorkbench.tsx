'use client';

import { useMemo, useState } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  Check,
  Info,
  MapPin,
  Play,
} from 'lucide-react';
import { Alert, formatNgn, resolveAlerts } from '@/lib/api';

type Severity = 'critical' | 'warning' | 'info';

/**
 * Alerts span everything from theft to a driver doing exactly the right thing
 * (filing a receipt), so severity cannot be a fuel_theft/not-fuel_theft
 * switch. Anything unlisted defaults to `warning`: an unrecognised type is
 * more likely a new anomaly than routine noise.
 */
const SEVERITY: Record<string, Severity> = {
  fuel_theft: 'critical',
  receipt_fraud: 'critical',
  // Losing sight of a vehicle is at least as serious as a confirmed theft —
  // it is the gap a dishonest driver blames on "the app was down".
  device_offline: 'critical',
  immobilizer_engaged: 'critical',
  unlogged_fill: 'warning',
  excessive_idle: 'warning',
  idle_fuel_waste: 'warning',
  route_deviation: 'warning',
  fuel_discrepancy: 'warning',
  low_fuel: 'warning',
  overspeeding: 'warning',
  geofence_exit: 'warning',
  geofence_entry: 'info',
  immobilizer_released: 'info',
  trip_start: 'info',
  receipt_uploaded: 'info',
};

/** Short label per type, so the row leads with a category not a paragraph. */
const TYPE_LABEL: Record<string, string> = {
  fuel_theft: 'Possible fuel loss',
  receipt_fraud: 'Receipt mismatch',
  device_offline: 'Tracker offline',
  immobilizer_engaged: 'Immobiliser engaged',
  immobilizer_released: 'Immobiliser released',
  unlogged_fill: 'Fill with no receipt',
  excessive_idle: 'Excessive idling',
  idle_fuel_waste: 'Idle fuel waste',
  route_deviation: 'Off expected route',
  fuel_discrepancy: 'Fuel discrepancy',
  low_fuel: 'Low fuel',
  overspeeding: 'Overspeeding',
  geofence_entry: 'Entered zone',
  geofence_exit: 'Left zone',
  trip_start: 'Trip started',
  receipt_uploaded: 'Receipt filed',
};

const severityOf = (a: Alert): Severity => SEVERITY[a.alert_type] ?? 'warning';

const SEVERITY_STYLE: Record<Severity, { chip: string; rail: string; icon: typeof AlertOctagon }> = {
  critical: { chip: 'bg-bad/20 text-bad', rail: 'bg-bad', icon: AlertOctagon },
  warning: { chip: 'bg-warn/20 text-warn', rail: 'bg-warn', icon: AlertTriangle },
  info: { chip: 'bg-ink-dim/20 text-ink-mid', rail: 'bg-ink-dim', icon: Info },
};

/**
 * The message already opens with the plate on most alert types, and the row
 * shows the plate in its own column — so rendering both produced
 * "LAG-001-FS: LAG-001-FS parked near a filling station…". Strips one leading
 * plate mention, and only when it is genuinely the prefix.
 */
function stripPlate(message: string, plate?: string | null): string {
  if (!plate) return message;
  let out = message;
  for (let i = 0; i < 2; i += 1) {
    const prefix = `${plate}:`;
    if (out.startsWith(prefix)) out = out.slice(prefix.length).trim();
    else if (out.startsWith(`${plate} `)) out = out.slice(plate.length).trim();
    else break;
  }
  return out || message;
}

const dayKey = (iso: string) => new Date(iso).toLocaleDateString();

/**
 * A queue a manager can actually work, rather than a list they can only read.
 *
 * What this replaces: rows whose only action was an undocumented double-click,
 * with the dismiss control landing in a different place depending on how tall
 * the message wrapped, no way to act on more than one at a time, and no way to
 * see past the noise to the two rows that mattered. Twenty-two alerts like
 * that is not a workload, it is wallpaper.
 */
export function AlertsWorkbench({
  alerts,
  onResolved,
  onViewOnMap,
  onReplay,
}: {
  alerts: Alert[];
  /** Ids the server confirmed resolved, so the parent can drop them. */
  onResolved: (ids: number[]) => void;
  onViewOnMap?: (alert: Alert) => void;
  onReplay?: (alert: Alert) => void;
}) {
  const [filter, setFilter] = useState<'all' | Severity>('all');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c = { all: alerts.length, critical: 0, warning: 0, info: 0 };
    for (const a of alerts) c[severityOf(a)] += 1;
    return c;
  }, [alerts]);

  const visible = useMemo(
    () => (filter === 'all' ? alerts : alerts.filter((a) => severityOf(a) === filter)),
    [alerts, filter]
  );

  // Grouped by day so a week of alerts reads as a history rather than one
  // undifferentiated column.
  const groups = useMemo(() => {
    const m = new globalThis.Map<string, Alert[]>();
    for (const a of visible) {
      const k = dayKey(a.created_at);
      const list = m.get(k);
      if (list) list.push(a);
      else m.set(k, [a]);
    }
    return [...m.entries()];
  }, [visible]);

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectAllVisible = () => {
    const ids = visible.map((a) => a.id);
    setSelected((prev) =>
      ids.every((id) => prev.has(id)) ? new Set() : new Set([...prev, ...ids])
    );
  };

  const resolve = async (ids: number[]) => {
    if (!ids.length) return;
    setBusy(true);
    setError(null);
    try {
      // Reconciled against what the server confirmed, not against what was
      // asked for — another session may have cleared some of these already.
      const res = await resolveAlerts(ids);
      onResolved(res.ids);
      setSelected((prev) => {
        const next = new Set(prev);
        res.ids.forEach((id) => next.delete(id));
        return next;
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const allVisibleSelected =
    visible.length > 0 && visible.every((a) => selected.has(a.id));

  if (alerts.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-edge px-4 py-10 text-center">
        <Check className="mx-auto mb-2 h-5 w-5 text-good" />
        <p className="text-sm text-ink">Nothing open</p>
        <p className="mt-1 text-xs text-ink-dim">Every alert has been resolved.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Toolbar: what is in the queue, and the two things you do to it. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              ['all', `All ${counts.all}`],
              ['critical', `Critical ${counts.critical}`],
              ['warning', `Warning ${counts.warning}`],
              ['info', `Info ${counts.info}`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              aria-pressed={filter === key}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                filter === key
                  ? 'bg-accent-y text-accent-y-ink'
                  : 'border border-edge text-ink-mid hover:bg-panel-hover'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={selectAllVisible}
            className="rounded-lg border border-edge px-3 py-1.5 text-xs font-medium text-ink-mid hover:bg-panel-hover"
          >
            {allVisibleSelected ? 'Clear selection' : `Select ${visible.length}`}
          </button>
          <button
            type="button"
            onClick={() => resolve([...selected])}
            disabled={busy || selected.size === 0}
            className="rounded-lg bg-accent-y px-3 py-1.5 text-xs font-semibold text-accent-y-ink transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {busy ? 'Resolving…' : `Resolve ${selected.size || ''}`.trim()}
          </button>
        </div>
      </div>

      {error && (
        <p className="mb-3 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
          {error}
        </p>
      )}

      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-edge px-4 py-8 text-center text-sm text-ink-dim">
          No {filter} alerts.
        </p>
      ) : (
        <div className="space-y-5">
          {groups.map(([day, rows]) => (
            <div key={day}>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
                {day} · {rows.length}
              </p>
              <ul className="divide-y divide-edge overflow-hidden rounded-xl border border-edge">
                {rows.map((a) => {
                  const sev = severityOf(a);
                  const style = SEVERITY_STYLE[sev];
                  const Icon = style.icon;
                  const isSel = selected.has(a.id);
                  return (
                    <li
                      key={a.id}
                      className={`relative flex gap-3 px-4 py-3 transition-colors ${
                        isSel ? 'bg-accent-y/5' : 'bg-panel hover:bg-panel-hover'
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`absolute inset-y-0 left-0 w-0.5 ${style.rail}`}
                      />
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={() => toggle(a.id)}
                        aria-label={`Select alert ${a.id}`}
                        className="mt-1 h-3.5 w-3.5 shrink-0 accent-[var(--accent-y)]"
                      />

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Icon className={`h-3.5 w-3.5 shrink-0 ${
                            sev === 'critical' ? 'text-bad' : sev === 'warning' ? 'text-warn' : 'text-ink-dim'
                          }`} />
                          <span className="text-sm font-semibold text-ink">
                            {TYPE_LABEL[a.alert_type] ?? a.alert_type.replace(/_/g, ' ')}
                          </span>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${style.chip}`}>
                            {sev}
                          </span>
                          {a.license_plate && (
                            <span className="font-mono text-[11px] text-ink-mid">
                              {a.license_plate}
                            </span>
                          )}
                          {a.estimated_loss_ngn != null && Number(a.estimated_loss_ngn) > 0 && (
                            <span className="font-mono text-[11px] tabular-nums text-warn">
                              {formatNgn(Number(a.estimated_loss_ngn))}
                            </span>
                          )}
                        </div>

                        {/* Detail, not headline. Clamped so one verbose alert
                            cannot push the rest of the queue off the screen. */}
                        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-mid">
                          {stripPlate(a.message, a.license_plate)}
                        </p>

                        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-dim">
                          <span>{new Date(a.created_at).toLocaleString()}</span>
                          {a.fuel_drop_liters != null && (
                            <span className="text-warn">
                              −{Number(a.fuel_drop_liters).toFixed(1)} L
                            </span>
                          )}
                          {a.latitude && a.longitude && (
                            <span className="inline-flex items-center gap-1">
                              <MapPin className="h-3 w-3" />
                              {Number(a.latitude).toFixed(4)}, {Number(a.longitude).toFixed(4)}
                            </span>
                          )}
                        </p>
                      </div>

                      {/* Actions are visible and named. The old row hid its
                          only action behind an undocumented double-click. */}
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => resolve([a.id])}
                          disabled={busy}
                          className="rounded-lg border border-edge px-2.5 py-1 text-[11px] font-medium text-ink-mid transition-colors hover:border-good/50 hover:text-good disabled:opacity-40"
                        >
                          Resolve
                        </button>
                        {onReplay && a.vehicle_id && (
                          <button
                            type="button"
                            onClick={() => onReplay(a)}
                            className="inline-flex items-center gap-1 rounded-lg border border-edge px-2.5 py-1 text-[11px] font-medium text-ink-mid hover:bg-panel-hover"
                          >
                            <Play className="h-3 w-3" /> Replay
                          </button>
                        )}
                        {onViewOnMap && a.latitude && a.longitude && (
                          <button
                            type="button"
                            onClick={() => onViewOnMap(a)}
                            className="rounded-lg border border-edge px-2.5 py-1 text-[11px] font-medium text-ink-mid hover:bg-panel-hover"
                          >
                            Map
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
