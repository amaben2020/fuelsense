'use client';

import { useEffect, useState } from 'react';
import { Clock, ExternalLink, Loader2, MapPin, X } from 'lucide-react';
import { StopPlace, TripStop, fetchStopPlace, placePhotoSrc } from '@/lib/api';

const KIND_LABEL: Record<TripStop['kind'], string> = {
  origin: 'Trip started here',
  stop: 'Stopped here',
  destination: 'Trip ended here',
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Shows exactly where a driver stopped — address, venue and photo — so a
 *  manager can ask about a specific place rather than a numbered dot. */
export function StopDetailModal({
  stop,
  licensePlate,
  driverName,
  onClose,
}: {
  stop: TripStop | null;
  licensePlate?: string;
  driverName?: string | null;
  onClose: () => void;
}) {
  const [place, setPlace] = useState<StopPlace | null>(null);
  // Starts true and the modal is keyed per stop by its parent, so each stop
  // mounts fresh rather than briefly showing the previous one's address.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!stop) return;
    let cancelled = false;

    fetchStopPlace(stop.lat, stop.lng)
      .then((p) => {
        if (!cancelled) setPlace(p);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [stop]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!stop) return null;

  const photo = placePhotoSrc(place?.photo_url ?? null);
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lng}`;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-edge bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-edge px-5 py-4">
          <div>
            <p className="text-xs uppercase tracking-wider text-ink-dim">
              {KIND_LABEL[stop.kind]}
            </p>
            <h3 className="mt-1 font-semibold text-ink">
              {loading ? 'Resolving location…' : place?.place_name || 'Unnamed location'}
            </h3>
            {licensePlate && (
              <p className="text-xs text-ink-dim">
                {licensePlate}
                {driverName ? ` · ${driverName}` : ''}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-ink-dim hover:text-ink"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {photo && (
          <div className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo}
              alt={place?.place_name ?? 'Stop location'}
              className="h-44 w-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
            <span className="absolute bottom-2 left-2 rounded bg-black/70 px-2 py-0.5 text-[10px] text-white">
              {place?.image_kind === 'street_view'
                ? `Street View${place.street_view_date ? ` · ${place.street_view_date}` : ''}`
                : 'Nearby place photo'}
            </span>
          </div>
        )}

        <div className="space-y-4 px-5 py-4">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-ink-dim">
              <Loader2 className="h-4 w-4 animate-spin" /> Looking up the address…
            </div>
          )}

          {error && (
            <p className="rounded-lg bg-bad-deep/20 p-3 text-sm text-bad">
              Could not resolve this location: {error}
            </p>
          )}

          {place?.formatted_address && (
            <div className="flex gap-2">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
              <p className="text-sm text-ink">{place.formatted_address}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-canvas p-3">
              <p className="text-[11px] uppercase tracking-wider text-ink-dim">Arrived</p>
              <p className="mt-1 text-sm text-ink">{formatWhen(stop.arrived_at)}</p>
            </div>
            <div className="rounded-lg bg-canvas p-3">
              <p className="text-[11px] uppercase tracking-wider text-ink-dim">
                {stop.kind === 'stop' ? 'Stayed' : 'Recorded'}
              </p>
              <p className="mt-1 flex items-center gap-1 text-sm text-ink">
                {stop.kind === 'stop' ? (
                  <>
                    <Clock className="h-3 w-3 text-warn" />
                    {formatDuration(stop.duration_minutes)}
                  </>
                ) : (
                  formatWhen(stop.departed_at)
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-edge pt-3">
            <p className="font-mono text-[11px] text-ink-dim">
              {stop.lat.toFixed(5)}, {stop.lng.toFixed(5)}
            </p>
            <a
              href={mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-edge px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:border-brand hover:text-brand"
            >
              <ExternalLink className="h-3 w-3" /> Open in Maps
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
