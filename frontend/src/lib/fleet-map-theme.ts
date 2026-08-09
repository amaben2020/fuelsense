import type { CSSProperties } from 'react';

export const FLEET_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY ?? '';
export const FLEET_MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID;

export const LAGOS_CENTER = { lat: 6.5244, lng: 3.3792 };

/** Uber/Bolt-style primary route accent on dark maps */
export const ROUTE_PRIMARY = '#cde04a';  // lemon — matches --brand/--accent
export const ROUTE_ACTIVE = '#e3ef8c';   // brighter lemon for the selected trail
export const ROUTE_GLOW = '#FFFFFF';
export const ROUTE_DIM = '#1A2238';

/**
 * Neutral greyscale basemap. Deliberately desaturated: the palette carries a
 * single lemon accent, and a blue-tinted canvas competed with it — the route
 * line stopped reading as the one thing on the map that matters.
 */
export const FLEET_DARK_MAP_STYLES: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: '#141414' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#6b6b6b' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#141414' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  {
    featureType: 'administrative',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#2b2b2b' }],
  },
  {
    featureType: 'landscape',
    elementType: 'geometry',
    stylers: [{ color: '#141414' }],
  },
  {
    featureType: 'poi',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'road',
    elementType: 'geometry.fill',
    stylers: [{ color: '#262626' }],
  },
  {
    featureType: 'road',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#141414' }],
  },
  {
    featureType: 'road.highway',
    elementType: 'geometry.fill',
    stylers: [{ color: '#333333' }],
  },
  {
    featureType: 'road.highway',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#141414' }],
  },
  {
    featureType: 'transit',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'water',
    elementType: 'geometry',
    stylers: [{ color: '#0d0d0d' }],
  },
];

// Styles with POI business layer enabled (fuel stations, markets, etc.)
export const FLEET_DARK_MAP_STYLES_POI: google.maps.MapTypeStyle[] = [
  ...FLEET_DARK_MAP_STYLES.filter((s) => s.featureType !== 'poi'),
  // Show business POIs (includes fuel stations, markets, restaurants)
  {
    featureType: 'poi.business',
    stylers: [{ visibility: 'on' }],
  },
  {
    featureType: 'poi.business',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#828282' }],
  },
  {
    featureType: 'poi.business',
    elementType: 'labels.icon',
    stylers: [{ visibility: 'on' }],
  },
];

export function fleetMapLayerProps(showPoi = false) {
  if (FLEET_MAP_ID) {
    return {
      mapId: FLEET_MAP_ID,
      colorScheme: 'DARK' as const,
    };
  }
  return {
    styles: showPoi ? FLEET_DARK_MAP_STYLES_POI : FLEET_DARK_MAP_STYLES,
    backgroundColor: '#141414',
  };
}

export function fleetMapDefaults(overrides: Record<string, unknown> = {}, showPoi = false) {
  return {
    gestureHandling: 'greedy' as const,
    disableDefaultUI: false,
    zoomControl: true,
    scrollwheel: true,
    ...fleetMapLayerProps(showPoi),
    ...overrides,
  };
}

export function fleetMapContainerStyle(
  minHeight: number | string,
): CSSProperties {
  return {
    width: '100%',
    height: '100%',
    minHeight,
  };
}

/** Top-down 3D car marker — Uber-style white vehicle with heading rotation */
export function car3dSvgDataUrl(
  heading: number,
  selected = false,
  accent = ROUTE_PRIMARY,
) {
  const size = selected ? 56 : 48;
  const body = selected ? '#f4f6fb' : '#e6eaf2';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 56 56">
    <defs>
      <filter id="s" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="2" stdDeviation="2.2" flood-color="#000" flood-opacity="0.5"/>
      </filter>
    </defs>
    <g transform="rotate(${heading} 28 28)" filter="url(#s)">
      <ellipse cx="28" cy="36" rx="12" ry="4.5" fill="rgba(0,0,0,0.38)"/>
      <rect x="15" y="17" width="26" height="20" rx="7" fill="${body}" stroke="#94a3b8" stroke-width="1.2"/>
      <rect x="18" y="19" width="20" height="9" rx="3.5" fill="#111827" opacity="0.88"/>
      <rect x="20" y="30" width="16" height="4" rx="2" fill="#cbd5e1" opacity="0.55"/>
      <rect x="16" y="24" width="3" height="8" rx="1.5" fill="${accent}" opacity="0.95"/>
      <rect x="37" y="24" width="3" height="8" rx="1.5" fill="${accent}" opacity="0.95"/>
      <circle cx="20" cy="35" r="2" fill="#fde68a"/>
      <circle cx="36" cy="35" r="2" fill="#fde68a"/>
      <rect x="17" y="16" width="4" height="2.2" rx="1" fill="#ef4444"/>
      <rect x="35" y="16" width="4" height="2.2" rx="1" fill="#ef4444"/>
    </g>
  </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export function anomalyPinSvgDataUrl() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
    <circle cx="20" cy="20" r="16" fill="#ffb4ab" fill-opacity="0.25" stroke="#ffb4ab" stroke-width="2"/>
    <circle cx="20" cy="20" r="6" fill="#ff6b6b"/>
    <text x="20" y="24" text-anchor="middle" font-size="12" fill="#fff" font-weight="700">!</text>
  </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}
