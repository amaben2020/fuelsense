'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps';
import { DateRangePicker } from './DateRangePicker';
import { isReadingLive, lerp, timeAgo, tripColor } from '@/lib/map-utils';
import {
  FleetVehicle,
  Geofence,
  ServerTrip,
  StopPlace,
  TripStop,
  TripsResponse,
  VehicleTrack,
  createGeofence,
  deleteGeofence,
  fetchGeofences,
  fetchStopPlace,
  formatOdometerMiles,
  isInFuelReserve,
  placePhotoSrc,
  usableFuelPercent,
} from '@/lib/api';
import {
  FLEET_MAPS_KEY,
  LAGOS_CENTER,
  ROUTE_ACTIVE,
  ROUTE_PRIMARY,
  fleetMapDefaults,
} from '@/lib/fleet-map-theme';
import {
  EmphasizedRoute,
  MapResizeFix,
  TripBadgeMarker,
  VehicleCarMarker,
} from '@/components/maps/SharedMapLayers';
import { Circle as CircleIcon, Crosshair, Minus, Pentagon, Plus, Square } from 'lucide-react';
import { Compass } from '@/components/maps/Compass';
import { ZONE_PURPOSE_LABEL } from '@/lib/trust-language';
import { LiquidFuelGauge, SpeedGauge } from './Gauges';
import { TripDetailModal } from './TripDetailModal';
import { StopDetailModal } from './StopDetailModal';

const ANIMATION_MS = 1800;

/** How the next zone is being drawn. Rectangles are saved as polygons. */
type ZoneShapeMode = 'circle' | 'rectangle' | 'polygon';
/** [latitude, longitude] — the order the API stores rings in. */
type ZonePoint = [number, number];

// 12h and 18h cover the shapes 6h and 24h miss: a full shift, and a shift plus
// the run home. Without them a manager checking "what happened today" had to
// jump to 24h and pull in yesterday evening alongside it.
const TRAIL_OPTIONS = [
  { label: '1h', value: 60 },
  { label: '6h', value: 360 },
  { label: '12h', value: 720 },
  { label: '18h', value: 1080 },
  { label: '24h', value: 1440 },
  { label: '7d', value: 10080 },
] as const;

// A halt is not one thing. A visit, a moment's pause and sitting in congestion
// all look identical on a trail, so each gets its own mark and colour.
const HALT_LABEL: Record<string, string> = {
  stop: 'P',
  pause: '·',
  traffic: '≈',
};
const HALT_COLOR: Record<string, string> = {
  stop: 'var(--warn)',
  pause: 'var(--ink-dim)',
  traffic: 'var(--traffic)',
};
const HALT_TITLE: Record<string, string> = {
  stop: 'Stopped',
  pause: 'Brief pause',
  traffic: 'Slow traffic',
};

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
function formatRangeLabel({ from, to }: { from: string; to: string }): string {
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  return `${new Date(from).toLocaleDateString([], opts)}–${new Date(to).toLocaleDateString([], opts)}`;
}

/** Null when the draft range is valid — otherwise why Apply is disabled. */
/** Wall-clock HH:MM for a stop's arrive/depart pair. */
function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Dashed link from the last known position to the first plotted fix.
 *
 * Google's Polyline has no dash property; a repeated dot icon along a
 * zero-opacity stroke is the documented way to get one, and it keeps the
 * dashes at a fixed screen size so the line stays legible at every zoom.
 */
function BlindOriginLink({
  from,
  to,
}: {
  from: google.maps.LatLngLiteral;
  to: google.maps.LatLngLiteral;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;
    const line = new google.maps.Polyline({
      map,
      path: [from, to],
      strokeOpacity: 0,
      clickable: false,
      zIndex: 1,
      icons: [
        {
          icon: {
            path: 'M 0,-1 0,1',
            strokeOpacity: 0.75,
            strokeColor: '#8b93a1',
            strokeWeight: 2,
            scale: 3,
          },
          offset: '0',
          repeat: '12px',
        },
      ],
    });
    const marker = new google.maps.Marker({
      map,
      position: from,
      clickable: false,
      zIndex: 2,
      title: 'Last known position before the tracker had a GPS lock',
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 6,
        fillColor: '#8b93a1',
        fillOpacity: 0.9,
        strokeColor: '#0b1220',
        strokeWeight: 2,
      },
      label: {
        text: 'Set off here (no GPS yet)',
        color: '#c8d0dc',
        fontSize: '11px',
        fontWeight: '600',
      },
    });
    return () => {
      line.setMap(null);
      marker.setMap(null);
    };
  }, [map, from, to]);

  return null;
}

/** Rectangles are stored as polygons; these are the four corners of one. */
function rectangleRing(a: ZonePoint, b: ZonePoint): ZonePoint[] {
  const [lat1, lng1] = a;
  const [lat2, lng2] = b;
  return [
    [lat1, lng1],
    [lat1, lng2],
    [lat2, lng2],
    [lat2, lng1],
  ];
}

/** The ring a draft would be saved as, or null while it is still too short. */
function draftRing(mode: ZoneShapeMode, points: ZonePoint[]): ZonePoint[] | null {
  if (mode === 'rectangle') {
    return points.length === 2 ? rectangleRing(points[0], points[1]) : null;
  }
  if (mode === 'polygon') return points.length >= 3 ? points : null;
  return null;
}

const toLatLng = (p: ZonePoint) => ({ lat: p[0], lng: p[1] });

/**
 * Draws saved zones and the in-progress draft onto the map.
 *
 * google.maps geometry rather than an SVG overlay: a shape in screen pixels
 * would keep its size as the user zooms, which is exactly wrong — a 400 m
 * depot has to stay 400 m of ground however far out you are.
 *
 * Saved polygons used to be invisible here because only circles were drawn,
 * even though the live monitor has always alerted on them — a zone that fires
 * alerts but cannot be seen is worse than one that does not exist.
 */
