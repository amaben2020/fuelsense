'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { FLEET_DARK_MAP_STYLES, FLEET_MAPS_KEY } from '@/lib/fleet-map-theme';
import { GnssTrace } from './GnssTrace';
import { SloshTank } from './SloshTank';

// A trip on a real map, scrubbed by scroll position.
//
// The route is sample data, but everything drawn from it is genuine product
// behaviour: the trail builds behind the vehicle, the tank drains against
// distance, and each stop can be opened to see where the vehicle actually sat.

const ROUTE: Array<{ lat: number; lng: number }> = [
  { lat: 8.9947, lng: 7.6168 },
  { lat: 8.9912, lng: 7.6201 },
  { lat: 8.9868, lng: 7.6244 },
  { lat: 8.9821, lng: 7.6289 },
  { lat: 8.9764, lng: 7.6321 },
  { lat: 8.9702, lng: 7.6338 },
  { lat: 8.9641, lng: 7.6372 },
  { lat: 8.9588, lng: 7.6428 },
  { lat: 8.9536, lng: 7.6491 },
  { lat: 8.9489, lng: 7.6558 },
  { lat: 8.9451, lng: 7.6627 },
  { lat: 8.9418, lng: 7.6702 },
];

export interface Stop {
  id: string;
  name: string;
  position: { lat: number; lng: number };
  arrived: string;
  minutes: number;
  idleLiters: number;
  /** Fraction along the route, so a stop only lights up once reached. */
  at: number;
}

const STOPS: Stop[] = [
  {
    id: 'depot',
    name: 'Depot, Kubwa',
    position: ROUTE[0],
    arrived: '06:12',
    minutes: 0,
    idleLiters: 0.2,
    at: 0.02,
  },
  {
    id: 'market',
    name: 'Nyanya market',
    position: ROUTE[5],
    arrived: '06:41',
    minutes: 14,
    idleLiters: 0.5,
    at: 0.45,
  },
  {
    id: 'client',
    name: 'Client site, Karu',
    position: ROUTE[9],
    arrived: '07:08',
    minutes: 9,
    idleLiters: 0.3,
    at: 0.82,
  },
];

const START_LITERS = 42;
const USED_LITERS = 3.1;
const TOTAL_KM = 30.4;
const PRICE_PER_LITER = 1330;

// Top-down car silhouettes, drawn pointing north so Google's `rotation` can
// aim them along the direction of travel. A tapered nose, wing mirrors and
// glass are what make a shape read as a car from directly above; without them
// it is just a rounded rectangle.
const CAR_BODY_PATH =
  'M 0,-22 C 4.6,-22 7.3,-19.4 7.9,-14 L 8.5,-9.2 L 11.6,-7.6 L 11.6,-4.4 ' +
  'L 8.9,-5.6 L 9.5,8 C 9.5,15.6 6.6,19.6 0,19.6 C -6.6,19.6 -9.5,15.6 -9.5,8 ' +
  'L -8.9,-5.6 L -11.6,-4.4 L -11.6,-7.6 L -8.5,-9.2 L -7.9,-14 ' +
  'C -7.3,-19.4 -4.6,-22 0,-22 Z';

const CAR_GLASS_PATH =
  'M 0,-15.4 C 3.4,-15.4 5.3,-13.8 5.8,-10.6 L 6.3,-6.4 ' +
  'C 4,-7.6 -4,-7.6 -6.3,-6.4 L -5.8,-10.6 C -5.3,-13.8 -3.4,-15.4 0,-15.4 Z ' +
  'M 0,10.4 C 3.6,10.4 5.6,9.2 6.2,6.6 L 6.6,2.6 ' +
  'C 4.2,3.8 -4.2,3.8 -6.6,2.6 L -6.2,6.6 C -5.6,9.2 -3.6,10.4 0,10.4 Z';

/**
 * Compass bearing between two fixes, in degrees.
 *
 * Over the few hundred metres between consecutive points a flat approximation
 * is indistinguishable from great-circle, and it keeps the marker steady
 * rather than jittering on rounding.
 */
