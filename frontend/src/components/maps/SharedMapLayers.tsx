'use client';

import { memo, useEffect, useMemo, useState } from 'react';
import { Marker, Polyline, useMap, useMapsLibrary } from '@vis.gl/react-google-maps';
import {
  ROUTE_DIM,
  ROUTE_PRIMARY,
  anomalyPinSvgDataUrl,
  car3dSvgDataUrl,
} from '@/lib/fleet-map-theme';
import { vehicleSprite } from '@/lib/vehicle-sprite';

/**
 * Soft radial puck the vehicle sits on. Drawn as an SVG data URL rather than a
 * google.maps.Circle so it keeps a constant screen size — this is a highlight
 * on the marker, not a distance on the ground.
 */
function glowPuckDataUrl(accent: string, selected: boolean): string {
  const opacity = selected ? 0.5 : 0.26;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
    <defs>
      <radialGradient id="g">
        <stop offset="0%" stop-color="${accent}" stop-opacity="${opacity}"/>
        <stop offset="34%" stop-color="${accent}" stop-opacity="${opacity * 0.42}"/>
        <stop offset="72%" stop-color="${accent}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <circle cx="64" cy="64" r="64" fill="url(#g)"/>
  </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

// SVG arc path for a unit circle — used as the dotted trail symbol.
// Numeric SymbolPath.CIRCLE (0) is avoided to keep the import side-effect-free.
const CIRCLE_PATH = 'M 0 -1 A 1 1 0 1 0 0 1 A 1 1 0 1 0 0 -1 Z';

// Chevron pointing along the direction of travel. Google rotates line symbols
// to the segment angle, so this reads as a forward arrow anywhere on the path.
const CHEVRON_PATH = 'M -1.1 -1.1 L 0.4 0 L -1.1 1.1';

// How many pieces the emphasized trail is cut into to fade from tail to head.
// Enough to look continuous at screen width, few enough to stay cheap.
const FADE_SLICES = 14;

/**
 * Cuts a path into contiguous slices for the tail fade. Each slice repeats its
 * predecessor's final point so consecutive polylines butt together without a
 * visible seam. Paths shorter than `count` segments degrade to one slice per
 * segment rather than producing empty polylines.
 */
function fadeSlices(
  path: google.maps.LatLngLiteral[],
  count: number,
): google.maps.LatLngLiteral[][] {
  const segments = path.length - 1;
  if (segments <= count) {
    return path.slice(0, -1).map((p, i) => [p, path[i + 1]]);
  }
  const out: google.maps.LatLngLiteral[][] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor((segments * i) / count);
    const end = Math.floor((segments * (i + 1)) / count);
    out.push(path.slice(start, end + 1));
  }
  return out;
}

/**
 * Drives the marching-chevron offset for live trips. ~12fps rather than rAF:
 * this is ambient motion on a dashboard that may already be running the 3D
 * vehicle, and nobody can read the difference on a crawling arrow.
 */
function useMarchingOffset(active: boolean): number {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (!document.hidden) setOffset((o) => (o + 3) % 100);
    }, 80);
    return () => clearInterval(id);
  }, [active]);

  return active ? offset : 0;
}

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
  flowing = false,
}: {
  path: google.maps.LatLngLiteral[];
  traveledPath?: google.maps.LatLngLiteral[]; // kept for API compat, unused
  color?: string;
  activeColor?: string;
  emphasized?: boolean;
  /** Trip is still in progress — chevrons march toward the vehicle. */
  flowing?: boolean;
}) {
  const marchOffset = useMarchingOffset(flowing && emphasized && path.length > 1);

  if (path.length < 2) return null;

  // Background trips are context, not the subject. A single dim line reads as
  // "another journey" without competing with the selected trail, and keeps the
  // polyline count flat when a whole fleet is on screen.
  if (!emphasized) {
    return (
      <>
        <Polyline
          path={path}
          strokeColor={ROUTE_DIM}
          strokeOpacity={0.4}
          strokeWeight={3}
          geodesic
          zIndex={1}
        />
        <Polyline
          path={path}
          strokeColor={color}
          strokeOpacity={0.3}
          strokeWeight={1.6}
          geodesic
          zIndex={2}
          icons={[
            {
              icon: {
                path: CIRCLE_PATH,
                scale: 1.5,
                fillColor: color,
                fillOpacity: 0.5,
                strokeWeight: 0,
              } as google.maps.Symbol,
              offset: '0%',
              repeat: '26px',
            },
          ]}
        />
      </>
    );
  }

  const slices = fadeSlices(path, FADE_SLICES);

  return (
    <>
      {/* Bloom. A wide, near-transparent stroke gives the active trail the same
          halo the vehicle puck has, so the two read as one object. */}
      <Polyline
        path={path}
        strokeColor={color}
        strokeOpacity={0.09}
        strokeWeight={16}
        geodesic
        zIndex={0}
      />
      {/* Dark rail underneath — the lemon needs a shadow to stay legible where
          the trail crosses a lit road fill rather than the map background. */}
      <Polyline
        path={path}
        strokeColor={ROUTE_DIM}
        strokeOpacity={0.8}
        strokeWeight={7}
        geodesic
        zIndex={1}
      />
      {/* Core, sliced so the trail fades and thins toward the oldest fix. The
          bright, thick end is where the vehicle is now, which makes direction
          of travel readable at a glance — before you resolve any arrows. */}
      {slices.map((slice, i) => {
        const t = (i + 1) / slices.length;
        return (
          <Polyline
            key={`fade-${i}`}
            path={slice}
            strokeColor={color}
            strokeOpacity={0.14 + t * 0.81}
            strokeWeight={2.4 + t * 2.1}
            geodesic
            zIndex={2}
          />
        );
      })}
      {/* Chevrons notched out of the core. Dark-on-lemon rather than a second
          bright colour, so direction is legible without adding a hue. */}
      <Polyline
        path={path}
        strokeOpacity={0}
        strokeWeight={1}
        geodesic
        zIndex={3}
        icons={[
          {
            icon: {
              path: CHEVRON_PATH,
              scale: 2.2,
              strokeColor: '#0b0e13',
              strokeOpacity: 0.85,
              strokeWeight: 2,
              fillOpacity: 0,
            } as google.maps.Symbol,
            offset: `${marchOffset}%`,
            repeat: '52px',
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
  onMouseOver,
  onMouseOut,
}: {
  lat: number;
  lng: number;
  label: string;
  color: string;
  focused?: boolean;
  title?: string;
  onClick?: () => void;
  // Cursor position is handed up so the caller can anchor a themed hover card.
  // Google's own InfoWindow is not used for hover: this build's
  // @vis.gl/react-google-maps (1.8.3) has no headerDisabled option, so it would
  // force a white bubble with a close button onto a dark map.
  onMouseOver?: (point: { x: number; y: number }) => void;
  onMouseOut?: () => void;
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
      onMouseOver={
        onMouseOver
          ? (e) => {
              const dom = e.domEvent as MouseEvent | undefined;
              if (dom) onMouseOver({ x: dom.clientX, y: dom.clientY });
            }
          : undefined
      }
      onMouseOut={onMouseOut}
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
    const size = selected ? 56 : 46;
    // Real 3D render, falling back to the flat SVG wherever WebGL is
    // unavailable — a missing marker is far worse than a plain one.
    const sprite = vehicleSprite(heading, accent);
    return {
      url: sprite ?? car3dSvgDataUrl(heading, selected, accent),
      scaledSize: new maps.Size(size, size),
      anchor: new maps.Point(size / 2, size / 2),
    };
  }, [maps, heading, selected, accent]);

  // Warm puck under the vehicle. A separate, lower-zIndex marker rather than
  // part of the sprite: it has to stay circular as the vehicle turns, and it
  // pulses on the selected vehicle without re-rendering the model.
  const glow = useMemo(() => {
    if (!maps) return undefined;
    const size = selected ? 76 : 60;
    return {
      url: glowPuckDataUrl(ROUTE_PRIMARY, selected),
      scaledSize: new maps.Size(size, size),
      anchor: new maps.Point(size / 2, size / 2),
    };
  }, [maps, selected]);

  if (!icon) return null;

  return (
    <>
      {glow && (
        <Marker
          position={{ lat, lng }}
          icon={glow}
          zIndex={selected ? 998 : 198}
          clickable={false}
        />
      )}
      <Marker
        position={{ lat, lng }}
        icon={icon}
        zIndex={selected ? 1000 : 200}
        title={title}
        onClick={onClick}
      />
    </>
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
