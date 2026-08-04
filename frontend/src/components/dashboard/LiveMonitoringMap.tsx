'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps';
import { lerp, timeAgo, tripColor } from '@/lib/map-utils';
import {
  FleetVehicle,
  ServerTrip,
  TripStop,
  TripsResponse,
  VehicleTrack,
  formatOdometerMiles,
} from '@/lib/api';
import {
  FLEET_MAPS_KEY,
  LAGOS_CENTER,
  fleetMapDefaults,
} from '@/lib/fleet-map-theme';
import {
  EmphasizedRoute,
  MapResizeFix,
  TripBadgeMarker,
  VehicleCarMarker,
} from '@/components/maps/SharedMapLayers';
import { TripDetailModal } from './TripDetailModal';
import { StopDetailModal } from './StopDetailModal';

const ANIMATION_MS = 1800;

const TRAIL_OPTIONS = [
  { label: '1h', value: 60 },
  { label: '6h', value: 360 },
  { label: '24h', value: 1440 },
  { label: '7d', value: 10080 },
] as const;

type AnimatedTrack = VehicleTrack & {
  displayLat: number;
  displayLng: number;
  displayHeading: number;
};

function MapCameraFollow({
  track,
  enabled,
}: {
  track: AnimatedTrack | null;
  enabled: boolean;
}) {
  const map = useMap();
  const lastPan = useRef(0);

  useEffect(() => {
    if (!map || !track || !enabled) return;
    const now = Date.now();
    if (now - lastPan.current < 1500) return;
    lastPan.current = now;
    map.panTo({ lat: track.displayLat, lng: track.displayLng });
  }, [map, track?.displayLat, track?.displayLng, enabled]);

  return null;
}

function tripPath(trip: ServerTrip): google.maps.LatLngLiteral[] {
  return trip.path.map(([lat, lng]) => ({ lat, lng }));
}

function formatTripTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatTripDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** ISO → the `datetime-local` input format, in the viewer's own timezone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatRangeLabel({ from, to }: { from: string; to: string }): string {
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  return `${new Date(from).toLocaleDateString([], opts)}–${new Date(to).toLocaleDateString([], opts)}`;
}

/** Null when the draft range is valid — otherwise why Apply is disabled. */
function rangeError(from: string, to: string): string | null {
  if (!from || !to) return null;
  const a = new Date(from);
  const b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 'Enter both dates.';
  if (a >= b) return 'From must be before To.';
  if (b.getTime() - a.getTime() > 30 * 86_400_000) return 'Range cannot exceed 30 days.';
  return null;
}

/** Wall-clock HH:MM for a stop's arrive/depart pair. */
function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Zooms the camera to a trip's bounds when the user picks one from the list. */
function TripFocusCamera({ trip }: { trip: ServerTrip | null }) {
  const map = useMap();

  useEffect(() => {
    if (!map || !trip || trip.path.length === 0) return;
    const bounds = new google.maps.LatLngBounds();
    for (const [lat, lng] of trip.path) bounds.extend({ lat, lng });
    map.fitBounds(bounds, 90);
  }, [map, trip]);

  return null;
}

/** One-time pan onto real vehicle position once data arrives. The map mounts
 * before the fleet loads, so `defaultCenter` is often still the fallback city;
 * this corrects it. It must run whether or not camera-follow is enabled —
 * MapCameraFollow only pans when following, which used to leave the map
 * stranded on the fallback whenever follow was off. */
function MapInitialRecenter({
  target,
  userInteractedRef,
}: {
  target: google.maps.LatLngLiteral | null;
  userInteractedRef: React.RefObject<boolean>;
}) {
  const map = useMap();
  const done = useRef(false);

  useEffect(() => {
    if (!map || !target || done.current || userInteractedRef.current) return;
    done.current = true;
    map.panTo(target);
  }, [map, target, userInteractedRef]);

  return null;
}

