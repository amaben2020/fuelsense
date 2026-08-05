'use client';

import { useEffect, useRef, useState } from 'react';
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { FLEET_DARK_MAP_STYLES, FLEET_MAPS_KEY } from '@/lib/fleet-map-theme';
import { GnssTrace } from './GnssTrace';

// A real trip on a real map, scrubbed by the scroll position.
//
// The route is mock data — a drive through Abuja — but everything drawn from
// it is the genuine product behaviour: the trail builds behind the vehicle,
// the tank drains against distance, and stops are called out where the vehicle
// actually paused.

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

const MAP_CENTER = { lat: 8.9695, lng: 7.6425 };

const START_LITERS = 42;
const USED_LITERS = 3.1;
const TOTAL_KM = 30.4;

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

function TripLayer({ onProgress }: { onProgress: (fraction: number) => void }) {
  const map = useMap();
  const progressRef = useRef(onProgress);

  useEffect(() => {
    progressRef.current = onProgress;
  });

  useEffect(() => {
    if (!map) return;

    // Frame the whole journey rather than trusting a fixed centre and zoom —
    // otherwise the route sits small and off to one side.
    const bounds = new google.maps.LatLngBounds();
    ROUTE.forEach((point) => bounds.extend(point));
    map.fitBounds(bounds, { top: 64, right: 56, bottom: 64, left: 56 });

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

    const vehicle = new google.maps.Marker({
      position: ROUTE[0],
      map,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 7,
        fillColor: '#ffffff',
        fillOpacity: 1,
        strokeColor: '#00e599',
        strokeWeight: 3,
      },
      zIndex: 20,
    });

    const stop = new google.maps.Marker({
      position: ROUTE[7],
      map,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 5,
        fillColor: '#ffb95f',
        fillOpacity: 1,
        strokeColor: '#0b0e13',
        strokeWeight: 2,
      },
      title: 'Stop · 14 min, engine running',
      zIndex: 15,
    });

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const state = { value: reduceMotion ? 1 : 0 };

    const paint = () => {
      const fraction = state.value;
      const head = pointAt(fraction);
      const covered = ROUTE.filter(
        (_, i) => i / (ROUTE.length - 1) <= fraction
      );
      trail.setPath([...covered, head]);
      vehicle.setPosition(head);
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
      vehicle.setMap(null);
      stop.setMap(null);
    };
  }, [map]);

  return null;
}

export function LiveMapDemo() {
  const [fraction, setFraction] = useState(0);

  // Without a key the map would render an error tile, which is a worse first
  // impression than the drawn trace — so fall back to it.
  if (!FLEET_MAPS_KEY) return <GnssTrace />;

  const litersLeft = START_LITERS - USED_LITERS * fraction;
  const km = TOTAL_KM * fraction;
  const spend = Math.round(USED_LITERS * fraction * 1330);

  return (
    <div className="fs-trace">
      <div className="fs-trace__map">
        <div className="fs-mapframe">
          <APIProvider apiKey={FLEET_MAPS_KEY}>
            <Map
              defaultCenter={MAP_CENTER}
              defaultZoom={12}
              disableDefaultUI
              gestureHandling="cooperative"
              styles={FLEET_DARK_MAP_STYLES}
              style={{ width: '100%', height: '100%' }}
            >
              <TripLayer onProgress={setFraction} />
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

        <ol className="fs-trace__legend">
          {[
            { label: 'Ignition on', detail: '06:12 · trip opens', color: '#00e599' },
            { label: 'Moving', detail: '38 km/h · 9.4 L/100km', color: '#7d8697' },
            { label: 'Stop · 14 min', detail: 'engine running — idling', color: '#ffb95f' },
            { label: 'Ignition off', detail: '07:21 · trip closes', color: '#00e599' },
          ].map((item) => (
            <li key={item.label} className="fs-trace__legenditem">
              <span className="fs-trace__pip" style={{ background: item.color }} aria-hidden />
              <span>
                <strong>{item.label}</strong>
                <span className="fs-trace__detail">{item.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>

      <aside className="fs-trace__gauge">
        <p className="fs-trace__gaugelabel">Virtual tank</p>
        <div className="fs-trace__tube">
          <div
            className="fs-trace__fill"
            style={{ transform: `scaleY(${1 - (USED_LITERS / START_LITERS) * fraction})` }}
          />
        </div>
        <p className="fs-trace__reading">{litersLeft.toFixed(1)} L</p>

        <p className="fs-trace__gaugelabel" style={{ marginTop: '1.25rem' }}>
          Distance
        </p>
        <p className="fs-trace__reading">{km.toFixed(1)} km</p>

        <p className="fs-trace__gaugelabel" style={{ marginTop: '1.25rem' }}>
          Fuel spent
        </p>
        <p className="fs-trace__reading">₦{spend.toLocaleString('en-NG')}</p>
      </aside>
    </div>
  );
}
