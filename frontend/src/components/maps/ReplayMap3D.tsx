'use client';

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { MANOEUVRE_STYLE, TrackManoeuvre, TrackPoint, speedBand } from './SharedMapLayers';

export const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_PK ?? '';

/** Whether a 3D view can be offered at all. */
export const mapbox3DAvailable = () => MAPBOX_TOKEN.length > 0;

/**
 * The replay track on a pitched Mapbox globe, with extruded buildings.
 *
 * Why a second map engine rather than tilting the Google one: Google's tilt is
 * only available on vector maps at high zoom and carries no building geometry
 * at these coordinates, so "3D" there is a slightly angled flat map. The thing
 * that actually helps when reading a harsh-braking event on a flyover or a
 * multi-level interchange is knowing which deck the vehicle was on, and that
 * needs real extrusions.
 *
 * Written against the mapbox-gl imperative API rather than a React wrapper, for
 * the same reason the vehicle model is plain three.js: the wrapper libraries in
 * this project's toolchain have been unreliable under Turbopack, and a map that
 * fails to mount is worse than one with a few more lines of setup.
 *
 * Deliberately not the default view. The 2D map is the one that answers "where
 * did this happen"; this answers "what did the road look like", which is a
 * follow-up question, and pitched views cost legibility on a flat street grid.
 */
export function ReplayMap3D({
  points,
  manoeuvres,
  activeIndex,
  speedLimitKph,
}: {
  points: TrackPoint[];
  manoeuvres: TrackManoeuvre[];
  /** Index into `points`, already remapped past fixes that carried no position. */
  activeIndex: number;
  speedLimitKph?: number | null;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const readyRef = useRef(false);

  // One map instance for the life of the panel. Rebuilding it on every scrub
  // would restart the style load and flash the container on each frame.
  useEffect(() => {
    if (!container.current || !MAPBOX_TOKEN) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;
    const start = points[Math.min(activeIndex, points.length - 1)] ?? points[0];

    const map = new mapboxgl.Map({
      container: container.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: start ? [start.lng, start.lat] : [7.49, 9.06],
      zoom: 16.5,
      pitch: 60,
      bearing: -20,
      antialias: true,
      attributionControl: true,
    });
    mapRef.current = map;

    map.on('load', () => {
      readyRef.current = true;

      // Extruded buildings from the style's own vector source. Height comes
      // from the tileset, so where Mapbox has no building data the view simply
      // stays flat rather than inventing massing.
      const layers = map.getStyle().layers ?? [];
      const firstSymbol = layers.find((l) => l.type === 'symbol')?.id;
      if (!map.getLayer('replay-buildings')) {
        map.addLayer(
          {
            id: 'replay-buildings',
            source: 'composite',
            'source-layer': 'building',
            filter: ['==', 'extrude', 'true'],
            type: 'fill-extrusion',
            minzoom: 14,
            paint: {
              'fill-extrusion-color': '#20242c',
              'fill-extrusion-height': ['get', 'height'],
              'fill-extrusion-base': ['get', 'min_height'],
              'fill-extrusion-opacity': 0.85,
            },
          },
          firstSymbol
        );
      }

      // The track as one GeoJSON line per colour run, matching the 2D map's
      // banding exactly — the same speedBand() and MANOEUVRE_STYLE the flat
      // view uses, so switching dimension never changes what a colour means.
      map.addSource('replay-track', { type: 'geojson', data: trackGeoJson(points, manoeuvres, speedLimitKph) });

      // Dark casing first, same as the 2D route, so pale fast-speed colours
      // stay readable against lit roads.
      map.addLayer({
        id: 'replay-track-casing',
        type: 'line',
        source: 'replay-track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#0b1220', 'line-width': 9, 'line-opacity': 0.85 },
      });
      map.addLayer({
        id: 'replay-track-line',
        type: 'line',
        source: 'replay-track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 5 },
      });

      const el = document.createElement('div');
      el.style.cssText =
        'width:16px;height:16px;border-radius:50%;background:#cde04a;box-shadow:0 0 0 3px rgba(205,224,74,0.25),0 2px 6px rgba(0,0,0,0.6);border:2px solid #0b1220';
      markerRef.current = new mapboxgl.Marker({ element: el });
      if (start) markerRef.current.setLngLat([start.lng, start.lat]).addTo(map);
    });

    return () => {
      readyRef.current = false;
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // Intentionally mount-only: the track and camera are updated in the effects
    // below rather than by tearing the map down and rebuilding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track data can change while mounted (a different event opened in the same
  // panel), so the source is updated in place.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const src = map.getSource('replay-track') as mapboxgl.GeoJSONSource | undefined;
    src?.setData(trackGeoJson(points, manoeuvres, speedLimitKph));
  }, [points, manoeuvres, speedLimitKph]);

  // Follow the scrubber. `easeTo` rather than `jumpTo` so playback reads as
  // motion along the road instead of a series of teleports.
  useEffect(() => {
    const map = mapRef.current;
    const pos = points[activeIndex];
    if (!map || !readyRef.current || !pos) return;
    markerRef.current?.setLngLat([pos.lng, pos.lat]);
    map.easeTo({ center: [pos.lng, pos.lat], duration: 450, essential: true });
  }, [activeIndex, points]);

  if (!MAPBOX_TOKEN) {
    return (
      <div className="flex h-full w-full items-center justify-center px-6 text-center">
        <p className="text-xs text-ink-dim">
          3D view needs NEXT_PUBLIC_MAPBOX_PK to be set.
        </p>
      </div>
    );
  }

  return <div ref={container} className="h-full w-full" />;
}

/**
 * One LineString per constant-colour run, so a single source carries the whole
 * graded track. Mirrors the run-splitting the 2D route does.
 */
function trackGeoJson(
  points: TrackPoint[],
  manoeuvres: TrackManoeuvre[],
  speedLimitKph?: number | null
): GeoJSON.FeatureCollection {
  const manoeuvreAt = new Map<number, string>();
  for (const m of manoeuvres) {
    const style = MANOEUVRE_STYLE[m.type];
    if (!style) continue;
    for (const seg of [m.index - 1, m.index]) {
      if (seg >= 0) manoeuvreAt.set(seg, style.color);
    }
  }

  const colourAt = (i: number) => {
    const marked = manoeuvreAt.get(i);
    if (marked) return marked;
    if (speedLimitKph && points[i].speedKph > speedLimitKph) {
      return MANOEUVRE_STYLE.overspeeding.color;
    }
    return speedBand(points[i].speedKph).color;
  };

  const features: GeoJSON.Feature[] = [];
  if (points.length < 2) return { type: 'FeatureCollection', features };

  let runStart = 0;
  let runColour = colourAt(0);
  const flush = (endExclusive: number) => {
    // +1 so consecutive runs share a vertex and the line has no visible gap.
    const slice = points.slice(runStart, Math.min(endExclusive + 1, points.length));
    if (slice.length < 2) return;
    features.push({
      type: 'Feature',
      properties: { color: runColour },
      geometry: { type: 'LineString', coordinates: slice.map((p) => [p.lng, p.lat]) },
    });
  };

  for (let i = 1; i < points.length; i += 1) {
    const c = colourAt(i);
    if (c !== runColour) {
      flush(i);
      runStart = i;
      runColour = c;
    }
  }
  flush(points.length - 1);

  return { type: 'FeatureCollection', features };
}
