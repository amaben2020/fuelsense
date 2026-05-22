'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  APIProvider,
  Map,
  Marker,
  Polyline,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import { carSvgDataUrl, lerp } from '@/lib/map-utils';
import { FleetVehicle, VehicleTrack } from '@/lib/api';

const LAGOS = { lat: 6.5244, lng: 3.3792 };
const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID;
const ANIMATION_MS = 1800;

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

function VehicleCarMarker({
  track,
  selected,
  onSelect,
}: {
  track: AnimatedTrack;
  selected: boolean;
  onSelect: () => void;
}) {
  const maps = useMapsLibrary('core');

  const icon = useMemo(() => {
    if (!maps) return undefined;
    const size = selected ? 52 : 44;
    return {
      url: carSvgDataUrl(track.color, track.displayHeading, selected),
      scaledSize: new maps.Size(size, size),
      anchor: new maps.Point(size / 2, size / 2),
    };
  }, [maps, track.color, track.displayHeading, selected]);

  if (!icon) return null;

  return (
    <Marker
      position={{ lat: track.displayLat, lng: track.displayLng }}
      icon={icon}
      zIndex={selected ? 1000 : 100}
      onClick={onSelect}
      title={track.licensePlate}
    />
  );
}

export function LiveMonitoringMap({
  tracks,
  fleet,
  selectedVehicleId,
  onSelectVehicle,
  followSelected,
  onUserPan,
}: {
  tracks: VehicleTrack[];
  fleet: FleetVehicle[];
  selectedVehicleId: string | null;
  onSelectVehicle: (id: string) => void;
  followSelected: boolean;
  onUserPan?: () => void;
}) {
  const [animated, setAnimated] = useState<AnimatedTrack[]>([]);
  const prevRef = useRef(
    new globalThis.Map<string, { lat: number; lng: number; heading: number }>()
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
          prev: {
            lat: track.current.lat,
            lng: track.current.lng,
            heading: track.heading,
          },
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
        displayHeading: snap
          ? track.heading
          : lerp(prev.heading, track.heading, eased),
      }));

      setAnimated(next);

      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        const snapshot = new globalThis.Map<
          string,
          { lat: number; lng: number; heading: number }
        >();
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

  const fleetStatus = useMemo(() => {
    return new globalThis.Map(fleet.map((v) => [v.id, v.connection_status]));
  }, [fleet]);

  const fleetMeta = useMemo(() => {
    return new globalThis.Map(
      fleet.map((v) => [
        v.id,
        {
          odometer: v.odometer_km,
          driver: v.driver_name,
          fuel: v.fuel_level_liters,
        },
      ])
    );
  }, [fleet]);

  const handleUserInteract = useCallback(() => {
    onUserPan?.();
  }, [onUserPan]);

  if (!MAPS_KEY) {
    return (
      <div className="flex h-full min-h-[480px] items-center justify-center bg-[#0b1326] p-8 text-center">
        <p className="text-[#8e90a2]">Add NEXT_PUBLIC_GOOGLE_MAPS_API_KEY to enable live map</p>
      </div>
    );
  }

  const initialCenter = initializedRef.current
    ? undefined
    : selectedTrack
      ? { lat: selectedTrack.displayLat, lng: selectedTrack.displayLng }
      : LAGOS;

  if (!initializedRef.current && selectedTrack) {
    initializedRef.current = true;
  }

  return (
    <div className="relative h-full min-h-[calc(100vh-8rem)] w-full overflow-hidden rounded-xl border border-[#434656]">
      <APIProvider apiKey={MAPS_KEY}>
        <Map
          mapId={MAP_ID}
          colorScheme="DARK"
          defaultCenter={initialCenter ?? LAGOS}
          defaultZoom={13}
          tilt={45}
          heading={0}
          gestureHandling="greedy"
          disableDefaultUI={false}
          zoomControl
          scrollwheel
          style={{ width: '100%', height: '100%', minHeight: 'calc(100vh - 8rem)' }}
        >
          <MapInteractionGuard onUserInteract={handleUserInteract} />
          <MapCameraFollow track={selectedTrack} enabled={followSelected && !!selectedTrack} />

          {animated.map((track) => (
            <Polyline
              key={`route-${track.vehicleId}`}
              path={track.path.slice(-40)}
              strokeColor={track.color}
              strokeOpacity={track.vehicleId === selectedVehicleId ? 0.95 : 0.55}
              strokeWeight={track.vehicleId === selectedVehicleId ? 6 : 4}
              geodesic
            />
          ))}

          {animated.map((track) => (
            <VehicleCarMarker
              key={`car-${track.vehicleId}`}
              track={track}
              selected={track.vehicleId === selectedVehicleId}
              onSelect={() => onSelectVehicle(track.vehicleId)}
            />
          ))}
        </Map>
      </APIProvider>

      <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-[#0b1326]/90 to-transparent p-4">
        <p className="text-sm font-medium text-[#dae2fd]">Live monitoring</p>
        <p className="text-xs text-[#8e90a2]">
          {animated.length} vehicles · GPS updates every 2s · pinch or scroll to zoom
        </p>
      </div>

      <div className="absolute bottom-4 left-4 right-4 flex gap-2 overflow-x-auto pb-1">
        {animated.map((track) => {
          const status = fleetStatus.get(track.vehicleId) ?? 'offline';
          const meta = fleetMeta.get(track.vehicleId);
          return (
            <button
              key={track.vehicleId}
              type="button"
              onClick={() => onSelectVehicle(track.vehicleId)}
              className={`pointer-events-auto shrink-0 rounded-xl border px-3 py-2 text-left backdrop-blur-md transition ${
                track.vehicleId === selectedVehicleId
                  ? 'border-[#b8c3ff] bg-[#171f33]/95 ring-1 ring-[#b8c3ff]/40'
                  : 'border-[#434656] bg-[#171f33]/85 hover:bg-[#222a3d]/90'
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: track.color }}
                />
                <span className="text-sm font-medium text-[#dae2fd]">{track.licensePlate}</span>
                <span
                  className={`text-[10px] capitalize ${
                    status === 'online' ? 'text-[#4edea3]' : 'text-[#ffb4ab]'
                  }`}
                >
                  {status}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-[#8e90a2]">
                {meta?.driver ? `${meta.driver} · ` : ''}
                {track.current.speedKph ?? 0} km/h
                {track.current.fuelLiters != null
                  ? ` · ${track.current.fuelLiters.toFixed(1)} L`
                  : ''}
              </p>
            </button>
          );
        })}
      </div>

      {selectedTrack && (
        <div className="pointer-events-none absolute right-4 top-16 w-64 rounded-xl border border-[#434656] bg-[#171f33]/95 p-4 backdrop-blur-md">
          <p className="font-semibold text-[#dae2fd]">{selectedTrack.licensePlate}</p>
          <p className="text-xs text-[#8e90a2]">
            {[selectedTrack.make, selectedTrack.model].filter(Boolean).join(' ')}
            {selectedTrack.driverName ? ` · ${selectedTrack.driverName}` : ''}
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-lg bg-[#0b1326] p-2">
              <p className="text-[#8e90a2]">Speed</p>
              <p className="font-mono text-lg text-[#dae2fd]">
                {selectedTrack.current.speedKph ?? 0}
              </p>
            </div>
            <div className="rounded-lg bg-[#0b1326] p-2">
              <p className="text-[#8e90a2]">Fuel</p>
              <p className="font-mono text-lg text-[#4edea3]">
                {selectedTrack.current.fuelLiters != null
                  ? `${selectedTrack.current.fuelLiters.toFixed(1)}L`
                  : '—'}
              </p>
            </div>
            <div className="rounded-lg bg-[#0b1326] p-2">
              <p className="text-[#8e90a2]">Odometer</p>
              <p className="font-mono text-lg text-[#dae2fd]">
                {fleetMeta.get(selectedTrack.vehicleId)?.odometer != null
                  ? `${Number(fleetMeta.get(selectedTrack.vehicleId)?.odometer).toLocaleString()} km`
                  : '—'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