function MapInteractionGuard({ onUserInteract }: { onUserInteract: () => void }) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;
    const drag = map.addListener('dragstart', onUserInteract);
    const zoom = map.addListener('zoom_changed', onUserInteract);
    return () => {
      drag.remove();
      zoom.remove();
    };
  }, [map, onUserInteract]);

  return null;
}

export function LiveMonitoringMap({
  tracks,
  trips,
  fleet,
  selectedVehicleId,
  onSelectVehicle,
  followSelected,
  onUserPan,
  trailMinutes,
  onTrailMinutesChange,
  dateRange = null,
  onDateRangeChange,
  onShowRecentInstead,
  initialFocus,
  onFocusConsumed,
}: {
  tracks: VehicleTrack[];
  trips: TripsResponse | null;
  fleet: FleetVehicle[];
  selectedVehicleId: string | null;
  onSelectVehicle: (id: string) => void;
  followSelected: boolean;
  onUserPan?: () => void;
  trailMinutes: number;
  onTrailMinutesChange: (m: number) => void;
  dateRange?: { from: string; to: string } | null;
  onDateRangeChange?: (r: { from: string; to: string } | null) => void;
  onShowRecentInstead?: () => void;
  initialFocus?: { vehicleId: string; startAt: string } | null;
  onFocusConsumed?: () => void;
}) {
  const [animated, setAnimated] = useState<AnimatedTrack[]>([]);
  const [showPoi, setShowPoi] = useState(true);
  const [showTripDetail, setShowTripDetail] = useState(false);
  const [openStop, setOpenStop] = useState<TripStop | null>(null);
  // Hover preview for a parked marker. Deliberately renders only what the trip
  // payload already carries — opening the stop modal fires a billed Places
  // lookup (fetchStopPlace), so hovering must never trigger one.
  const [hoveredStop, setHoveredStop] = useState<{
    stop: TripStop;
    x: number;
    y: number;
  } | null>(null);
  const [rangeOpen, setRangeOpen] = useState(false);
  // Draft values for the date-range popover — only committed on Apply, so a
  // half-typed date never triggers a fetch.
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [focusedTrip, setFocusedTrip] = useState<{ vehicleId: string; index: number } | null>(
    null
  );
  const prevRef = useRef(
    new globalThis.Map<string, { lat: number; lng: number; heading: number }>(),
  );
  const frameRef = useRef<number | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);

    if (tracks.length === 0) {
      setAnimated([]);
      return;
    }

    const start = performance.now();
    const from = new globalThis.Map(prevRef.current);

    const targets = tracks.map((track) => {
      const prev = from.get(track.vehicleId);
      if (!prev) {
        return {
          track,
          prev: { lat: track.current.lat, lng: track.current.lng, heading: track.heading },
          snap: true,
        };
      }
      return { track, prev, snap: false };
    });

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ANIMATION_MS);
      const eased = 1 - Math.pow(1 - t, 3);

      const next: AnimatedTrack[] = targets.map(({ track, prev, snap }) => ({
        ...track,
        displayLat: snap ? track.current.lat : lerp(prev.lat, track.current.lat, eased),
        displayLng: snap ? track.current.lng : lerp(prev.lng, track.current.lng, eased),
        displayHeading: snap ? track.heading : lerp(prev.heading, track.heading, eased),
      }));

      setAnimated(next);

      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        const snapshot = new globalThis.Map<string, { lat: number; lng: number; heading: number }>();
        for (const track of tracks) {
          snapshot.set(track.vehicleId, {
            lat: track.current.lat,
            lng: track.current.lng,
            heading: track.heading,
          });
        }
        prevRef.current = snapshot;
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [tracks]);

  const selectedTrack =
    animated.find((t) => t.vehicleId === selectedVehicleId) ?? animated[0] ?? null;

  const tripsByVehicle = useMemo(
    () =>
      new globalThis.Map((trips?.vehicles ?? []).map((v) => [v.vehicle_id, v])),
    [trips],
  );
  const selectedTrips = selectedTrack
    ? tripsByVehicle.get(selectedTrack.vehicleId)?.trips ?? []
    : [];
  const focusedTripData =
    focusedTrip && focusedTrip.vehicleId === selectedTrack?.vehicleId
      ? selectedTrips[focusedTrip.index] ?? null
      : null;

  // A focused trip belongs to one vehicle+window — reset when either changes
  useEffect(() => {
    setFocusedTrip(null);
  }, [selectedVehicleId, trailMinutes]);

  // "View on map" from Trip history: focus the requested trip once data lands
  useEffect(() => {
    if (!initialFocus || !trips) return;
    const vehicle = trips.vehicles.find((v) => v.vehicle_id === initialFocus.vehicleId);
    if (!vehicle) return;
    const index = vehicle.trips.findIndex((t) => t.start_at === initialFocus.startAt);
    if (index >= 0) setFocusedTrip({ vehicleId: initialFocus.vehicleId, index });
    onFocusConsumed?.();
  }, [initialFocus, trips, onFocusConsumed]);

  const handleFocusTrip = useCallback(
    (vehicleId: string, index: number) => {
      setFocusedTrip((prev) =>
        prev?.vehicleId === vehicleId && prev.index === index
          ? null
          : { vehicleId, index }
      );
      onUserPan?.(); // stop camera-follow so fitBounds isn't fought
    },
    [onUserPan],
  );

  const fleetStatus = useMemo(
    () => new globalThis.Map(fleet.map((v) => [v.id, v.connection_status])),
    [fleet],
  );

  const fleetMeta = useMemo(
    () =>
      new globalThis.Map(
        fleet.map((v) => [
          v.id,
          {
            odometer: v.total_odometer_km ?? v.odometer_km,
            odometerIsTotal: v.total_odometer_km != null,
            driver: v.driver_name,
            fuel: v.fuel_level_liters,
            tankCapacity: v.virtual_tank_capacity_liters != null
              ? Number(v.virtual_tank_capacity_liters)
              : null,
            tankConfidence: v.virtual_tank_confidence ?? null,
            tankCalibratedAt: v.virtual_tank_calibrated_at ?? null,
          },
        ]),
      ),
    [fleet],
  );

  const mapOptions = useMemo(
    () =>
      fleetMapDefaults(
        { defaultCenter: LAGOS_CENTER, defaultZoom: 13 },
        showPoi,
      ),
    [showPoi],
  );

  // Most recent place any vehicle was actually seen — the map's real origin.
  // Ranked by GPS fix time, not telemetry time, so a vehicle still pinging
  // without a satellite lock doesn't outrank a fresher real position.
  // LAGOS_CENTER is only the last-resort fallback when nothing has reported.
  const latestFix = useMemo(() => {
    const fixTime = (v: FleetVehicle) =>
      new Date(v.last_gps_fix_at ?? v.last_telemetry_at ?? 0).getTime();
    const withGps = fleet.filter((v) => v.latitude != null && v.longitude != null);
    if (withGps.length === 0) return null;
    const freshest = withGps.reduce((a, b) => (fixTime(b) > fixTime(a) ? b : a));
    return { lat: Number(freshest.latitude), lng: Number(freshest.longitude) };
  }, [fleet]);

  const userInteractedRef = useRef(false);
  const handleUserInteract = useCallback(() => {
    userInteractedRef.current = true;
    onUserPan?.();
  }, [onUserPan]);
  const handleSelectVehicle = useCallback(
    (id: string) => onSelectVehicle(id),
    [onSelectVehicle],
  );

  if (!FLEET_MAPS_KEY) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-canvas p-8 text-center">
        <p className="text-ink-dim">Add GOOGLE_MAPS_API_KEY to enable live map</p>
      </div>
    );
  }

  const initialCenter =
    !initializedRef.current && selectedTrack
      ? { lat: selectedTrack.displayLat, lng: selectedTrack.displayLng }
      : undefined;

  if (!initializedRef.current && selectedTrack) {
    initializedRef.current = true;
  }

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden rounded-xl border border-edge">
      <div className="absolute inset-0">
        <APIProvider apiKey={FLEET_MAPS_KEY}>
          <Map
            {...mapOptions}
            defaultCenter={initialCenter ?? latestFix ?? LAGOS_CENTER}
            defaultZoom={13}
            style={{ width: '100%', height: '100%' }}
          >
            <MapResizeFix />
            <MapInitialRecenter
              target={
                selectedTrack
                  ? { lat: selectedTrack.displayLat, lng: selectedTrack.displayLng }
                  : latestFix
              }
              userInteractedRef={userInteractedRef}
            />
            <MapInteractionGuard onUserInteract={handleUserInteract} />
            <MapCameraFollow
              track={selectedTrack}
              enabled={followSelected && !!selectedTrack}
            />

            <TripFocusCamera trip={focusedTripData} />

            {/* One polyline per server-segmented trip — trails don't connect
                across 30+ minute stops, so separate journeys read separately. */}
            {animated.flatMap((track) => {
              const vehicleTrips = tripsByVehicle.get(track.vehicleId)?.trips ?? [];
              return vehicleTrips.map((trip, i) => {
                let path = tripPath(trip);
                // in-progress trip follows the live animated position
                if (trip.active && i === vehicleTrips.length - 1 && path.length > 0) {
                  path = [...path, { lat: track.displayLat, lng: track.displayLng }];
                }
                const isFocused =
                  focusedTrip?.vehicleId === track.vehicleId && focusedTrip.index === i;
                const emphasized = focusedTripData
                  ? isFocused
                  : track.vehicleId === selectedVehicleId;
                return (
                  <EmphasizedRoute
                    key={`route-${track.vehicleId}-${i}`}
                    path={path}
                    color={tripColor(i)}
                    emphasized={emphasized}
                  />
                );
              });
            })}

            {/* Numbered, clickable trip-start badges for the selected vehicle */}
            {selectedTrack &&
              selectedTrips.map((trip, i) => (
                <TripBadgeMarker
                  key={`trip-start-${selectedTrack.vehicleId}-${i}`}
                  lat={trip.path[0][0]}
                  lng={trip.path[0][1]}
                  label={String(i + 1)}
                  color={tripColor(i)}
                  focused={
                    focusedTrip?.vehicleId === selectedTrack.vehicleId &&
                    focusedTrip.index === i
                  }
                  title={`Trip ${i + 1} · ${trip.distance_km} km · ${formatDuration(trip.duration_minutes)}`}
                  onClick={() => handleFocusTrip(selectedTrack.vehicleId, i)}
                />
              ))}

            {/* Where the driver actually stopped. Clicking one opens that place
                directly — the address and photo are the point, so they should
                not be buried behind the trip list. */}
            {selectedTrack &&
              selectedTrips.flatMap((trip, ti) =>
                trip.stops
                  .filter((s) => s.kind === 'stop')
                  .map((stop, si) => (
                    <TripBadgeMarker
                      key={`stop-${selectedTrack.vehicleId}-${ti}-${si}`}
                      lat={stop.lat}
                      lng={stop.lng}
                      label="P"
                      color="var(--warn)"
                      focused={
                        hoveredStop?.stop.arrived_at === stop.arrived_at &&
                        hoveredStop?.stop.lat === stop.lat
                      }
                      onClick={() => setOpenStop(stop)}
                      onMouseOver={(point) => setHoveredStop({ stop, ...point })}
                      onMouseOut={() => setHoveredStop(null)}
                    />
                  ))
              )}

            {animated.map((track) => (
              <VehicleCarMarker
                key={`car-${track.vehicleId}`}
                lat={track.displayLat}
                lng={track.displayLng}
                heading={track.displayHeading}
                accent={track.color}
                selected={track.vehicleId === selectedVehicleId}
                title={track.licensePlate}
                onClick={() => handleSelectVehicle(track.vehicleId)}
              />
            ))}
          </Map>
        </APIProvider>
      </div>

      {/* Top header + controls overlay */}
      {/* Above the overlay cards (z-10): the date-range popover drops out of
          this bar, and a sibling at the same depth would paint over it no
          matter what z-index the popover itself carries. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-canvas/90 to-transparent p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-medium text-ink">Live monitoring</p>
            <p className="text-xs text-ink-dim">
              {animated.length} vehicle{animated.length !== 1 ? 's' : ''} · GPS updates every 2s
            </p>
          </div>
          {/* Interactive controls — pointer-events re-enabled */}
          <div className="pointer-events-auto flex items-center gap-2">
            {/* Trail duration selector */}
            <div className="flex overflow-hidden rounded-lg border border-edge bg-panel/90 text-xs backdrop-blur-md">
              {TRAIL_OPTIONS.map(({ label, value }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => onTrailMinutesChange(value)}
                  className={`px-2.5 py-1.5 transition-colors ${
                    // A custom range wins, so no preset may look selected while
                    // one is active — that mismatch is what made the control
                    // read as broken.
                    !dateRange && trailMinutes === value
                      ? 'bg-accent text-white'
                      : 'text-ink-dim hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setDraftFrom(dateRange ? toLocalInput(dateRange.from) : '');
                  setDraftTo(dateRange ? toLocalInput(dateRange.to) : '');
                  setRangeOpen((v) => !v);
                }}
                className={`border-l border-edge px-2.5 py-1.5 transition-colors ${
                  dateRange ? 'bg-accent text-white' : 'text-ink-dim hover:text-ink'
                }`}
                title="Pick an exact date range"
              >
                {dateRange ? formatRangeLabel(dateRange) : 'Custom'}
              </button>
            </div>

            {rangeOpen && (
              <div className="absolute right-0 top-10 z-30 w-72 rounded-xl border border-edge bg-panel/95 p-3 shadow-xl backdrop-blur">
                <p className="mb-2 text-xs font-semibold text-ink">Date range</p>
                <label className="block text-[11px] text-ink-dim">
                  From
                  <input
                    type="datetime-local"
                    value={draftFrom}
                    onChange={(e) => setDraftFrom(e.target.value)}
                    className="mt-1 w-full rounded-md border border-edge bg-canvas px-2 py-1.5 text-xs text-ink"
                  />
                </label>
                <label className="mt-2 block text-[11px] text-ink-dim">
                  To
                  <input
                    type="datetime-local"
                    value={draftTo}
                    onChange={(e) => setDraftTo(e.target.value)}
                    className="mt-1 w-full rounded-md border border-edge bg-canvas px-2 py-1.5 text-xs text-ink"
                  />
                </label>
                {rangeError(draftFrom, draftTo) && (
                  <p className="mt-2 text-[11px] text-error">{rangeError(draftFrom, draftTo)}</p>
                )}
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    disabled={!draftFrom || !draftTo || Boolean(rangeError(draftFrom, draftTo))}
                    onClick={() => {
                      onDateRangeChange?.({
                        from: new Date(draftFrom).toISOString(),
                        to: new Date(draftTo).toISOString(),
                      });
                      setRangeOpen(false);
                    }}
                    className="flex-1 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onDateRangeChange?.(null);
                      setRangeOpen(false);
                    }}
                    className="rounded-md border border-edge px-3 py-1.5 text-xs text-ink-mid hover:text-ink"
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}
            {/* POI toggle */}
            <button
              type="button"
              onClick={() => setShowPoi((v) => !v)}
              className={`rounded-lg border px-2.5 py-1.5 text-xs backdrop-blur-md transition-colors ${
                showPoi
                  ? 'border-good bg-good/10 text-good'
                  : 'border-edge bg-panel/90 text-ink-dim hover:text-ink'
              }`}
              title="Toggle fuel stations and markets"
            >
              POI
            </button>
          </div>
        </div>
      </div>

      {/* Vehicle cards strip */}
      <div className="absolute bottom-4 left-4 right-4 z-10 flex gap-2 overflow-x-auto pb-1">
        {animated.map((track) => {
          const status = fleetStatus.get(track.vehicleId) ?? 'offline';
          const meta = fleetMeta.get(track.vehicleId);
          return (
            <button
              key={track.vehicleId}
              type="button"
              onClick={() => handleSelectVehicle(track.vehicleId)}
              className={`pointer-events-auto shrink-0 rounded-xl border px-3 py-2 text-left backdrop-blur-md transition ${
                track.vehicleId === selectedVehicleId
                  ? 'border-brand bg-panel/95 ring-1 ring-brand/40'
                  : 'border-edge bg-panel/85 hover:bg-panel-hover/90'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: track.color }} />
                <span className="text-sm font-medium text-ink">{track.licensePlate}</span>
                <span className={`text-[10px] capitalize ${status === 'online' ? 'text-good' : 'text-bad'}`}>
                  {status}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-ink-dim">
                {meta?.driver ? `${meta.driver} · ` : ''}
                {track.current.speedKph ?? 0} km/h
                {track.current.fuelLiters != null ? ` · ${track.current.fuelLiters.toFixed(1)} L` : ''}
              </p>
            </button>
          );
        })}
      </div>

      {/* Selected vehicle info panel */}
      {selectedTrack && (
        <div className="pointer-events-none absolute right-4 top-16 z-10 w-64 rounded-xl border border-edge bg-panel/95 p-4 backdrop-blur-md">
          <div className="flex items-center justify-between">
            <p className="font-semibold text-ink">{selectedTrack.licensePlate}</p>
            <span
              className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                selectedTrack.current.ignitionOn
                  ? 'bg-good/10 text-good'
                  : 'bg-edge/40 text-ink-dim'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${selectedTrack.current.ignitionOn ? 'bg-good' : 'bg-ink-dim'}`} />
              {selectedTrack.current.ignitionOn ? 'Ignition on' : 'Ignition off'}
            </span>
          </div>
          <p className="text-xs text-ink-dim">
            {[selectedTrack.make, selectedTrack.model].filter(Boolean).join(' ')}
            {selectedTrack.driverName ? ` · ${selectedTrack.driverName}` : ''}
          </p>
          <p className="mt-1 text-[10px] text-ink-dim">
            Updated {timeAgo(selectedTrack.current.recordedAt)}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs">
            <div className="rounded-lg bg-canvas p-2">
              <p className="text-ink-dim">Speed</p>
              <p className="font-mono text-lg text-ink">{selectedTrack.current.speedKph ?? 0} <span className="text-[10px]">km/h</span></p>
            </div>
            {/* "Fuel" alone read as a trip statistic next to "Last trip". This
                is the modelled level still IN the tank, so it says so — with
                the percentage and the confidence that the GPS-derived tank
                model attaches to it, since it is an estimate, not a sender
                reading. */}
            <div className="rounded-lg bg-canvas p-2">
              <p className="text-ink-dim">Fuel left</p>
              <p className="font-mono text-lg text-good">
                {selectedTrack.current.fuelLiters != null
                  ? `${selectedTrack.current.fuelLiters.toFixed(1)}L`
                  : '—'}
              </p>
              {(() => {
                const meta = fleetMeta.get(selectedTrack.vehicleId);
                const litres = selectedTrack.current.fuelLiters;
                const pct =
                  litres != null && meta?.tankCapacity
                    ? Math.round((litres / meta.tankCapacity) * 100)
                    : null;
                if (pct == null && meta?.tankConfidence == null) return null;
                return (
                  <p className="mt-0.5 text-[10px] leading-tight text-ink-dim">
                    {pct != null && <span>{pct}% of tank</span>}
                    {pct != null && meta?.tankConfidence != null && ' · '}
                    {meta?.tankConfidence != null && (
                      <span
                        title={
                          meta.tankCalibratedAt
                            ? `Estimated from GPS fuel use since calibration on ${new Date(meta.tankCalibratedAt).toLocaleDateString()}`
                            : 'Never calibrated — calibrate after a fill-up for an accurate level'
                        }
                        className={
                          meta.tankConfidence >= 70
                            ? 'text-good'
                            : meta.tankConfidence >= 45
                              ? 'text-warn'
                              : 'text-error'
                        }
                      >
                        {meta.tankConfidence}% confidence
                      </span>
                    )}
                  </p>
                );
              })()}
            </div>
            <div className="rounded-lg bg-canvas p-2">
              <p className="text-ink-dim">
                {fleetMeta.get(selectedTrack.vehicleId)?.odometerIsTotal
                  ? 'Odometer'
                  : 'Odo (since install)'}
              </p>
              <p className="font-mono text-lg text-ink">
                {fleetMeta.get(selectedTrack.vehicleId)?.odometer != null
                  ? formatOdometerMiles(fleetMeta.get(selectedTrack.vehicleId)?.odometer)
                  : '—'}
              </p>
            </div>
            <div className="rounded-lg bg-canvas p-2">
              <p className="text-ink-dim">Last trip</p>
              <p className="font-mono text-lg text-warn">
                {selectedTrips.length > 0
                  ? `${selectedTrips[selectedTrips.length - 1].distance_km} km`
                  : '—'}
              </p>
            </div>
          </div>

          {/* Trips in the visible window */}
          <div className="pointer-events-auto mt-3 border-t border-divider pt-3">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <p className="font-medium text-ink">Trips ({selectedTrips.length})</p>
                {selectedTrips.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowTripDetail(true)}
                    className="font-medium text-brand hover:underline"
                  >
                    View all
                  </button>
                )}
              </div>
              {selectedTrips.length > 0 && (
                <p className="font-mono text-ink-dim">
                  {tripsByVehicle.get(selectedTrack.vehicleId)?.total_distance_km ?? 0} km ·{' '}
                  <span className="text-good">
                    {tripsByVehicle.get(selectedTrack.vehicleId)?.total_fuel_liters ?? 0} L
                  </span>
                </p>
              )}
            </div>
            {trips?.source === 'historical' && (
              <p className="mt-1 text-[10px] text-warn">
                Outside the selected range — showing the most recent journeys instead.
              </p>
            )}
            {selectedTrips.length === 0 ? (
              <div className="mt-1">
                <p className="text-[10px] text-ink-dim">
                  No trips in this window — vehicle stayed parked.
                </p>
                {/* The server no longer widens the window on its own, so
                    reaching past the chosen range is an explicit action. */}
                {trips?.source === 'live' && onShowRecentInstead && (
                  <button
                    type="button"
                    onClick={onShowRecentInstead}
                    className="mt-1 text-[10px] font-semibold text-brand hover:underline"
                  >
                    Show most recent journeys instead →
                  </button>
                )}
              </div>
            ) : (
              <ul className="mt-1.5 max-h-44 space-y-1 overflow-y-auto pr-1">
                {selectedTrips
                  .map((trip, i) => ({ trip, i }))
                  .reverse()
                  .map(({ trip, i }) => {
                    const isFocused =
                      focusedTrip?.vehicleId === selectedTrack.vehicleId &&
                      focusedTrip.index === i;
                    return (
                      <li key={i}>
                        <button
                          type="button"
                          onClick={() => handleFocusTrip(selectedTrack.vehicleId, i)}
                          className={`w-full rounded-lg border px-2 py-1.5 text-left transition-colors ${
                            isFocused
                              ? 'border-brand bg-brand/10'
                              : 'border-transparent hover:bg-panel-hover'
                          }`}
                        >
                          <span className="flex items-center justify-between text-[11px]">
                            <span className="flex items-center gap-1.5 text-ink-mid">
                              <span
                                className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold"
                                style={{
                                  backgroundColor: tripColor(i),
                                  color: '#0b0e13',
                                }}
                              >
                                {i + 1}
                              </span>
                              {formatTripDay(trip.start_at)} · {formatTripTime(trip.start_at)}–
                              {formatTripTime(trip.end_at)}
                              {trip.active && (
                                <span className="flex items-center gap-1 text-good">
                                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-good" />
                                  live
                                </span>
                              )}
                            </span>
                            <span className="font-mono font-semibold text-ink">
                              {trip.distance_km} km ·{' '}
                              <span className="text-good">{trip.estimated_fuel_liters} L</span>
                            </span>
                          </span>
                          <span className="mt-0.5 block pl-[22px] text-[10px] text-ink-dim">
                            {formatDuration(trip.duration_minutes)} · avg {trip.avg_speed_kph}{' '}
                            km/h · top {trip.max_speed_kph} km/h
                            {trip.idle_minutes > 0 ? ` · idle ${trip.idle_minutes}m` : ''}
                          </span>
                        </button>
                      </li>
                    );
                  })}
              </ul>
            )}
            <p className="mt-2 text-[10px] leading-snug text-ink-dim">
              A new trip starts after the ignition has been off for 30+ minutes. Tap a trip to
              zoom to it — numbered dots mark where each trip began.
            </p>
          </div>
        </div>
      )}

      {showTripDetail && selectedTrack && (
        <TripDetailModal
          trips={selectedTrips}
          licensePlate={selectedTrack.licensePlate}
          driverName={fleetMeta.get(selectedTrack.vehicleId)?.driver}
          totals={{
            distance_km: tripsByVehicle.get(selectedTrack.vehicleId)?.total_distance_km ?? 0,
            fuel_liters: tripsByVehicle.get(selectedTrack.vehicleId)?.total_fuel_liters ?? 0,
            cost_ngn: tripsByVehicle.get(selectedTrack.vehicleId)?.total_cost_ngn ?? 0,
          }}
          onClose={() => setShowTripDetail(false)}
          onFocusTrip={(index) =>
            setFocusedTrip({ vehicleId: selectedTrack.vehicleId, index })
          }
        />
      )}

      {hoveredStop && !openStop && (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-[1200] w-52 rounded-lg border border-edge bg-panel/95 px-3 py-2 shadow-xl backdrop-blur"
          style={{
            left: Math.min(hoveredStop.x + 14, Math.max(8, window.innerWidth - 220)),
            top: Math.min(hoveredStop.y + 14, Math.max(8, window.innerHeight - 110)),
          }}
        >
          <p className="text-sm font-semibold text-ink">
            Parked {formatDuration(hoveredStop.stop.duration_minutes)}
          </p>
          <p className="mt-0.5 font-mono text-xs text-ink-mid">
            {clockTime(hoveredStop.stop.arrived_at)} → {clockTime(hoveredStop.stop.departed_at)}
          </p>
          <p className="mt-1.5 text-[11px] text-ink-dim">Click for address and photo</p>
        </div>
      )}

      <StopDetailModal
        key={openStop ? `${openStop.arrived_at}-${openStop.lat}` : 'none'}
        stop={openStop}
        licensePlate={selectedTrack?.licensePlate}
        driverName={
          selectedTrack ? fleetMeta.get(selectedTrack.vehicleId)?.driver : undefined
        }
        onClose={() => setOpenStop(null)}
      />
    </div>
  );
}