function GeofenceShapes({
  zones,
  draftMode,
  draftPoints,
  draftRadius,
  onHoverZone,
}: {
  zones: Geofence[];
  draftMode: ZoneShapeMode;
  draftPoints: ZonePoint[];
  draftRadius: number;
  /** Raised with the zone under the cursor, or null when it leaves. */
  onHoverZone?: (hit: { zone: Geofence; x: number; y: number } | null) => void;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;
    const drawn: Array<{ setMap: (m: google.maps.Map | null) => void }> = [];
    const listeners: google.maps.MapsEventListener[] = [];

    const circle = (
      center: google.maps.LatLngLiteral,
      radius: number,
      pending: boolean
    ) =>
      new google.maps.Circle({
        map,
        center,
        radius,
        strokeColor: pending ? ROUTE_ACTIVE : ROUTE_PRIMARY,
        // A saved zone is context, not content. At 0.9/0.1 the fill washed the
        // basemap out — roads, markets and POI labels inside a depot were
        // harder to read than outside it, which punishes the manager for the
        // zone existing. Barely-there fill and a thin stroke keep the boundary
        // legible while leaving the map underneath fully readable.
        strokeOpacity: pending ? 1 : 0.5,
        strokeWeight: pending ? 2 : 1.5,
        // Dashed would be ideal; the API has no dash option for circles, so
        // the unsaved zone is distinguished by a brighter stroke and fill.
        fillColor: pending ? ROUTE_ACTIVE : ROUTE_PRIMARY,
        fillOpacity: pending ? 0.2 : 0.04,
        // Never clickable, saved or draft. A filled polygon that takes the
        // cursor swallows every click inside it — vehicle markers, POIs, the
        // map itself — so a large depot would make its own contents
        // unreachable. The zone's controls hang off a small labelled chip at
        // its centre instead (see zoneChip below).
        clickable: false,
      });

    const polygon = (ring: ZonePoint[], pending: boolean) =>
      new google.maps.Polygon({
        map,
        paths: ring.map(toLatLng),
        strokeColor: pending ? ROUTE_ACTIVE : ROUTE_PRIMARY,
        strokeOpacity: pending ? 1 : 0.5,
        strokeWeight: pending ? 2 : 1.5,
        fillColor: pending ? ROUTE_ACTIVE : ROUTE_PRIMARY,
        fillOpacity: pending ? 0.2 : 0.04,
        clickable: false,
      });

    // A small labelled chip at the zone's centre, and the only part of a zone
    // that takes the cursor.
    //
    // Hovering the whole polygon was tried first and is worse twice over: the
    // shape then intercepts clicks meant for what is inside it, and it puts a
    // one-pixel-away delete button under a target the size of a district.
    // A named chip is a deliberate target for a destructive action and leaves
    // the map beneath it completely free.
    const zoneChip = (position: google.maps.LatLngLiteral, zone: Geofence) => {
      const marker = new google.maps.Marker({
        map,
        position,
        clickable: true,
        cursor: 'pointer',
        zIndex: 3,
        label: {
          text: zone.name,
          color: '#0b0e13',
          fontSize: '11px',
          fontWeight: '600',
        },
        icon: {
          path: 'M -46 -11 H 46 A 11 11 0 0 1 46 11 H -46 A 11 11 0 0 1 -46 -11 Z',
          fillColor: ROUTE_PRIMARY,
          fillOpacity: 0.92,
          strokeColor: '#0b0e13',
          strokeWeight: 1,
          scale: 1,
          labelOrigin: new google.maps.Point(0, 0),
        },
      });

      if (onHoverZone) {
        listeners.push(
          marker.addListener('mouseover', (e: google.maps.MapMouseEvent) => {
            const dom = e.domEvent as MouseEvent | undefined;
            const rect = map.getDiv().getBoundingClientRect();
            if (!dom) return;
            onHoverZone({ zone, x: dom.clientX - rect.left, y: dom.clientY - rect.top });
          })
        );
        // Click as well as hover: touch has no hover, and on a phone the chip
        // would otherwise be inert.
        listeners.push(
          marker.addListener('click', (e: google.maps.MapMouseEvent) => {
            const dom = e.domEvent as MouseEvent | undefined;
            const rect = map.getDiv().getBoundingClientRect();
            if (!dom) return;
            onHoverZone({ zone, x: dom.clientX - rect.left, y: dom.clientY - rect.top });
          })
        );
      }
      return marker;
    };

    /** Average of the ring's vertices — good enough to sit a label on. */
    const ringCentre = (ring: ZonePoint[]): google.maps.LatLngLiteral => {
      const sum = ring.reduce((a, [lat, lng]) => ({ lat: a.lat + lat, lng: a.lng + lng }), {
        lat: 0,
        lng: 0,
      });
      return { lat: sum.lat / ring.length, lng: sum.lng / ring.length };
    };

    for (const z of zones) {
      if (z.shape === 'polygon') {
        const ring = z.polygon;
        if (Array.isArray(ring) && ring.length >= 3) {
          drawn.push(polygon(ring, false));
          drawn.push(zoneChip(ringCentre(ring as ZonePoint[]), z));
        }
        continue;
      }
      if (z.center_lat == null || z.center_lng == null || !z.radius_m) continue;
      const centre = { lat: Number(z.center_lat), lng: Number(z.center_lng) };
      drawn.push(circle(centre, z.radius_m, false));
      drawn.push(zoneChip(centre, z));
    }

    // The draft. Circles need a single centre; the other two are rings once
    // they have enough points, and before that they show as the vertices the
    // user has actually clicked so a half-drawn zone still reads as progress.
    if (draftMode === 'circle' && draftPoints.length === 1) {
      drawn.push(circle(toLatLng(draftPoints[0]), draftRadius, true));
    } else {
      const ring = draftRing(draftMode, draftPoints);
      if (ring) {
        drawn.push(polygon(ring, true));
      } else if (draftPoints.length > 0) {
        if (draftPoints.length > 1) {
          drawn.push(
            new google.maps.Polyline({
              map,
              path: draftPoints.map(toLatLng),
              strokeColor: ROUTE_ACTIVE,
              strokeOpacity: 1,
              strokeWeight: 2,
              clickable: false,
            })
          );
        }
        for (const p of draftPoints) {
          drawn.push(
            new google.maps.Marker({
              map,
              position: toLatLng(p),
              clickable: false,
              icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 5,
                fillColor: ROUTE_ACTIVE,
                fillOpacity: 1,
                strokeColor: '#000',
                strokeWeight: 1.5,
              },
            })
          );
        }
      }
    }

    return () => {
      listeners.forEach((l) => l.remove());
      drawn.forEach((s) => s.setMap(null));
    };
  }, [map, zones, draftMode, draftPoints, draftRadius, onHoverZone]);

  return null;
}

