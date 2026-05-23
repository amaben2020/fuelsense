'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps';
import { lerp } from '@/lib/map-utils';
import { FleetVehicle, VehicleTrack } from '@/lib/api';
import {
  FLEET_MAPS_KEY,
  LAGOS_CENTER,
  fleetMapDefaults,
} from '@/lib/fleet-map-theme';
import {
  EmphasizedRoute,
  MapResizeFix,
  VehicleCarMarker,
} from '@/components/maps/SharedMapLayers';

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

  if (!FLEET_MAPS_KEY) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-[#0b1326] p-8 text-center">
        <p className="text-[#8e90a2]">Add NEXT_PUBLIC_GOOGLE_MAPS_API_KEY to enable live map</p>
      </div>
    );
  }

  const initialCenter = initializedRef.current
    ? undefined
    : selectedTrack
      ? { lat: selectedTrack.displayLat, lng: selectedTrack.displayLng }
      : LAGOS_CENTER;

  if (!initializedRef.current && selectedTrack) {
    initializedRef.current = true;
  }

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden rounded-xl border border-[#434656]">
      <div className="absolute inset-0">
        <APIProvider apiKey={FLEET_MAPS_KEY}>
          <Map
            {...fleetMapDefaults({
              defaultCenter: initialCenter ?? LAGOS_CENTER,
              defaultZoom: 13,
            })}
            style={{ width: '100%', height: '100%' }}
          >
            <MapResizeFix />
            <MapInteractionGuard onUserInteract={handleUserInteract} />
            <MapCameraFollow track={selectedTrack} enabled={followSelected && !!selectedTrack} />

            {animated.map((track) => (
              <EmphasizedRoute
                key={`route-${track.vehicleId}`}
                path={track.path.slice(-40)}
                color={track.color}
                activeColor={track.color}
                emphasized={track.vehicleId === selectedVehicleId}
              />
            ))}

            {animated.map((track) => (
              <VehicleCarMarker
                key={`car-${track.vehicleId}`}
                lat={track.displayLat}
                lng={track.displayLng}
                heading={track.displayHeading}
                accent={track.color}
                selected={track.vehicleId === selectedVehicleId}
                title={track.licensePlate}
                onClick={() => onSelectVehicle(track.vehicleId)}
              />
            ))}
          </Map>
        </APIProvider>
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-[#0b1326]/90 to-transparent p-4">
        <p className="text-sm font-medium text-[#dae2fd]">Live monitoring</p>
        <p className="text-xs text-[#8e90a2]">
          {animated.length} vehicles · GPS updates every 2s · pinch or scroll to zoom
        </p>
      </div>

      <div className="absolute bottom-4 left-4 right-4 z-10 flex gap-2 overflow-x-auto pb-1">
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
        <div className="pointer-events-none absolute right-4 top-16 z-10 w-64 rounded-xl border border-[#434656] bg-[#171f33]/95 p-4 backdrop-blur-md">
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
