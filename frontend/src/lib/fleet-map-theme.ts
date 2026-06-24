import type { CSSProperties } from 'react';

export const FLEET_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY ?? '';
export const FLEET_MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID;

export const LAGOS_CENTER = { lat: 6.5244, lng: 3.3792 };

/** Uber/Bolt-style primary route accent on dark maps */
export const ROUTE_PRIMARY = '#276EF1';
export const ROUTE_ACTIVE = '#5B9DFF';
export const ROUTE_GLOW = '#FFFFFF';
export const ROUTE_DIM = '#1A2238';

/** Muted dark basemap — roads visible, POI clutter hidden (Uber-like) */
export const FLEET_DARK_MAP_STYLES: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: '#151a28' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#5c637a' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#151a28' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  {
    featureType: 'administrative',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#252d42' }],
  },
  {
    featureType: 'landscape',
    elementType: 'geometry',
    stylers: [{ color: '#151a28' }],
  },
  {
    featureType: 'poi',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'road',
    elementType: 'geometry.fill',
    stylers: [{ color: '#242b3f' }],
  },
  {
    featureType: 'road',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#151a28' }],
  },
  {
    featureType: 'road.highway',
    elementType: 'geometry.fill',
    stylers: [{ color: '#2f3850' }],
  },
  {
    featureType: 'road.highway',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#151a28' }],
  },
  {
    featureType: 'transit',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'water',
    elementType: 'geometry',
    stylers: [{ color: '#0c101a' }],
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
    stylers: [{ color: '#7a8098' }],
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
    backgroundColor: '#151a28',
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