function bearingBetween(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): number {
  const dLng = (to.lng - from.lng) * Math.cos((from.lat * Math.PI) / 180);
  const dLat = to.lat - from.lat;
  if (dLat === 0 && dLng === 0) return 0;
  return (Math.atan2(dLng, dLat) * 180) / Math.PI;
}

/** Position along the route for a 0-1 fraction, interpolating between fixes. */
function pointAt(fraction: number): { lat: number; lng: number } {
  const clamped = Math.max(0, Math.min(1, fraction));
  const span = (ROUTE.length - 1) * clamped;
  const index = Math.min(ROUTE.length - 2, Math.floor(span));
  const t = span - index;
  const a = ROUTE[index];
  const b = ROUTE[index + 1];
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

function TripLayer({
  onProgress,
  onSelectStop,
  selectedStopId,
}: {
  onProgress: (fraction: number) => void;
  onSelectStop: (stop: Stop) => void;
  selectedStopId: string | null;
}) {
  const map = useMap();
  const progressRef = useRef(onProgress);
  const selectRef = useRef(onSelectStop);
  const markersRef = useRef<Map<string, google.maps.Marker> | null>(null);

  useEffect(() => {
    progressRef.current = onProgress;
    selectRef.current = onSelectStop;
  });

  useEffect(() => {
    if (!map) return;

    const bounds = new google.maps.LatLngBounds();
    ROUTE.forEach((point) => bounds.extend(point));
    map.fitBounds(bounds, { top: 64, right: 56, bottom: 96, left: 56 });

    const ghost = new google.maps.Polyline({
      path: ROUTE,
      map,
      strokeColor: '#2b3446',
      strokeOpacity: 1,
      strokeWeight: 5,
    });

    const trail = new google.maps.Polyline({
      path: [ROUTE[0]],
      map,
      strokeColor: '#00e599',
      strokeOpacity: 1,
      strokeWeight: 5,
    });

    // Stops are the interactive part: each is a target you can open.
    const stopMarkers = new window.Map<string, google.maps.Marker>();
    STOPS.forEach((stop) => {
      const marker = new google.maps.Marker({
        position: stop.position,
        map,
        title: `${stop.name}: open street view`,
        cursor: 'pointer',
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 9,
          fillColor: '#ffb95f',
          fillOpacity: 0.95,
          strokeColor: '#0b0e13',
          strokeWeight: 3,
        },
        zIndex: 15,
      });
      marker.addListener('click', () => selectRef.current(stop));
      stopMarkers.set(stop.id, marker);
    });
    markersRef.current = stopMarkers;

    const carBody = new google.maps.Marker({
      position: ROUTE[0],
      map,
      icon: {
        path: CAR_BODY_PATH,
        scale: 0.95,
        fillColor: '#ffffff',
        fillOpacity: 1,
        strokeColor: '#00e599',
        strokeWeight: 2,
        rotation: 0,
      },
      zIndex: 20,
    });

    const carGlass = new google.maps.Marker({
      position: ROUTE[0],
      map,
      icon: {
        path: CAR_GLASS_PATH,
        scale: 0.95,
        fillColor: '#0b1410',
        fillOpacity: 0.92,
        strokeWeight: 0,
        rotation: 0,
      },
      // Above the body, and never intercepting the click meant for a stop.
      zIndex: 21,
      clickable: false,
    });

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const state = { value: reduceMotion ? 1 : 0 };

    const paint = () => {
      const fraction = state.value;
      const head = pointAt(fraction);
      const covered = ROUTE.filter((_, i) => i / (ROUTE.length - 1) <= fraction);
      trail.setPath([...covered, head]);

      // Aim the car at where it is about to be, so it turns into corners
      // rather than snapping after them.
      const ahead = pointAt(Math.min(1, fraction + 0.012));
      const heading = bearingBetween(head, ahead);

      [carBody, carGlass].forEach((marker) => {
        marker.setPosition(head);
        const icon = marker.getIcon() as google.maps.Symbol;
        marker.setIcon({ ...icon, rotation: heading });
      });

      progressRef.current(fraction);
    };

    paint();

    let tween: gsap.core.Tween | null = null;
    if (!reduceMotion) {
      gsap.registerPlugin(ScrollTrigger);
      tween = gsap.to(state, {
        value: 1,
        ease: 'none',
        scrollTrigger: {
          trigger: map.getDiv(),
          start: 'top 78%',
          end: 'bottom 55%',
          scrub: 0.7,
        },
        onUpdate: paint,
      });
    }

    return () => {
      tween?.scrollTrigger?.kill();
      tween?.kill();
      ghost.setMap(null);
      trail.setMap(null);
      carBody.setMap(null);
      carGlass.setMap(null);
      stopMarkers.forEach((marker) => {
        google.maps.event.clearInstanceListeners(marker);
        marker.setMap(null);
      });
      markersRef.current = null;
    };
  }, [map]);

  // Selection is reflected on the map itself, not only in the list.
  useEffect(() => {
    markersRef.current?.forEach((marker, id) => {
      const active = id === selectedStopId;
      marker.setIcon({
        path: google.maps.SymbolPath.CIRCLE,
        scale: active ? 12 : 9,
        fillColor: active ? '#00e599' : '#ffb95f',
        fillOpacity: 0.95,
        strokeColor: '#0b0e13',
        strokeWeight: 3,
      });
    });
  }, [selectedStopId]);

  return null;
}

