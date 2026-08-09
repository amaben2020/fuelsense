'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Clock,
  Gauge,
  Info,
  MapPin,
  Moon,
  Radio,
  ShieldAlert,
  TrendingDown,
  Wrench,
} from 'lucide-react';
import {
  Geofence,
  GeofenceEvent,
  HoursResponse,
  MaintenanceResponse,
  SecurityResponse,
  UtilisationResponse,
  fetchDrivingHours,
  fetchGeofenceEvents,
  fetchGeofences,
  fetchMaintenance,
  fetchSecuritySignals,
  fetchUtilisation,
} from '@/lib/api';
import { HatchBar, Panel, StatusChip, TabRow } from '@/components/ui/chrome';
import { LoadErrorBanner } from './LoadErrorBanner';

type Tab = 'maintenance' | 'security' | 'hours' | 'utilisation' | 'zones';

const WINDOW_DAYS = 30;

/** Shared empty state. Says why there is nothing, never just "no data". */
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl bg-panel-deep px-4 py-6 text-center text-sm text-ink-dim">
      {children}
    </p>
  );
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

const relTime = (iso: string) => new Date(iso).toLocaleString();

export function FleetIntelligencePanel() {
  const [tab, setTab] = useState<Tab>('maintenance');
  const [maintenance, setMaintenance] = useState<MaintenanceResponse | null>(null);
  const [security, setSecurity] = useState<SecurityResponse | null>(null);
  const [hours, setHours] = useState<HoursResponse | null>(null);
  const [utilisation, setUtilisation] = useState<UtilisationResponse | null>(null);
  const [zones, setZones] = useState<Geofence[]>([]);
  const [zoneEvents, setZoneEvents] = useState<GeofenceEvent[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const runFetch = useCallback(() => {
    Promise.all([
      fetchMaintenance(),
      fetchSecuritySignals(WINDOW_DAYS),
      fetchDrivingHours(WINDOW_DAYS),
      fetchUtilisation(WINDOW_DAYS),
      fetchGeofences(),
      fetchGeofenceEvents(WINDOW_DAYS),
    ])
      .then(([m, s, h, u, z, ze]) => {
        setMaintenance(m);
        setSecurity(s);
        setHours(h);
        setUtilisation(u);
        setZones(z);
        setZoneEvents(ze.events);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    runFetch();
  }, [runFetch]);

  useEffect(() => {
    runFetch();
  }, [runFetch]);

  // Counts ride on the tabs so the badge is the reason to click.
  const tabs = useMemo(
    () => [
      {
        id: 'maintenance' as const,
        label: 'Maintenance',
        count: (maintenance?.overdue ?? 0) + (maintenance?.due_soon ?? 0),
      },
      { id: 'security' as const, label: 'Security', count: security?.events.length ?? 0 },
      { id: 'hours' as const, label: 'Hours', count: hours?.flagged.length ?? 0 },
      { id: 'utilisation' as const, label: 'Utilisation' },
      { id: 'zones' as const, label: 'Zones', count: zones.length },
    ],
    [maintenance, security, hours, zones]
  );

  if (error) {
    return <LoadErrorBanner error={error} subject="fleet intelligence" onRetry={load} />;
  }

  return (
    <div className="space-y-4">
      <Panel
        icon={Gauge}
        title="Fleet intelligence"
        subtitle={`Derived from the tracker's own signals over the last ${WINDOW_DAYS} days — no extra hardware`}
        onRefresh={load}
        refreshing={loading}
      >
        <TabRow items={tabs} active={tab} onChange={setTab} />

        <div className="pt-4">
          {tab === 'maintenance' && (
            <div className="space-y-3">
              {maintenance == null || maintenance.items.length === 0 ? (
                <Empty>
                  No service schedules yet. Add one per vehicle (oil, tyres, brakes) and it
                  tracks against the tracker&apos;s measured odometer.
                </Empty>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <Metric
                      icon={AlertTriangle}
                      label="Overdue"
                      value={String(maintenance.overdue)}
                      tone={maintenance.overdue > 0 ? 'bad' : undefined}
                    />
                    <Metric
                      icon={Clock}
                      label="Due soon"
                      value={String(maintenance.due_soon)}
                      sub={`within ${maintenance.thresholds.due_soon_km} km`}
                      tone={maintenance.due_soon > 0 ? 'warn' : undefined}
                    />
                    <Metric
                      icon={Wrench}
                      label="Schedules"
                      value={String(maintenance.items.length)}
                    />
                  </div>
                  <ul className="divide-y divide-divider">
                    {maintenance.items.map((m) => (
                      <li key={m.id} className="flex flex-wrap items-center gap-3 py-3">
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-medium capitalize text-ink">
                              {m.kind.replace(/_/g, ' ')}
                            </span>
                            <StatusChip
                              tone={
                                m.status === 'overdue'
                                  ? 'bad'
                                  : m.status === 'due_soon'
                                    ? 'warn'
                                    : 'good'
                              }
                            >
                              {m.status === 'overdue'
                                ? 'Overdue'
                                : m.status === 'due_soon'
                                  ? 'Due soon'
                                  : 'OK'}
                            </StatusChip>
                            {/* Without an anchored baseline the mileage is
                                distance-since-fitting, which is not the number
                                on the dashboard. Say so rather than imply it. */}
                            {!m.odometer_anchored && (
                              <StatusChip tone="neutral">odometer not anchored</StatusChip>
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-ink-dim">
                            <span className="font-mono">{m.license_plate}</span>
                            {m.current_km != null
                              ? ` · now ${m.current_km.toLocaleString()} km`
                              : ' · no odometer reading'}
                            {m.due_at_km != null ? ` · due at ${m.due_at_km.toLocaleString()} km` : ''}
                          </span>
                        </span>
                        {m.km_remaining != null && (
                          <span
                            className={`shrink-0 text-sm font-semibold tabular-nums ${
                              m.km_remaining < 0 ? 'text-bad' : 'text-ink'
                            }`}
                          >
                            {m.km_remaining < 0
                              ? `${Math.abs(m.km_remaining).toLocaleString()} km over`
                              : `${m.km_remaining.toLocaleString()} km left`}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {tab === 'security' && (
            <div className="space-y-3">
              <p className="flex items-start gap-2 text-[11px] leading-relaxed text-ink-dim">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Candidates, not verdicts. Signal loss is flagged only when GSM drops to{' '}
                {security?.thresholds.weak_gsm_bars ?? 1} bar or less <em>and</em> satellite lock
                fails <em>while moving</em> — a tunnel looks identical for the first few seconds.
              </p>
              {security == null || security.events.length === 0 ? (
                <Empty>
                  No jamming signature or unexplained silence in {WINDOW_DAYS} days. GSM held
                  through every journey.
                </Empty>
              ) : (
                <ul className="divide-y divide-divider">
                  {security.events.map((e, i) => (
                    <li key={`${e.at}-${i}`} className="flex items-center gap-3 py-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-bad-deep/40 text-bad">
                        {e.kind === 'signal_loss' ? (
                          <Radio className="h-4 w-4" />
                        ) : (
                          <ShieldAlert className="h-4 w-4" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-ink">
                          {e.kind === 'signal_loss'
                            ? 'Signal and satellite lock lost at speed'
                            : 'Reporting stopped mid-journey'}
                        </span>
                        <span className="block truncate text-xs text-ink-dim">
                          <span className="font-mono">{e.license_plate}</span> · {relTime(e.at)}
                          {e.speed_before_kph != null ? ` · was at ${e.speed_before_kph} km/h` : ''}
                          {e.gap_seconds != null
                            ? ` · silent ${Math.round(e.gap_seconds / 60)}m`
                            : ''}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {tab === 'hours' && (
            <div className="space-y-3">
              {hours == null || hours.vehicles.length === 0 ? (
                <Empty>No driving stretches recorded in the window.</Empty>
              ) : (
                <>
                  <ul className="divide-y divide-divider">
                    {hours.vehicles.map((v) => (
                      <li key={v.vehicle_id} className="py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium text-ink">
                            {v.driver_name ?? v.license_plate}
                          </span>
                          <span className="flex items-center gap-2">
                            {v.long_stretches > 0 && (
                              <StatusChip tone="warn">
                                {v.long_stretches} over {hours.thresholds.fatigue_hours}h
                              </StatusChip>
                            )}
                            {v.night_stretches > 0 && (
                              <StatusChip tone="info">
                                <Moon className="h-3 w-3" /> {v.night_stretches} night
                              </StatusChip>
                            )}
                          </span>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <Metric icon={Clock} label="Total" value={`${v.total_hours}h`} />
                          <Metric icon={Clock} label="Longest run" value={`${v.longest_hours}h`} />
                          <Metric icon={Gauge} label="Stretches" value={String(v.stretches)} />
                          <Metric
                            icon={AlertTriangle}
                            label="Over limit"
                            value={String(v.long_stretches)}
                            tone={v.long_stretches > 0 ? 'warn' : undefined}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-ink-dim">
                    A stretch ends after {hours.thresholds.break_minutes} minutes stationary.
                    Thresholds are ours, not a regulator&apos;s — no HOS rule is encoded here.
                  </p>
                </>
              )}
            </div>
          )}

          {tab === 'utilisation' && (
            <div className="space-y-3">
              {utilisation == null || utilisation.vehicles.length === 0 ? (
                <Empty>No movement recorded in the window.</Empty>
              ) : (
                <ul className="divide-y divide-divider">
                  {utilisation.vehicles.map((v) => (
                    <li key={v.vehicle_id} className="py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0">
                          <span className="font-mono font-medium text-ink">
                            {v.license_plate}
                          </span>
                          <span className="ml-2 text-xs text-ink-dim">
                            {[v.make, v.model].filter(Boolean).join(' ')}
                          </span>
                        </span>
                        {/* Under a third of days used is the right-sizing
                            conversation, so it gets said outright. */}
                        {v.active_share < 0.34 && (
                          <StatusChip tone="warn">
                            <TrendingDown className="h-3 w-3" /> underused
                          </StatusChip>
                        )}
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                        <Metric
                          icon={Gauge}
                          label="Distance"
                          value={`${v.distance_km.toLocaleString()} km`}
                        />
                        <Metric
                          icon={Clock}
                          label="Active days"
                          value={`${v.active_days}/${utilisation.period_days}`}
                        />
                        <Metric
                          icon={Gauge}
                          label="Km / active day"
                          value={v.km_per_active_day != null ? `${v.km_per_active_day}` : '—'}
                        />
                        <Metric
                          icon={Clock}
                          label="Engine hours"
                          value={`${v.engine_hours}h`}
                          sub={
                            v.km_per_engine_hour != null
                              ? `${v.km_per_engine_hour} km/h running`
                              : null
                          }
                        />
                      </div>
                      <div className="mt-2">
                        <HatchBar
                          value={v.active_share * 100}
                          tone={v.active_share < 0.34 ? 'amber' : 'good'}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {tab === 'zones' && (
            <div className="space-y-3">
              {zones.length === 0 ? (
                <Empty>
                  No zones yet. Create one around a depot or a customer site and every entry and
                  exit is detected from position alone.
                </Empty>
              ) : (
                <ul className="divide-y divide-divider">
                  {zones.map((z) => (
                    <li key={z.id} className="flex items-center gap-3 py-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-y/15 text-accent-y-dim">
                        <MapPin className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-ink">{z.name}</span>
                        <span className="block truncate text-xs capitalize text-ink-dim">
                          {z.purpose} · {z.shape}
                          {z.radius_m ? ` · ${z.radius_m} m radius` : ''} · notify {z.notify_on}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
                  Recent crossings
                </p>
                {zoneEvents.length === 0 ? (
                  <Empty>No entries or exits recorded in the window.</Empty>
                ) : (
                  <ul className="divide-y divide-divider">
                    {zoneEvents.slice(0, 20).map((e, i) => (
                      <li key={`${e.at}-${i}`} className="flex items-center gap-3 py-2.5">
                        <StatusChip tone={e.direction === 'entered' ? 'good' : 'neutral'}>
                          {e.direction}
                        </StatusChip>
                        <span className="min-w-0 flex-1 truncate text-sm text-ink">
                          {e.zone_name}
                        </span>
                        <span className="shrink-0 text-xs text-ink-dim">
                          <span className="font-mono">{e.license_plate}</span> · {relTime(e.at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
