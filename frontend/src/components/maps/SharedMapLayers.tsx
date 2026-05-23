'use client';

import { useEffect, useMemo } from 'react';
import { Marker, Polyline, useMap, useMapsLibrary } from '@vis.gl/react-google-maps';
import {
  ROUTE_ACTIVE,
  ROUTE_DIM,
  ROUTE_GLOW,
  ROUTE_PRIMARY,
  anomalyPinSvgDataUrl,
  car3dSvgDataUrl,
} from '@/lib/fleet-map-theme';

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

export function EmphasizedRoute({
  path,
  traveledPath,
  color = ROUTE_PRIMARY,
  activeColor = ROUTE_ACTIVE,
  emphasized = true,
}: {
  path: google.maps.LatLngLiteral[];
  traveledPath?: google.maps.LatLngLiteral[];
  color?: string;
  activeColor?: string;
  emphasized?: boolean;
}) {
  if (path.length < 2) return null;

  const traveled =
    traveledPath && traveledPath.length >= 2
      ? traveledPath
      : emphasized
        ? path
        : null;

  return (
    <>
      <Polyline
        path={path}
        strokeColor={ROUTE_DIM}
        strokeOpacity={0.85}
        strokeWeight={emphasized ? 9 : 6}
        geodesic
        zIndex={1}
      />
      <Polyline
        path={path}
        strokeColor={color}
        strokeOpacity={0.28}
        strokeWeight={emphasized ? 5 : 3}
        geodesic
        zIndex={2}
      />
      {traveled && (
        <>
          <Polyline
            path={traveled}
            strokeColor={ROUTE_GLOW}
            strokeOpacity={0.38}
            strokeWeight={10}
            geodesic
            zIndex={3}
          />
          <Polyline
            path={traveled}
            strokeColor={activeColor}
            strokeOpacity={1}
            strokeWeight={6}
            geodesic
            zIndex={4}
          />
        </>
      )}
    </>
  );
}

export function VehicleCarMarker({
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
}

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
