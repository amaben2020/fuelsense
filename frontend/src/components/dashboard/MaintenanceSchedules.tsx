'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Check, Clock, Plus, Trash2, Wrench, X } from 'lucide-react';
import {
  FleetVehicle,
  KM_TO_MILES,
  MAINTENANCE_PRESETS,
  MaintenanceItem,
  MaintenanceResponse,
  completeMaintenance,
  createMaintenance,
  deleteMaintenance,
  formatOdometerMiles,
  milesToKm,
  setVehicleOdometer,
} from '@/lib/api';
import { StatusChip } from '@/components/ui/chrome';

const CUSTOM = '__custom__';

const INPUT =
  'mt-1 w-full rounded-lg border border-edge bg-panel px-2 py-2 text-sm text-ink placeholder-ink-dim';

/** Distance in miles, signed the way the row wants to read it. */
function milesLabel(km: number) {
  return Math.abs(Math.round(km * KM_TO_MILES)).toLocaleString();
}

function todayInput() {
  return new Date().toLocaleDateString('en-CA');
}

/**
 * The mileage this vehicle is actually at. Mirrors the backend's fallback:
 * the anchored dashboard total when there is one, otherwise the raw count the
 * tracker has made since it was fitted.
 */
function currentKmOf(v: FleetVehicle | undefined) {
  if (!v) return null;
  return v.total_odometer_km ?? v.odometer_km ?? null;
}

function Metric({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string | null;
  tone?: 'good' | 'warn' | 'bad';
}) {
  const color =
    tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : tone === 'good' ? 'text-good' : 'text-ink';
  return (
    <div className="min-w-0 rounded-xl bg-panel-deep px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-ink-dim">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate text-[11px] font-medium uppercase tracking-wider">{label}</span>
      </div>
      <p className={`mt-1.5 truncate text-xl font-bold tabular-nums tracking-tight ${color}`}>
        {value}
      </p>
      {sub && <p className="mt-0.5 truncate text-[11px] text-ink-dim">{sub}</p>}
    </div>
  );
}

/**
 * Service schedules — the whole feature, not just its readout.
 *
 * The backend has tracked distance and time intervals since it was written,
 * but nothing could ever create a schedule, so the tab could only show its
 * empty state. Creating, completing and deleting live here.
 */
