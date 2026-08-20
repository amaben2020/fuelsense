'use client';

import { useCallback, useEffect, useState } from 'react';
import { LogIn, LogOut, MapPin, Pentagon, Trash2 } from 'lucide-react';
import {
  Geofence,
  GeofenceEvent,
  deleteGeofence,
  fetchGeofenceEvents,
  fetchGeofences,
} from '@/lib/api';
import { Panel, StatusChip } from '@/components/ui/chrome';
import { ZONE_PURPOSE_LABEL } from '@/lib/trust-language';

/**
 * How big the zone is, in the terms its own shape is defined by.
 *
 * This used to read the radius unconditionally, so every polygon zone showed a
 * bare "—" and looked broken — the shape carries the size for those, not a
 * radius that was never set.
 */
function sizeLabel(z: Geofence): string {
  if (z.shape === 'polygon') {
    const corners = Array.isArray(z.polygon) ? z.polygon.length : 0;
    // Four corners is how a rectangle is stored, so it is named as one.
    if (corners === 4) return 'Rectangle';
    return corners >= 3 ? `Polygon · ${corners} corners` : 'Polygon (incomplete)';
  }
  const m = z.radius_m;
  if (m == null) return '—';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km radius` : `${m} m radius`;
}

function whenLabel(iso: string): string {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString();
}

export function GeofencesPanel({ onDrawZone }: { onDrawZone?: () => void }) {
  const [zones, setZones] = useState<Geofence[]>([]);
  const [events, setEvents] = useState<GeofenceEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(() => {
    return Promise.all([fetchGeofences(), fetchGeofenceEvents(30)])
      .then(([z, e]) => {
        setZones(z);
        setEvents(e.events);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (id: string) => {
    setDeleting(id);
    try {
      await deleteGeofence(id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-6">
      <Panel
        icon={Pentagon}
        title="Zones"
        subtitle="Depots, customer sites and no-go areas. Entry and exit are evaluated against every position fix."
        actions={
          onDrawZone ? (
            <button
              type="button"
              onClick={onDrawZone}
              className="rounded-full bg-brand px-3.5 py-1.5 text-xs font-semibold text-canvas transition-opacity hover:opacity-90"
            >
              Draw a zone
            </button>
          ) : undefined
        }
        onRefresh={load}
        refreshing={loading}
      >
        {error && (
          <p className="mb-3 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
            {error}
          </p>
        )}

        {!loading && zones.length === 0 ? (
          <div className="rounded-xl border border-dashed border-edge px-4 py-8 text-center">
            <MapPin className="mx-auto mb-2 h-5 w-5 text-ink-dim" />
            <p className="text-sm text-ink-mid">No zones yet</p>
            <p className="mt-1 text-xs text-ink-dim">
              Draw one on the live map — click the zone tool, then pick a circle,
              rectangle or polygon.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {zones.map((z) => (
              <li
                key={z.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-panel-deep px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-ink">{z.name}</p>
                    <StatusChip tone={z.active ? 'good' : 'neutral'}>
                      {ZONE_PURPOSE_LABEL[z.purpose] ?? z.purpose}
                    </StatusChip>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-dim tabular-nums">
                    {z.vehicle_id ? 'One vehicle' : 'All vehicles'} · {sizeLabel(z)}
                    {z.center_lat && z.center_lng
                      ? ` · ${Number(z.center_lat).toFixed(4)}, ${Number(z.center_lng).toFixed(4)}`
                      : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => remove(z.id)}
                  disabled={deleting === z.id}
                  aria-label={`Delete ${z.name}`}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-edge text-ink-dim transition-colors hover:border-bad/50 hover:text-bad disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        icon={LogIn}
        title="Zone activity"
        subtitle="Last 30 days"
        bodyClassName="max-h-[26rem] overflow-y-auto"
      >
        {!loading && events.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-dim">
            No entries or exits recorded yet.
          </p>
        ) : (
          <ul className="divide-y divide-edge">
            {events.map((e, i) => (
              <li
                key={`${e.zone_id}-${e.vehicle_id}-${e.at}-${i}`}
                className="flex items-center gap-3 py-2.5"
              >
                <span
                  className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                    e.direction === 'entered'
                      ? 'bg-brand/15 text-brand'
                      : 'bg-ink-dim/15 text-ink-dim'
                  }`}
                >
                  {e.direction === 'entered' ? (
                    <LogIn className="h-3.5 w-3.5" />
                  ) : (
                    <LogOut className="h-3.5 w-3.5" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">
                    <span className="font-semibold">{e.license_plate}</span>{' '}
                    <span className="text-ink-mid">{e.direction}</span> {e.zone_name}
                  </p>
                  <p className="text-xs text-ink-dim">
                    {e.driver_name || 'Unassigned'} · {whenLabel(e.at)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