/**
 * Compass rose. Reads the live camera heading, so it stays honest when the map
 * is rotated rather than being a decorative north arrow.
 */
function CompassRose() {
  const map = useMap();
  const [heading, setHeading] = useState(0);

  useEffect(() => {
    if (!map) return;
    const sync = () => setHeading(map.getHeading?.() ?? 0);
    sync();
    const listener = map.addListener('heading_changed', sync);
    return () => listener.remove();
  }, [map]);

  // The instrument itself lives in components/maps/Compass so the driver-view
  // and any future map can mount the same one rather than growing a second
  // copy that drifts out of step with this one.
  // 84px rather than the default 56. At 56 the cardinal letters and the tick
  // ring were below the size where the instrument reads as an instrument —
  // the detail that sells it was there but too small to resolve.
  return <Compass heading={heading} onReset={() => map?.setHeading?.(0)} size={84} />;
}

/** Circular map control, matching the rail's button language. */
function MapControl({
  icon: Icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-full border border-edge bg-panel/90 text-ink-mid shadow-lg backdrop-blur transition-colors hover:bg-panel hover:text-ink disabled:opacity-40"
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

/** Zoom pair, driving the camera directly rather than Google's stock buttons. */
function ZoomControls() {
  const map = useMap();
  const step = (delta: number) => {
    if (!map) return;
    map.setZoom((map.getZoom() ?? 13) + delta);
  };
  return (
    <>
      <MapControl icon={Plus} label="Zoom in" onClick={() => step(1)} />
      <MapControl icon={Minus} label="Zoom out" onClick={() => step(-1)} />
    </>
  );
}

/**
 * Refits the camera onto every plotted vehicle. Lives inside <Map> because
 * `useMap` only resolves within the provider; the button itself is portalled
 * out to the control stack via an absolutely positioned wrapper.
 */
function RecenterControl({
  tracks,
  onRecenter,
}: {
  tracks: AnimatedTrack[];
  onRecenter?: () => void;
}) {
  const map = useMap();

  const recenter = () => {
    if (!map) return;
    const points = tracks.filter((t) => t.displayLat != null && t.displayLng != null);
    if (points.length === 0) return;
    const bounds = new google.maps.LatLngBounds();
    for (const t of points) bounds.extend({ lat: t.displayLat, lng: t.displayLng });
    // A single vehicle has zero-area bounds, which fitBounds resolves to the
    // maximum zoom — pan and pick a sane level instead.
    if (points.length === 1) {
      map.panTo({ lat: points[0].displayLat, lng: points[0].displayLng });
      map.setZoom(15);
    } else {
      map.fitBounds(bounds, 90);
    }
    onRecenter?.();
  };

  return (
    <button
      type="button"
      onClick={recenter}
      disabled={tracks.length === 0}
      title="Recenter on fleet"
      aria-label="Recenter on fleet"
      className="pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-full border border-edge bg-panel/95 text-ink-mid shadow-lg backdrop-blur transition-colors hover:text-ink disabled:opacity-40"
    >
      <Crosshair className="h-4 w-4" />
    </button>
  );
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
  startDrawing = false,
  onDrawingStarted,
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
  /** Arrive from the Geofencing page with the zone tool already armed. */
  startDrawing?: boolean;
  onDrawingStarted?: () => void;
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

  // Whether the selected vehicle's last packet is recent enough to describe it
  // now, rather than to describe the moment its tracker went quiet.
  const selectedTrackLive = isReadingLive(selectedTrack?.current.recordedAt);

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
            // A real sensor reading wins when there is one; otherwise the
            // live virtual-tank level — same fallback VirtualFuelGauge uses.
            // Neither is `selectedTrack.current.fuelLiters`: that number is
            // frozen into whichever telemetry row it came from, so a receipt
            // credited to the tank after the tracker's last ping never
            // reaches it and this tile goes stale while the vehicle-view tab
            // (reading straight from `fleet`) shows the correct level.
            fuel:
              v.fuel_level_liters != null
                ? Number(v.fuel_level_liters)
                : v.virtual_tank_liters != null
                  ? Number(v.virtual_tank_liters)
                  : null,
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

  // Zone drawing. Kept local to the map because a half-drawn zone is not
  // application state — leaving the view should discard it, not persist it.
  const [zones, setZones] = useState<Geofence[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [shapeMode, setShapeMode] = useState<ZoneShapeMode>('circle');
  // The clicks placed so far. One point for a circle, two opposite corners for
  // a rectangle, three or more vertices for a polygon.
  const [draftPoints, setDraftPoints] = useState<ZonePoint[]>([]);
  const [draftRadius, setDraftRadius] = useState(400);
  // A polygon has no natural end — unlike the other two shapes there is no
  // click count that means "finished", so the user says when.
  const [polygonClosed, setPolygonClosed] = useState(false);
  // The zone under the cursor, in container pixel space, plus whichever zone
  // is mid-delete so the button can show progress and stay disabled.
  const [hoveredZone, setHoveredZone] = useState<
    { zone: Geofence; x: number; y: number } | null
  >(null);
  const [removingZoneId, setRemovingZoneId] = useState<string | null>(null);
  const [zoneName, setZoneName] = useState('');
  // '' = whole fleet. A depot is not per-vehicle, but a customer site
  // assigned to one driver is, and only the vehicle scope can express that.
  const [zoneVehicleId, setZoneVehicleId] = useState('');
  const [zonePurpose, setZonePurpose] = useState('depot');
  const [zoneNotifyOn, setZoneNotifyOn] = useState('both');
  const [savingZone, setSavingZone] = useState(false);
  const [zoneError, setZoneError] = useState<string | null>(null);

  // "Draw a zone" on the Geofencing page only switched view, so the map opened
  // with nothing armed and the click did nothing visible.
  useEffect(() => {
    if (!startDrawing) return;
    setDrawing(true);
    onDrawingStarted?.();
  }, [startDrawing, onDrawingStarted]);

  // Stable identity: GeofenceShapes lists this in its effect deps, and a fresh
  // closure each render would tear down and rebuild every shape on the map on
  // every frame of the vehicle animation.
  const handleHoverZone = useCallback(
    (hit: { zone: Geofence; x: number; y: number } | null) => {
      // Hovering is suppressed while drawing: the draft needs the pointer, and
      // a tooltip offering to delete a zone mid-placement is a misclick away
      // from destroying the wrong thing.
      setHoveredZone((prev) => {
        if (hit == null && prev == null) return prev;
        return hit;
      });
    },
    []
  );

  const loadZones = useCallback(() => {
    fetchGeofences()
      .then(setZones)
      .catch(() => setZones([]));
  }, []);

  useEffect(() => {
    loadZones();
  }, [loadZones]);

  // Depends on `loadZones` directly. That is safe precisely because
  // `loadZones` is a useCallback with no dependencies, so its identity is
  // stable for the life of the component and this handler does not churn.
  const removeHoveredZone = useCallback(
    async (id: string) => {
      setRemovingZoneId(id);
      try {
        await deleteGeofence(id);
        setHoveredZone(null);
        loadZones();
      } catch (err) {
        setZoneError((err as Error).message);
      } finally {
        setRemovingZoneId(null);
      }
    },
    [loadZones]
  );

  const resetDraft = useCallback(() => {
    setDraftPoints([]);
    setPolygonClosed(false);
    setZoneName('');
    setZoneError(null);
  }, []);

  // A draft is only nameable once it describes a real area. Until then the
  // form stays out of the way and the map keeps taking clicks.
  const draftComplete =
    shapeMode === 'circle'
      ? draftPoints.length === 1
      : shapeMode === 'rectangle'
        ? draftPoints.length === 2
        : polygonClosed && draftPoints.length >= 3;

  const saveZone = async () => {
    if (!draftComplete || !zoneName.trim()) return;
    setSavingZone(true);
    setZoneError(null);
    try {
      const shared = {
        name: zoneName.trim(),
        purpose: zonePurpose,
        notify_on: zoneNotifyOn,
        vehicle_id: zoneVehicleId || null,
      };
      if (shapeMode === 'circle') {
        await createGeofence({
          ...shared,
          shape: 'circle',
          center_lat: draftPoints[0][0],
          center_lng: draftPoints[0][1],
          radius_m: Math.round(draftRadius),
        });
      } else {
        const ring = draftRing(shapeMode, draftPoints);
        if (!ring) throw new Error('That shape needs at least three points');
        await createGeofence({ ...shared, shape: 'polygon', polygon: ring });
      }
      resetDraft();
      setZoneVehicleId('');
      setDrawing(false);
      loadZones();
    } catch (err) {
      setZoneError((err as Error).message);
    } finally {
      setSavingZone(false);
    }
  };

  const mapOptions = useMemo(
    () =>
      fleetMapDefaults(
        {
          defaultCenter: LAGOS_CENTER,
          defaultZoom: 13,
          // Google's stock controls are replaced by the custom stack below, so
          // the map carries one control language instead of two.
          disableDefaultUI: true,
          zoomControl: false,
          fullscreenControl: false,
          streetViewControl: false,
          mapTypeControl: false,
        },
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
            onClick={(e) => {
              if (!drawing || !e.detail.latLng) return;
              const point: ZonePoint = [e.detail.latLng.lat, e.detail.latLng.lng];
              setZoneError(null);
              if (shapeMode === 'circle') {
                // A second click moves the centre rather than starting over.
                setDraftPoints([point]);
                return;
              }
              if (shapeMode === 'rectangle') {
                // Two opposite corners. Once both are down, the next click
                // starts a fresh rectangle instead of silently doing nothing.
                setDraftPoints((prev) => (prev.length >= 2 ? [point] : [...prev, point]));
                return;
              }
              if (polygonClosed) return;
              setDraftPoints((prev) => [...prev, point]);
            }}
          >
            <MapResizeFix />
            <GeofenceShapes
              zones={zones}
              draftMode={shapeMode}
              draftPoints={draftPoints}
              draftRadius={draftRadius}
              onHoverZone={handleHoverZone}
            />
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
                  <Fragment key={`route-${track.vehicleId}-${i}`}>
                    {/* The run-up the tracker drove blind, dashed.
                        
                        A cold-started FMC150 reports ignition-on with no
                        position for the first minutes of a journey, so the
                        solid trail — and the trip-start badge on it — begin
                        wherever the first fix landed, often kilometres from
                        where the driver actually set off. This joins the last
                        position the tracker did know to the first one it
                        plotted. Dashed and unemphasised on purpose: the two
                        ends are evidence, the line between them is not a
                        route, and drawing it solid would assert a path nobody
                        recorded. */}
                    {trip.blind_origin && path.length > 0 && (
                      <BlindOriginLink
                        from={{
                          lat: trip.blind_origin.latitude,
                          lng: trip.blind_origin.longitude,
                        }}
                        to={path[0]}
                      />
                    )}
                    <EmphasizedRoute
                      path={path}
                      color={tripColor(i)}
                      emphasized={emphasized}
                      flowing={!!trip.active}
                    />
                  </Fragment>
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
                  .filter(
                    (s) => s.kind === 'stop' || s.kind === 'pause' || s.kind === 'traffic'
                  )
                  .map((stop, si) => (
                    <TripBadgeMarker
                      key={`stop-${selectedTrack.vehicleId}-${ti}-${si}`}
                      lat={stop.lat}
                      lng={stop.lng}
                      // Three different things happened here and they read
                      // differently: a visit, a moment's halt, and congestion.
                      label={HALT_LABEL[stop.kind] ?? 'P'}
                      color={HALT_COLOR[stop.kind] ?? 'var(--warn)'}
                      title={`${HALT_TITLE[stop.kind] ?? 'Stopped'} · ${stop.duration_minutes}m`}
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
            {/* Instrument cluster on the right edge, camera controls and
                compass in one column.
                
                The compass used to sit at `right-4 top-4`, directly underneath
                the trail-duration bar — so on every screen wide enough to show
                that bar the instrument was completely hidden behind it, which
                is why it read as missing rather than as a control nobody used.
                Grouped with the other map instruments it is always clear of
                the overlays, and the cluster reads as one control surface. */}
            {/* Compass on the left. The right edge carries the trail bar above
                and the vehicle detail card below, and at laptop widths those
                two meet — burying anything in that column. The left edge is
                clear between the header chip and the stops legend at every
                width the dashboard supports. */}
            <div className="pointer-events-none absolute left-4 top-24 z-20">
              <CompassRose />
            </div>
            <div className="pointer-events-none absolute bottom-24 right-4 z-20 flex flex-col items-center gap-2">
              <ZoomControls />
              <RecenterControl tracks={animated} onRecenter={onUserPan} />
              <MapControl
                icon={Pentagon}
                label={drawing ? 'Cancel zone' : 'Draw a zone'}
                onClick={() => {
                  setDrawing((d) => !d);
                  resetDraft();
                }}
              />
            </div>
            {/* Legend. The stop dots are the only thing on the map encoding
                meaning purely in colour, so the key has to be on screen —
                otherwise an amber dot is just an amber dot. */}
            <div className="pointer-events-none absolute bottom-4 left-4 z-10 rounded-xl border border-edge bg-panel/95 px-4 py-3.5 shadow-lg backdrop-blur">
              <p className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-ink-dim">
                Stops
              </p>
              <ul className="space-y-2">
                {[
                  // Wording mirrors the thresholds in
                  // backend/src/lib/trip-segmentation.ts. If those constants
                  // move, these move with them.
                  { c: 'bg-brand', t: 'Trip start', d: 'Where the drive began' },
                  { c: 'bg-traffic', t: 'Slow traffic', d: 'Under 15 km/h for 5 min+' },
                  { c: 'bg-warn', t: 'Stopped', d: 'Parked 5 min or more' },
                  { c: 'bg-ink-dim', t: 'Brief pause', d: '1.5 to 5 minutes' },
                  { c: 'bg-bad', t: 'Trip end', d: 'Where the drive ended' },
                ].map(({ c, t, d }) => (
                  <li key={t} className="flex items-start gap-2.5">
                    {/* Nudged down so the dot aligns with the label's first
                        line rather than the block's centre now that each row
                        carries a second line. */}
                    <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${c}`} />
                    <span className="leading-tight">
                      <span className="block text-sm font-medium text-ink">{t}</span>
                      {/* The colour alone never said what separates a pause
                          from a stop, so the key now carries the rule it is
                          keying rather than only the name. */}
                      <span className="block text-[11px] text-ink-dim">{d}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {/* Zone tooltip. Follows the cursor inside the zone and offers the
                one action a manager wants from the map itself — getting rid of
                a zone that is in the way. Hidden entirely while drawing, so a
                delete button never sits under the next placement click.
                
                Positioned in container pixels from the DOM event rather than
                projected from a LatLng: it must track the pointer, not a fixed
                point on the ground, and it stays clear of the container edges
                so it is never clipped. */}
            {hoveredZone && !drawing && (
              <div
                className="pointer-events-auto absolute z-30 w-56 rounded-xl border border-edge bg-canvas/95 p-3 shadow-2xl backdrop-blur-md"
                style={{
                  left: Math.min(Math.max(hoveredZone.x + 14, 8), 9999),
                  top: Math.max(hoveredZone.y - 10, 8),
                }}
                onMouseLeave={() => setHoveredZone(null)}
              >
                <p className="text-sm font-semibold text-ink">{hoveredZone.zone.name}</p>
                <p className="mt-0.5 text-[11px] text-ink-dim">
                  <span>
                    {ZONE_PURPOSE_LABEL[hoveredZone.zone.purpose] ?? hoveredZone.zone.purpose}
                  </span>{' '}
                  ·{' '}
                  {hoveredZone.zone.shape === 'polygon'
                    ? `${Array.isArray(hoveredZone.zone.polygon) ? hoveredZone.zone.polygon.length : 0} corners`
                    : hoveredZone.zone.radius_m
                      ? `${hoveredZone.zone.radius_m} m radius`
                      : 'circle'}
                </p>
                <p className="mt-0.5 text-[11px] text-ink-dim">
                  Alerts on{' '}
                  {hoveredZone.zone.notify_on === 'both'
                    ? 'entry & exit'
                    : hoveredZone.zone.notify_on === 'enter'
                      ? 'entry'
                      : 'exit'}
                </p>
                <button
                  type="button"
                  onClick={() => removeHoveredZone(hoveredZone.zone.id)}
                  disabled={removingZoneId === hoveredZone.zone.id}
                  className="mt-2.5 w-full rounded-lg border border-edge px-2.5 py-1.5 text-[11px] font-medium text-ink-mid transition-colors hover:border-bad/50 hover:text-bad disabled:opacity-50"
                >
                  {removingZoneId === hoveredZone.zone.id ? 'Removing…' : 'Remove zone'}
                </button>
              </div>
            )}

            {/* Shape picker plus the instruction for the chosen shape. The
                flow used to offer only a circle and said so in a fixed line of
                text; each shape now explains its own gesture, because "click
                the map" means something different for each of the three. */}
            {drawing && !draftComplete && (
              <div className="absolute left-1/2 top-4 z-30 -translate-x-1/2 rounded-2xl border border-edge bg-panel/95 px-3 py-2.5 shadow-xl backdrop-blur">
                <div className="flex items-center gap-1">
                  {(
                    [
                      { mode: 'circle', icon: CircleIcon, label: 'Circle' },
                      { mode: 'rectangle', icon: Square, label: 'Rectangle' },
                      { mode: 'polygon', icon: Pentagon, label: 'Polygon' },
                    ] as const
                  ).map(({ mode, icon: Icon, label }) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        setShapeMode(mode);
                        resetDraft();
                      }}
                      aria-pressed={shapeMode === mode}
                      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                        shapeMode === mode
                          ? 'bg-accent-y text-accent-y-ink'
                          : 'text-ink-mid hover:bg-panel-hover'
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-center text-[11px] text-ink-dim">
                  {shapeMode === 'circle'
                    ? 'Click the map to place the centre'
                    : shapeMode === 'rectangle'
                      ? draftPoints.length === 0
                        ? 'Click one corner, then the opposite corner'
                        : 'Now click the opposite corner'
                      : draftPoints.length < 3
                        ? `Click each corner — ${3 - draftPoints.length} more needed`
                        : 'Keep clicking, or finish the shape'}
                </p>
                {shapeMode === 'polygon' && draftPoints.length > 0 && (
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => setPolygonClosed(true)}
                      disabled={draftPoints.length < 3}
                      className="flex-1 rounded-lg bg-accent-y px-3 py-1.5 text-[11px] font-semibold text-accent-y-ink transition-opacity hover:opacity-90 disabled:opacity-40"
                    >
                      Finish shape
                    </button>
                    <button
                      type="button"
                      onClick={() => setDraftPoints((p) => p.slice(0, -1))}
                      className="rounded-lg border border-edge px-3 py-1.5 text-[11px] font-medium text-ink-mid hover:bg-panel-hover"
                    >
                      Undo point
                    </button>
                  </div>
                )}
              </div>
            )}

            {draftComplete && (
              <div className="absolute left-1/2 top-4 z-30 w-[19rem] -translate-x-1/2 rounded-2xl border border-edge bg-panel/95 p-4 shadow-2xl backdrop-blur">
                <p className="text-sm font-bold text-ink">
                  New {shapeMode} zone
                </p>
                <p className="mt-0.5 text-[11px] text-ink-dim">
                  {shapeMode === 'circle'
                    ? `${draftPoints[0][0].toFixed(5)}, ${draftPoints[0][1].toFixed(5)} — click again to move it`
                    : `${draftRing(shapeMode, draftPoints)?.length ?? 0} corners`}
                </p>
                <input
                  autoFocus
                  value={zoneName}
                  onChange={(e) => setZoneName(e.target.value)}
                  placeholder="Zone name (e.g. Ado depot)"
                  className="mt-3 w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-accent-y focus:outline-none"
                />
                {shapeMode === 'circle' && (
                  <label className="mt-3 block">
                    <span className="flex items-center justify-between text-[11px] text-ink-dim">
                      Radius
                      <span className="font-semibold tabular-nums text-ink">
                        {Math.round(draftRadius)} m
                      </span>
                    </span>
                    <input
                      type="range"
                      min={50}
                      max={5000}
                      step={50}
                      value={draftRadius}
                      onChange={(e) => setDraftRadius(Number(e.target.value))}
                      className="mt-1.5 w-full accent-[var(--accent-y)]"
                    />
                  </label>
                )}
                <label className="mt-3 block">
                  <span className="text-[11px] text-ink-dim">Applies to</span>
                  <select
                    value={zoneVehicleId}
                    onChange={(e) => setZoneVehicleId(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-ink focus:border-accent-y focus:outline-none"
                  >
                    <option value="">All vehicles</option>
                    {fleet.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.license_plate}
                        {v.driver_name ? ` — ${v.driver_name}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-[11px] text-ink-dim">Purpose</span>
                    <select
                      value={zonePurpose}
                      onChange={(e) => setZonePurpose(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-edge bg-canvas px-2 py-2 text-xs text-ink focus:border-accent-y focus:outline-none"
                    >
                      <option value="depot">Depot</option>
                      <option value="customer">Customer site</option>
                      <option value="restricted">Restricted</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-ink-dim">Alert on</span>
                    <select
                      value={zoneNotifyOn}
                      onChange={(e) => setZoneNotifyOn(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-edge bg-canvas px-2 py-2 text-xs text-ink focus:border-accent-y focus:outline-none"
                    >
                      <option value="both">Enter &amp; leave</option>
                      <option value="exit">Leaving only</option>
                      <option value="enter">Entering only</option>
                    </select>
                  </label>
                </div>
                {zoneError && <p className="mt-2 text-xs text-bad">{zoneError}</p>}
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={saveZone}
                    disabled={savingZone || zoneName.trim() === ''}
                    className="flex-1 rounded-lg bg-accent-y px-3 py-2 text-xs font-semibold text-accent-y-ink transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    {savingZone ? 'Saving…' : 'Save zone'}
                  </button>
                  <button
                    type="button"
                    onClick={resetDraft}
                    className="rounded-lg border border-edge px-3 py-2 text-xs font-medium text-ink-mid hover:bg-panel-hover"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <p className="pointer-events-none absolute bottom-4 right-4 z-10 text-[10px] text-ink-dim/70">
              {drawing ? 'Zone mode — click to place' : 'Drag to pan · scroll to zoom'}
            </p>
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
              {fleet.length} vehicle{fleet.length !== 1 ? 's' : ''} · {animated.length} reporting
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
                      ? 'bg-accent text-accent-y-ink'
                      : 'text-ink-dim hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setRangeOpen((v) => !v);
                }}
                className={`border-l border-edge px-2.5 py-1.5 transition-colors ${
                  dateRange ? 'bg-accent text-accent-y-ink' : 'text-ink-dim hover:text-ink'
                }`}
                title="Pick an exact date range"
              >
                {dateRange ? formatRangeLabel(dateRange) : 'Custom'}
              </button>
            </div>

            {rangeOpen && (
              <div className="absolute right-0 top-10 z-30">
                <DateRangePicker
                  value={dateRange ?? null}
                  onApply={(range) => {
                    onDateRangeChange?.(range);
                    setRangeOpen(false);
                  }}
                  onClear={() => {
                    onDateRangeChange?.(null);
                    setRangeOpen(false);
                  }}
                />
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
      {/* Centred, not bottom-left: the row used to sit on top of the stops
          legend. Hovering a chip opens the full card, so the collapsed state
          can stay small enough not to cover the map. */}
      <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 flex max-w-[min(46rem,calc(100%-8rem))] -translate-x-1/2 gap-2 overflow-x-auto pb-1">
        {/* Vehicles the tracks endpoint knows nothing about — no telemetry has
            ever arrived for them. They still exist, have a driver and a device,
            so hiding them entirely made a registered vehicle look like it was
            not there at all. No position means no map marker, but the chip
            belongs here. */}
        {fleet
          .filter((v) => !animated.some((t) => t.vehicleId === v.id))
          .map((v) => (
            <div key={`no-telemetry-${v.id}`} className="group relative shrink-0">
              <button
                type="button"
                onClick={() => handleSelectVehicle(v.id)}
                className={`pointer-events-auto flex items-center gap-2 rounded-full border px-3.5 py-2 text-left backdrop-blur-md transition ${
                  v.id === selectedVehicleId
                    ? 'border-brand bg-panel/95 ring-1 ring-brand/40'
                    : 'border-edge bg-panel/85 hover:bg-panel-hover/90'
                }`}
                title="No telemetry received yet — the tracker has not reported a position"
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-ink-dim" />
                <span className="font-mono text-sm font-medium text-ink">
                  {v.license_plate}
                </span>
                <span className="text-xs text-bad">Offline</span>
                <span className="text-xs text-ink-dim">· awaiting first fix</span>
              </button>
            </div>
          ))}

        {animated.map((track) => {
          const status = fleetStatus.get(track.vehicleId) ?? 'offline';
          const meta = fleetMeta.get(track.vehicleId);
          return (
            <div key={track.vehicleId} className="group relative shrink-0">
              {/* Detail card. CSS hover rather than React state: it must not
                  re-render the animated tracks 60 times a second. */}
              <div className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 w-64 -translate-x-1/2 scale-95 rounded-2xl border border-edge bg-panel/95 p-3.5 opacity-0 shadow-2xl backdrop-blur-md transition-all duration-150 group-hover:scale-100 group-hover:opacity-100">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-mono text-sm font-bold text-ink">{track.licensePlate}</p>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${
                      status === 'online' ? 'bg-good/15 text-good' : 'bg-bad/15 text-bad'
                    }`}
                  >
                    {status}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-ink-dim">
                  {meta?.driver || 'Unassigned driver'}
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {[
                    { label: 'Speed', value: `${Math.round(track.current.speedKph ?? 0)} km/h` },
                    {
                      label: 'Fuel',
                      value:
                        track.current.fuelLiters != null
                          ? `${track.current.fuelLiters.toFixed(1)} L`
                          : '—',
                    },
                    // Vehicle-battery voltage is not on the fleet endpoint yet —
                    // it lives in device_frames io_raw and only /vehicle-signals
                    // decodes it. Odometer until that is exposed here.
                    {
                      label: 'Odometer',
                      value:
                        meta?.odometer != null
                          ? formatOdometerMiles(Number(meta.odometer))
                          : '—',
                    },
                    {
                      label: 'Ignition',
                      value: track.current.ignitionOn == null
                        ? '—'
                        : track.current.ignitionOn
                          ? 'On'
                          : 'Off',
                    },
                  ].map((stat) => (
                    <div key={stat.label} className="rounded-lg bg-panel-deep px-2.5 py-1.5">
                      <p className="text-[10px] uppercase tracking-wider text-ink-dim">
                        {stat.label}
                      </p>
                      <p className="text-sm font-semibold tabular-nums text-ink">{stat.value}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-2.5 text-[10px] text-ink-dim">
                  Updated {timeAgo(track.current.recordedAt)}
                </p>
              </div>

              <button
                type="button"
                onClick={() => handleSelectVehicle(track.vehicleId)}
                className={`pointer-events-auto flex items-center gap-2 rounded-full border px-3.5 py-2 text-left backdrop-blur-md transition ${
                  track.vehicleId === selectedVehicleId
                    ? 'border-brand bg-panel/95 ring-1 ring-brand/40'
                    : 'border-edge bg-panel/85 hover:bg-panel-hover/90'
                }`}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: track.color }}
                />
                <span className="font-mono text-sm font-medium text-ink">
                  {track.licensePlate}
                </span>
                {/* A dash, not a stale speed: this chip is scanned at a glance
                    and a number on it reads as live. */}
                <span className="text-xs tabular-nums text-ink-dim">
                  {isReadingLive(track.current.recordedAt)
                    ? `${Math.round(track.current.speedKph ?? 0)} km/h`
                    : '—'}
                </span>
              </button>
            </div>
          );
        })}
      </div>

      {/* Selected vehicle info panel */}
      {selectedTrack && (
        <div className="pointer-events-none absolute right-4 top-16 z-10 w-64 rounded-xl border border-edge bg-panel/95 p-4 backdrop-blur-md">
          {/* Ignition and speed describe the last packet, not the vehicle, once
              the tracker has gone quiet. Both are reported as last-known rather
              than current — a stale "Ignition on · 6 km/h" said the car was
              running when it had been parked overnight. */}
          <div className="flex items-center justify-between">
            <p className="font-semibold text-ink">{selectedTrack.licensePlate}</p>
            <span
              className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                !selectedTrackLive
                  ? 'bg-edge/40 text-ink-dim'
                  : selectedTrack.current.ignitionOn
                    ? 'bg-good/10 text-good'
                    : 'bg-edge/40 text-ink-dim'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  selectedTrackLive && selectedTrack.current.ignitionOn ? 'bg-good' : 'bg-ink-dim'
                }`}
              />
              {!selectedTrackLive
                ? 'No signal'
                : selectedTrack.current.ignitionOn
                  ? 'Ignition on'
                  : 'Ignition off'}
            </span>
          </div>
          <p className="text-xs text-ink-dim">
            {[selectedTrack.make, selectedTrack.model].filter(Boolean).join(' ')}
            {selectedTrack.driverName ? ` · ${selectedTrack.driverName}` : ''}
          </p>
          <p className="mt-1 text-[10px] text-ink-dim">
            Updated {timeAgo(selectedTrack.current.recordedAt)}
          </p>

          {/* Where the vehicle actually is, in words and in a picture. A pair of
              coordinates tells a manager nothing; the kerbside view is what
              makes "parked at the depot" checkable. */}
          <CurrentPlaceCard
            lat={selectedTrack.current.lat}
            lng={selectedTrack.current.lng}
          />
          <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs">
            {/* The same instrument as the vehicle view, sized down. A dial
                reads faster than a number on a map you are scanning. */}
            <div className="rounded-xl bg-canvas p-2">
              <p className="text-ink-dim">Speed</p>
              <SpeedGauge
                value={selectedTrackLive ? (selectedTrack.current.speedKph ?? 0) : 0}
                max={160}
                unit="km/h"
                size={128}
                className="mt-1"
              />
              {!selectedTrackLive && (
                <p className="mt-1 text-[10px] leading-tight text-ink-dim">
                  last seen {Math.round(selectedTrack.current.speedKph ?? 0)} km/h
                </p>
              )}
            </div>
            {/* "Fuel" alone read as a trip statistic next to "Last trip". This
                is the modelled level still IN the tank, so it says so — with
                the percentage and the confidence that the GPS-derived tank
                model attaches to it, since it is an estimate, not a sender
                reading. */}
            <div className="rounded-xl bg-canvas p-2">
              <p className="text-ink-dim">Fuel left</p>
              {(() => {
                const meta = fleetMeta.get(selectedTrack.vehicleId);
                const litres = meta?.fuel ?? null;
                const pct = usableFuelPercent(litres, meta?.tankCapacity ?? null);
                const inReserve = isInFuelReserve(litres);
                return (
                  <LiquidFuelGauge
                    percent={pct}
                    size={116}
                    className="mt-1"
                    inReserve={inReserve}
                    primary={litres != null ? `${litres.toFixed(1)}L` : '—'}
                  />
                );
              })()}
              {(() => {
                const meta = fleetMeta.get(selectedTrack.vehicleId);
                const litres = meta?.fuel ?? null;
                const pct = usableFuelPercent(litres, meta?.tankCapacity ?? null);
                const inReserve = isInFuelReserve(litres);
                if (pct == null && meta?.tankConfidence == null) return null;
                return (
                  <p
                    className={`mt-0.5 text-[10px] leading-tight ${inReserve ? 'font-semibold text-bad-bright' : 'text-ink-dim'}`}
                  >
                    {inReserve && <span>In reserve</span>}
                    {!inReserve && pct != null && <span>{pct}% usable</span>}
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

/**
 * Where the vehicle is standing, in words and in a picture.
 *
 * Coordinates are not an answer to "where is it?" — a manager cannot check
 * 9.0158, 7.6235 against anything. The kerbside image is the part that settles
 * an argument, so it leads. Resolved only for the selected vehicle and only
 * when its position actually moves, since each lookup is a billed Google call.
 */
function CurrentPlaceCard({ lat, lng }: { lat: number; lng: number }) {
  // Result and the coordinates it belongs to are one value, so a stale place
  // can never be shown against a new position — and nothing has to be reset
  // synchronously when the vehicle moves.
  const [resolved, setResolved] = useState<{
    key: string;
    place: StopPlace | null;
    failed: boolean;
  } | null>(null);

  // Round before keying the effect: a parked vehicle jitters by a few metres on
  // every fix, which would otherwise re-resolve the same doorway all day.
  const keyLat = Number(lat.toFixed(4));
  const keyLng = Number(lng.toFixed(4));
  const key = `${keyLat},${keyLng}`;

  useEffect(() => {
    if (!Number.isFinite(keyLat) || !Number.isFinite(keyLng)) return;
    let cancelled = false;
    fetchStopPlace(keyLat, keyLng)
      .then((result) => {
        if (!cancelled) setResolved({ key: `${keyLat},${keyLng}`, place: result, failed: false });
      })
      .catch(() => {
        if (!cancelled) setResolved({ key: `${keyLat},${keyLng}`, place: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [keyLat, keyLng]);

  const current = resolved?.key === key ? resolved : null;
  const place = current?.place ?? null;
  const failed = current?.failed ?? false;

  if (failed) return null;

  const label = place?.place_name ?? place?.formatted_address ?? null;
  const photo = placePhotoSrc(place?.photo_url ?? null);

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-edge bg-canvas">
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photo}
          alt={label ? `View of ${label}` : 'View of the vehicle location'}
          className="h-24 w-full object-cover"
        />
      ) : (
        <div className="flex h-24 w-full items-center justify-center text-[10px] text-ink-dim">
          {place ? 'No imagery for this spot' : 'Locating…'}
        </div>
      )}
      <div className="p-2">
        <p className="flex items-start gap-1 text-xs leading-snug text-ink">
          <MapPinIcon />
          <span className="min-w-0">{label ?? 'Resolving address…'}</span>
        </p>
        {place?.image_kind === 'street_view' && place.street_view_date && (
          <p className="mt-1 text-[10px] text-ink-dim">
            Street View · {place.street_view_date}
          </p>
        )}
        {place?.image_kind === 'place_photo' && (
          <p className="mt-1 text-[10px] text-ink-dim">Photo of a nearby place</p>
        )}
      </div>
    </div>
  );
}

function MapPinIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="mt-0.5 h-3 w-3 shrink-0 text-brand"
      aria-hidden="true"
    >
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}