export function MaintenanceSchedules({
  data,
  fleet,
  onChanged,
}: {
  data: MaintenanceResponse | null;
  fleet: FleetVehicle[];
  onChanged: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [vehicleId, setVehicleId] = useState('');
  const [preset, setPreset] = useState(MAINTENANCE_PRESETS[0].kind);
  const [customKind, setCustomKind] = useState('');
  const [intervalMiles, setIntervalMiles] = useState(String(MAINTENANCE_PRESETS[0].intervalMiles));
  const [intervalDays, setIntervalDays] = useState(
    MAINTENANCE_PRESETS[0].intervalDays == null ? '' : String(MAINTENANCE_PRESETS[0].intervalDays)
  );
  const [lastMiles, setLastMiles] = useState('');
  const [lastDate, setLastDate] = useState(todayInput());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; action: 'complete' | 'delete' } | null>(null);

  const [anchorVehicle, setAnchorVehicle] = useState<string | null>(null);
  const [anchorMiles, setAnchorMiles] = useState('');
  const [anchoring, setAnchoring] = useState(false);

  const items = useMemo(() => data?.items ?? [], [data]);

  const byId = useMemo(() => new Map(fleet.map((v) => [v.id, v])), [fleet]);

  /** Vehicles whose mileage is device-since-fitting rather than the dash. */
  const unanchored = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of items) {
      if (!m.odometer_anchored) seen.set(m.vehicle_id, m.license_plate);
    }
    return [...seen].map(([id, plate]) => ({ id, plate }));
  }, [items]);

  const prefillFor = (id: string) => {
    const km = currentKmOf(byId.get(id));
    setLastMiles(km == null ? '' : String(Math.round(km * KM_TO_MILES)));
  };

  const openForm = () => {
    const first = fleet[0]?.id ?? '';
    setVehicleId(first);
    prefillFor(first);
    setLastDate(todayInput());
    setError(null);
    setShowForm(true);
  };

  const choosePreset = (kind: string) => {
    setPreset(kind);
    const p = MAINTENANCE_PRESETS.find((x) => x.kind === kind);
    if (p) {
      setIntervalMiles(String(p.intervalMiles));
      setIntervalDays(p.intervalDays == null ? '' : String(p.intervalDays));
    }
  };

  const submit = async () => {
    const kind = preset === CUSTOM ? customKind.trim() : preset;
    const miles = Number(intervalMiles);
    const days = intervalDays.trim() === '' ? null : Number(intervalDays);

    if (!vehicleId) return setError('Pick a vehicle.');
    if (!kind) return setError('Name the service.');
    if (!(miles > 0) && days == null) {
      return setError('Give a mileage interval, a time interval, or both.');
    }

    setSubmitting(true);
    setError(null);
    try {
      await createMaintenance({
        vehicleId,
        kind,
        intervalKm: miles > 0 ? Math.round(milesToKm(miles)) : null,
        intervalDays: days,
        // Without a baseline the schedule has nothing to count from and can
        // never fall due on distance, so the form always sends one.
        lastServiceKm:
          lastMiles.trim() === '' ? null : Math.round(milesToKm(Number(lastMiles))),
        lastServiceAt: lastDate || null,
      });
      setShowForm(false);
      setCustomKind('');
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const act = async (m: MaintenanceItem, action: 'complete' | 'delete') => {
    setBusyId(m.id);
    setError(null);
    try {
      // Completing without naming a reading is the normal case — the backend
      // resets the interval from the mileage the tracker is at right now.
      if (action === 'complete') await completeMaintenance(m.id);
      else await deleteMaintenance(m.id);
      setConfirm(null);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const anchor = async () => {
    if (!anchorVehicle) return;
    const miles = Number(anchorMiles);
    if (!(miles > 0)) return setError('Type the mileage showing on the dashboard.');
    setAnchoring(true);
    setError(null);
    try {
      await setVehicleOdometer(anchorVehicle, Math.round(milesToKm(miles)));
      setAnchorVehicle(null);
      setAnchorMiles('');
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAnchoring(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => (showForm ? setShowForm(false) : openForm())}
          disabled={fleet.length === 0}
          className="inline-flex items-center gap-1.5 rounded-full bg-brand px-3.5 py-1.5 text-xs font-semibold text-canvas transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {showForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          {showForm ? 'Cancel' : 'Add schedule'}
        </button>
      </div>

      {error && (
        <p className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </p>
      )}

      {showForm && (
        <div className="rounded-xl border border-edge bg-canvas px-4 py-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-xs text-ink-dim">
              Vehicle
              <select
                value={vehicleId}
                onChange={(e) => {
                  setVehicleId(e.target.value);
                  prefillFor(e.target.value);
                }}
                className={INPUT}
              >
                {fleet.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.license_plate}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs text-ink-dim">
              Service
              <select value={preset} onChange={(e) => choosePreset(e.target.value)} className={INPUT}>
                {MAINTENANCE_PRESETS.map((p) => (
                  <option key={p.kind} value={p.kind}>
                    {p.label}
                  </option>
                ))}
                <option value={CUSTOM}>Something else…</option>
              </select>
            </label>

            {preset === CUSTOM && (
              <label className="text-xs text-ink-dim">
                Name it
                <input
                  value={customKind}
                  onChange={(e) => setCustomKind(e.target.value)}
                  placeholder="Cambelt"
                  className={INPUT}
                />
              </label>
            )}

            <label className="text-xs text-ink-dim">
              Every (miles)
              <input
                type="number"
                inputMode="numeric"
                value={intervalMiles}
                onChange={(e) => setIntervalMiles(e.target.value)}
                className={INPUT}
              />
            </label>

            <label className="text-xs text-ink-dim">
              Or every (days) — optional
              <input
                type="number"
                inputMode="numeric"
                value={intervalDays}
                onChange={(e) => setIntervalDays(e.target.value)}
                placeholder="none"
                className={INPUT}
              />
            </label>

            <label className="text-xs text-ink-dim">
              Last done at (miles)
              <input
                type="number"
                inputMode="numeric"
                value={lastMiles}
                onChange={(e) => setLastMiles(e.target.value)}
                className={INPUT}
              />
            </label>

            <label className="text-xs text-ink-dim">
              Last done on
              <input
                type="date"
                value={lastDate}
                onChange={(e) => setLastDate(e.target.value)}
                className={INPUT}
              />
            </label>
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-ink-dim">
            Whichever limit arrives first decides the status. &ldquo;Last done&rdquo; defaults to
            this vehicle&apos;s mileage today — change it if the service was earlier, or the first
            interval will run long.
          </p>

          <button
            type="button"
            disabled={submitting}
            onClick={submit}
            className="mt-3 rounded-lg bg-good px-4 py-2 text-xs font-semibold text-accent-y-ink disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Add schedule'}
          </button>
        </div>
      )}

      {unanchored.length > 0 && (
        <div className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3">
          <p className="text-xs leading-relaxed text-ink-mid">
            <span className="font-semibold text-warn">Mileage is not the dashboard reading</span> for{' '}
            {unanchored.map((u) => u.plate).join(', ')}. The figures below are distance since the
            tracker was fitted, so a service interval set against a dashboard number will read
            wrong. Anchor it once and the two agree from then on.
          </p>
          {anchorVehicle == null ? (
            <button
              type="button"
              onClick={() => {
                setAnchorVehicle(unanchored[0].id);
                setAnchorMiles('');
              }}
              className="mt-2 rounded-full border border-warn/50 px-3 py-1 text-[11px] font-semibold text-warn hover:bg-warn/10"
            >
              Anchor odometer
            </button>
          ) : (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="text-[11px] text-ink-dim">
                Vehicle
                <select
                  value={anchorVehicle}
                  onChange={(e) => setAnchorVehicle(e.target.value)}
                  className={INPUT}
                >
                  {unanchored.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.plate}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] text-ink-dim">
                Dashboard reads (miles)
                <input
                  type="number"
                  inputMode="numeric"
                  value={anchorMiles}
                  onChange={(e) => setAnchorMiles(e.target.value)}
                  placeholder="50813"
                  className={INPUT}
                />
              </label>
              <button
                type="button"
                disabled={anchoring}
                onClick={anchor}
                className="rounded-lg bg-good px-3 py-2 text-xs font-semibold text-accent-y-ink disabled:opacity-50"
              >
                {anchoring ? 'Anchoring…' : 'Anchor'}
              </button>
              <button
                type="button"
                onClick={() => setAnchorVehicle(null)}
                className="rounded-lg border border-edge px-3 py-2 text-xs text-ink-mid hover:bg-panel-hover"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {data == null ? (
        // Not "no schedules" — that is a claim we cannot make until the fetch
        // lands, and stating it during load is how a populated tab reads as
        // empty for its first second.
        <p className="rounded-xl bg-panel-deep px-4 py-6 text-center text-sm text-ink-dim">
          Loading schedules…
        </p>
      ) : items.length === 0 ? (
        <p className="rounded-xl bg-panel-deep px-4 py-6 text-center text-sm text-ink-dim">
          No service schedules yet. Add one per vehicle — oil, tyres, brakes — and it counts down
          against the distance the tracker measures.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Metric
              icon={AlertTriangle}
              label="Overdue"
              value={String(data?.overdue ?? 0)}
              tone={(data?.overdue ?? 0) > 0 ? 'bad' : undefined}
            />
            <Metric
              icon={Clock}
              label="Due soon"
              value={String(data?.due_soon ?? 0)}
              sub={
                data
                  ? `within ${milesLabel(data.thresholds.due_soon_km)} mi or ${data.thresholds.due_soon_days} days`
                  : null
              }
              tone={(data?.due_soon ?? 0) > 0 ? 'warn' : undefined}
            />
            <Metric icon={Wrench} label="Schedules" value={String(items.length)} />
          </div>

          <ul className="divide-y divide-divider">
            {items.map((m) => {
              const busy = busyId === m.id;
              const pending = confirm?.id === m.id ? confirm.action : null;
              return (
                <li key={m.id} className="flex flex-wrap items-center gap-3 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium capitalize text-ink">
                        {m.kind.replace(/_/g, ' ')}
                      </span>
                      <StatusChip
                        tone={
                          m.status === 'overdue' ? 'bad' : m.status === 'due_soon' ? 'warn' : 'good'
                        }
                      >
                        {m.status === 'overdue'
                          ? 'Overdue'
                          : m.status === 'due_soon'
                            ? 'Due soon'
                            : 'OK'}
                      </StatusChip>
                      {/* Without an anchored baseline the mileage is
                          distance-since-fitting, which is not the number on
                          the dashboard. Say so rather than imply it. */}
                      {!m.odometer_anchored && (
                        <StatusChip tone="neutral">since tracker fitted</StatusChip>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-ink-dim">
                      <span className="font-mono">{m.license_plate}</span>
                      {m.current_km != null
                        ? ` · now ${formatOdometerMiles(m.current_km)}`
                        : ' · no odometer reading'}
                      {m.due_at_km != null ? ` · due at ${formatOdometerMiles(m.due_at_km)}` : ''}
                      {m.due_at
                        ? ` · or ${new Date(m.due_at).toLocaleDateString('en-GB')}`
                        : ''}
                    </span>
                  </span>

                  <span className="shrink-0 text-right">
                    {m.km_remaining != null && (
                      <span
                        className={`block text-sm font-semibold tabular-nums ${
                          m.km_remaining < 0 ? 'text-bad' : 'text-ink'
                        }`}
                      >
                        {m.km_remaining < 0
                          ? `${milesLabel(m.km_remaining)} mi over`
                          : `${milesLabel(m.km_remaining)} mi left`}
                      </span>
                    )}
                    {m.days_remaining != null && (
                      <span className="block text-[11px] text-ink-dim">
                        {m.days_remaining < 0
                          ? `${Math.abs(m.days_remaining)} days over`
                          : `${m.days_remaining} days left`}
                      </span>
                    )}
                  </span>

                  {pending ? (
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-[11px] text-ink-dim">
                        {pending === 'complete' ? 'Reset the interval from now?' : 'Delete it?'}
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => act(m, pending)}
                        className={`rounded-full px-3 py-1 text-[11px] font-semibold text-canvas disabled:opacity-50 ${
                          pending === 'delete' ? 'bg-bad' : 'bg-good'
                        }`}
                      >
                        {busy ? '…' : 'Confirm'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirm(null)}
                        className="rounded-full border border-edge px-3 py-1 text-[11px] text-ink-mid hover:bg-panel-hover"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setConfirm({ id: m.id, action: 'complete' })}
                        className="inline-flex items-center gap-1 rounded-full border border-edge px-3 py-1 text-[11px] font-medium text-ink-mid transition-colors hover:border-good/50 hover:text-good"
                      >
                        <Check className="h-3 w-3" /> Mark done
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirm({ id: m.id, action: 'delete' })}
                        aria-label={`Delete ${m.kind} schedule for ${m.license_plate}`}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-edge text-ink-dim transition-colors hover:border-bad/50 hover:text-bad"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
