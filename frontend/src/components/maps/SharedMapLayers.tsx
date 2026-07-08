'use client';

import { memo, useEffect, useMemo } from 'react';
import { Marker, Polyline, useMap, useMapsLibrary } from '@vis.gl/react-google-maps';
import {
  ROUTE_DIM,
  ROUTE_PRIMARY,
  anomalyPinSvgDataUrl,
  car3dSvgDataUrl,
} from '@/lib/fleet-map-theme';

// SVG arc path for a unit circle — used as the dotted trail symbol.
// Numeric SymbolPath.CIRCLE (0) is avoided to keep the import side-effect-free.
const CIRCLE_PATH = 'M 0 -1 A 1 1 0 1 0 0 1 A 1 1 0 1 0 0 -1 Z';

export function MapResizeFix() {
  const map = useMap();

  useEffect(() => {
    if (!map) return;

    const resize = () => {
      google.maps.event.trigger(map, 'resize');
    };

    const frame = requestAnimationFrame(resize);
    window.addEventListener('resize', resize);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
    };
  }, [map]);

  return null;
}

export const EmphasizedRoute = memo(function EmphasizedRoute({
  path,
  color = ROUTE_PRIMARY,
  emphasized = true,
}: {
  path: google.maps.LatLngLiteral[];
  traveledPath?: google.maps.LatLngLiteral[]; // kept for API compat, unused
  color?: string;
  activeColor?: string;
  emphasized?: boolean;
}) {
  if (path.length < 2) return null;

  const dotScale = emphasized ? 2.8 : 1.8;
  const dotOpacity = emphasized ? 0.9 : 0.45;
  const dotRepeat = emphasized ? '10px' : '14px';

  return (
    <>
      {/* Thin dark rail so the dots have contrast against the basemap */}
      <Polyline
        path={path}
        strokeColor={ROUTE_DIM}
        strokeOpacity={emphasized ? 0.7 : 0.4}
        strokeWeight={emphasized ? 4 : 2}
        geodesic
        zIndex={1}
      />
      {/* Dotted trail — the dots ARE the trail */}
      <Polyline
        path={path}
        strokeOpacity={0}
        strokeWeight={1}
        geodesic
        zIndex={2}
        icons={[
          {
            icon: {
              path: CIRCLE_PATH,
              scale: dotScale,
              fillColor: color,
              fillOpacity: dotOpacity,
              strokeWeight: 0,
            } as google.maps.Symbol,
            offset: '0%',
            repeat: dotRepeat,
          },
        ]}
      />
    </>
  );
});

function tripBadgeSvgDataUrl(label: string, color: string, focused: boolean): string {
  const bg = focused ? color : '#0b0e13';
  const fg = focused ? '#0b0e13' : '#e8ecf4';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">
    <circle cx="13" cy="13" r="11" fill="${bg}" stroke="${color}" stroke-width="2.5"/>
    <text x="13" y="17" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="${fg}">${label}</text>
  </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

/** Numbered trip-start badge — classic Marker, works without a cloud Map ID. */
export const TripBadgeMarker = memo(function TripBadgeMarker({
  lat,
  lng,
  label,
  color,
  focused = false,
  title,
  onClick,
}: {
  lat: number;
  lng: number;
  label: string;
  color: string;
  focused?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  const maps = useMapsLibrary('core');

  const icon = useMemo(() => {
    if (!maps) return undefined;
    const size = focused ? 30 : 24;
    return {
      url: tripBadgeSvgDataUrl(label, color, focused),
      scaledSize: new maps.Size(size, size),
      anchor: new maps.Point(size / 2, size / 2),
    };
  }, [maps, label, color, focused]);

  if (!icon) return null;

  return (
    <Marker
      position={{ lat, lng }}
      icon={icon}
      zIndex={focused ? 900 : 300}
      title={title}
      onClick={onClick}
    />
  );
});

export const VehicleCarMarker = memo(function VehicleCarMarker({
  lat,
  lng,
  heading,
  selected = false,
  accent = ROUTE_PRIMARY,
  title,
  onClick,
}: {
  lat: number;
  lng: number;
  heading: number;
  selected?: boolean;
  accent?: string;
  title?: string;
  onClick?: () => void;
}) {
  const maps = useMapsLibrary('core');

  const icon = useMemo(() => {
    if (!maps) return undefined;
    const size = selected ? 56 : 48;
    return {
      url: car3dSvgDataUrl(heading, selected, accent),
      scaledSize: new maps.Size(size, size),
      anchor: new maps.Point(size / 2, size / 2),
    };
  }, [maps, heading, selected, accent]);

  if (!icon) return null;

  return (
    <Marker
      position={{ lat, lng }}
      icon={icon}
      zIndex={selected ? 1000 : 200}
      title={title}
      onClick={onClick}
    />
  );
});

export function AnomalyMapMarker({
  lat,
  lng,
  title = 'Anomaly location',
}: {
  lat: number;
  lng: number;
  title?: string;
}) {
  const maps = useMapsLibrary('core');

  const icon = useMemo(() => {
    if (!maps) return undefined;
    return {
      url: anomalyPinSvgDataUrl(),
      scaledSize: new maps.Size(40, 40),
      anchor: new maps.Point(20, 20),
    };
  }, [maps]);

  if (!icon) return null;

  return <Marker position={{ lat, lng }} icon={icon} zIndex={500} title={title} />;
}