/**
 * A close look at where the vehicle actually sat.
 *
 * Satellite rather than Street View: Google's car has driven very little of
 * Nigeria, so a panorama request outside the main corridors returns nothing
 * and the visitor gets a black rectangle. Imagery from above exists
 * everywhere, and for "where did my vehicle stop for fourteen minutes" it is
 * the more useful picture anyway. Street View is offered only when coverage
 * genuinely exists.
 */
function StopView({ stop }: { stop: Stop }) {
  const mount = useRef<HTMLDivElement>(null);
  const [panoId, setPanoId] = useState<string | null>(null);
  const [mode, setMode] = useState<'satellite' | 'street'>('satellite');

  useEffect(() => {
    if (typeof google === 'undefined') return;

    let cancelled = false;
    new google.maps.StreetViewService()
      .getPanorama({ location: stop.position, radius: 120 })
      .then((result) => {
        const id = result.data.location?.pano;
        if (!cancelled && id) setPanoId(id);
      })
      .catch(() => {
        // Expected across most of the country, so it is not an error state.
      });

    return () => {
      cancelled = true;
    };
  }, [stop]);

  useEffect(() => {
    const container = mount.current;
    if (!container || typeof google === 'undefined') return;

    if (mode === 'street' && panoId) {
      const panorama = new google.maps.StreetViewPanorama(container, {
        pano: panoId,
        pov: { heading: 30, pitch: 0 },
        addressControl: false,
        fullscreenControl: false,
        motionTracking: false,
        motionTrackingControl: false,
        linksControl: false,
        panControl: false,
        zoomControl: false,
        enableCloseButton: false,
      });
      return () => {
        panorama.setVisible(false);
        container.innerHTML = '';
      };
    }

    const map = new google.maps.Map(container, {
      center: stop.position,
      zoom: 18,
      mapTypeId: google.maps.MapTypeId.HYBRID,
      disableDefaultUI: true,
      gestureHandling: 'cooperative',
    });

    // A ring rather than a pin, so the imagery underneath stays readable.
    const marker = new google.maps.Marker({
      position: stop.position,
      map,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 12,
        fillColor: '#00e599',
        fillOpacity: 0.18,
        strokeColor: '#00e599',
        strokeWeight: 2.5,
      },
    });

    return () => {
      marker.setMap(null);
      container.innerHTML = '';
    };
  }, [stop, mode, panoId]);

  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${stop.position.lat},${stop.position.lng}`;

  return (
    <div className="fs-pano">
      <div className="fs-pano__frame" ref={mount} />

      {panoId && (
        <div className="fs-pano__modes">
          {(['satellite', 'street'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className="fs-pano__mode"
              aria-pressed={mode === option}
              onClick={() => setMode(option)}
            >
              {option === 'satellite' ? 'Satellite' : 'Street view'}
            </button>
          ))}
        </div>
      )}

      <div className="fs-pano__bar">
        <span>
          <strong>{stop.name}</strong>{' '}
          <span style={{ color: '#7d8697' }}>
            {stop.arrived} · {stop.minutes > 0 ? `${stop.minutes} min stop` : 'trip start'} ·{' '}
            {stop.idleLiters.toFixed(1)} L idling
          </span>
        </span>
        <a className="fs-pano__link" href={mapsUrl} target="_blank" rel="noopener noreferrer">
          Open in Google Maps
        </a>
      </div>
    </div>
  );
}

export function LiveMapDemo() {
  const [fraction, setFraction] = useState(0);
  const [selected, setSelected] = useState<Stop | null>(null);

  const selectStop = useCallback((stop: Stop) => setSelected(stop), []);

  if (!FLEET_MAPS_KEY) return <GnssTrace />;

  const litersLeft = START_LITERS - USED_LITERS * fraction;
  const km = TOTAL_KM * fraction;
  const spend = Math.round(USED_LITERS * fraction * PRICE_PER_LITER);

  return (
    <div className="fs-trace">
      <div className="fs-trace__map">
        <div className="fs-mapframe">
          <APIProvider apiKey={FLEET_MAPS_KEY}>
            <Map
              defaultCenter={ROUTE[5]}
              defaultZoom={12}
              disableDefaultUI
              gestureHandling="cooperative"
              styles={FLEET_DARK_MAP_STYLES}
              style={{ width: '100%', height: '100%' }}
            >
              <TripLayer
                onProgress={setFraction}
                onSelectStop={selectStop}
                selectedStopId={selected?.id ?? null}
              />
            </Map>
          </APIProvider>

          <div className="fs-mapbadge">
            <span className="fs-live">
              <span className="fs-live__dot" aria-hidden />
              LIVE-FMC150
            </span>
            <span className="fs-mapbadge__sub">Toyota RAV4 · Benneth · Abuja</span>
          </div>
        </div>

        <div className="fs-stops">
          {STOPS.map((stop) => (
            <button
              key={stop.id}
              type="button"
              className="fs-stopbtn"
              aria-pressed={selected?.id === stop.id}
              onClick={() => setSelected(stop)}
            >
              <span className="fs-stopbtn__name">{stop.name}</span>
              <span className="fs-stopbtn__meta">
                {stop.arrived} · {stop.minutes > 0 ? `${stop.minutes} min` : 'departed'} ·{' '}
                {stop.idleLiters.toFixed(1)} L
              </span>
              <span className="fs-stopbtn__cue">
                {selected?.id === stop.id ? 'Showing' : 'Click to see the spot'}
              </span>
            </button>
          ))}
        </div>

        {selected && <StopView key={selected.id} stop={selected} />}
      </div>

      <aside className="fs-trace__gauge">
        <p className="fs-trace__gaugelabel">Virtual tank</p>
        <SloshTank fillFraction={litersLeft / START_LITERS} />
        <p className="fs-trace__reading">{litersLeft.toFixed(1)} L</p>

        <p className="fs-trace__gaugelabel" style={{ marginTop: '1.25rem' }}>
          Distance
        </p>
        <p className="fs-trace__reading">{km.toFixed(1)} km</p>

        <p className="fs-trace__gaugelabel" style={{ marginTop: '1.25rem' }}>
          Burn rate
        </p>
        <p className="fs-trace__reading">
          {fraction > 0.02 ? ((USED_LITERS * fraction) / Math.max(km, 0.1) * 100).toFixed(1) : '0.0'} L/100km
        </p>

        <p className="fs-trace__gaugelabel" style={{ marginTop: '1.25rem' }}>
          Fuel spent
        </p>
        <p className="fs-trace__reading">₦{spend.toLocaleString('en-NG')}</p>
      </aside>
    </div>
  );
}
