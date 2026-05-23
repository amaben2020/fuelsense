'use client';

import { useMemo, useState } from 'react';
import { APIProvider, Map, InfoWindow } from '@vis.gl/react-google-maps';
import { FleetVehicle } from '@/lib/api';
import { parseCoord } from '@/lib/map-utils';
import {
  FLEET_MAPS_KEY,
  LAGOS_CENTER,
  fleetMapContainerStyle,
  fleetMapDefaults,
} from '@/lib/fleet-map-theme';
import { MapResizeFix, VehicleCarMarker } from '@/components/maps/SharedMapLayers';

export function FleetMap({
  fleet,
  selectedId,
  onSelect,
  theme = 'dark',
}: {
  fleet: FleetVehicle[];
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  theme?: 'light' | 'dark';
}) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const located = useMemo(
    () =>
      fleet
        .map((v) => {
          const lat = parseCoord(v.latitude);
          const lng = parseCoord(v.longitude);
          if (lat == null || lng == null) return null;
          return { ...v, lat, lng };
        })
        .filter(Boolean) as (FleetVehicle & { lat: number; lng: number })[],
    [fleet]
  );

  const center = useMemo(() => {
    if (located.length === 0) return LAGOS_CENTER;
    const lat = located.reduce((sum, v) => sum + v.lat, 0) / located.length;
    const lng = located.reduce((sum, v) => sum + v.lng, 0) / located.length;
    return { lat, lng };
  }, [located]);

  const infoId = selectedId ?? activeId;
  const infoVehicle = located.find((v) => v.id === infoId) ?? null;
  const isDark = theme === 'dark';

  const shellClass = isDark
    ? 'overflow-hidden rounded-lg border border-[#434656] bg-[#171f33]'
    : 'overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200/60';
  const headerBorder = isDark ? 'border-[#434656]' : 'border-slate-100';
  const titleClass = isDark ? 'font-semibold text-[#dae2fd]' : 'font-semibold text-slate-900';
  const subClass = isDark ? 'text-xs text-[#8e90a2]' : 'text-xs text-slate-500';

  if (!FLEET_MAPS_KEY) {
    return (
      <div
        className={`flex h-[420px] items-center justify-center p-8 text-center ${
          isDark
            ? 'rounded-lg border border-[#434656] bg-[#171f33]'
            : 'rounded-xl bg-white shadow-sm ring-1 ring-slate-200/60'
        }`}
      >
        <div>
          <p className={isDark ? 'font-medium text-[#dae2fd]' : 'font-medium text-slate-800'}>
            Map unavailable
          </p>
          <p className={`mt-2 text-sm ${isDark ? 'text-[#8e90a2]' : 'text-slate-500'}`}>
            Set <code className="text-xs">NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> in{' '}
            <code className="text-xs">.env.local</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={shellClass}>
      <div className={`flex items-center justify-between border-b px-4 py-3 ${headerBorder}`}>
        <div>
          <h2 className={titleClass}>Live fleet map</h2>
          <p className={subClass}>
            {located.length} of {fleet.length} vehicles with GPS
          </p>
        </div>
        <div className={`flex gap-3 text-xs ${isDark ? 'text-[#8e90a2]' : 'text-slate-500'}`}>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-emerald-500" /> Online
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-red-500" /> Offline
          </span>
        </div>
      </div>
      <APIProvider apiKey={FLEET_MAPS_KEY}>
        <Map
          {...fleetMapDefaults({
            center,
            zoom: located.length <= 1 ? 14 : 12,
          })}
          style={fleetMapContainerStyle(420)}
          onClick={() => {
            setActiveId(null);
            onSelect?.(null);
          }}
        >
          <MapResizeFix />
          {located.map((vehicle) => (
            <VehicleCarMarker
              key={vehicle.id}
              lat={vehicle.lat}
              lng={vehicle.lng}
              heading={0}
              selected={vehicle.id === infoId}
              title={vehicle.license_plate}
              onClick={() => {
                setActiveId(vehicle.id);
                onSelect?.(vehicle.id);
              }}
            />
          ))}

          {infoVehicle && (
            <InfoWindow
              position={{ lat: infoVehicle.lat, lng: infoVehicle.lng }}
              onCloseClick={() => {
                setActiveId(null);
                onSelect?.(null);
              }}
            >
              <div className="min-w-[160px] p-1 text-sm text-slate-800">
                <p className="font-semibold">{infoVehicle.license_plate}</p>
                <p className="text-xs text-slate-600">
                  {[infoVehicle.make, infoVehicle.model].filter(Boolean).join(' ') ||
                    'Vehicle'}
                </p>
                <p className="mt-2 text-xs capitalize">
                  Status:{' '}
                  <span
                    className={
                      infoVehicle.connection_status === 'online'
                        ? 'text-emerald-600'
                        : 'text-red-500'
                    }
                  >
                    {infoVehicle.connection_status}
                  </span>
                </p>
                {infoVehicle.fuel_level_liters != null && (
                  <p className="text-xs">
                    Fuel: {Number(infoVehicle.fuel_level_liters).toFixed(1)} L
                  </p>
                )}
                {infoVehicle.speed_kph != null && (
                  <p className="text-xs">Speed: {infoVehicle.speed_kph} km/h</p>
                )}
              </div>
            </InfoWindow>
          )}
        </Map>
      </APIProvider>
    </div>
  );
}
