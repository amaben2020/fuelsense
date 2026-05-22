import type { TrackPoint, VehicleTrack } from './api';

export function parseCoord(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function bearingDeg(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export const ROUTE_COLORS = [
  '#2e5bff',
  '#4edea3',
  '#ffb95f',
  '#b8c3ff',
  '#ff6b9d',
  '#00d4ff',
  '#c084fc',
];

export function routeColor(index: number) {
  return ROUTE_COLORS[index % ROUTE_COLORS.length];
}

export function carSvgDataUrl(color: string, heading: number, selected: boolean) {
  const size = selected ? 52 : 44;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48">
    <g transform="rotate(${heading} 24 24)">
      <ellipse cx="24" cy="30" rx="10" ry="4" fill="rgba(0,0,0,0.35)"/>
      <path d="M18 14h12c2 0 3.5 1.2 4 3l2 8c.5 2-.5 4-2.5 4h-15c-2 0-3-2-2.5-4l2-8c.5-1.8 2-3 4-3z" fill="${color}" stroke="#fff" stroke-width="1.5"/>
      <path d="M20 14v-3c0-1 .8-2 2-2h4c1.2 0 2 1 2 2v3" fill="#1a1f33" opacity="0.5"/>
      <rect x="19" y="18" width="4" height="6" rx="1" fill="#dae2fd" opacity="0.9"/>
      <rect x="25" y="18" width="4" height="6" rx="1" fill="#dae2fd" opacity="0.9"/>
      <circle cx="17" cy="26" r="2.5" fill="#0b1326"/>
      <circle cx="31" cy="26" r="2.5" fill="#0b1326"/>
    </g>
  </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export function buildVehicleTracks(points: TrackPoint[], colorOffset = 0): VehicleTrack[] {
  const byVehicle = new Map<string, TrackPoint[]>();

  for (const point of points) {
    const lat = parseCoord(point.latitude);
    const lng = parseCoord(point.longitude);
    if (lat == null || lng == null) continue;
    const list = byVehicle.get(point.vehicle_id) ?? [];
    list.push(point);
    byVehicle.set(point.vehicle_id, list);
  }

  const tracks: VehicleTrack[] = [];
  let colorIndex = colorOffset;

  for (const [, vehiclePoints] of byVehicle) {
    const path = vehiclePoints
      .map((p) => {
        const lat = parseCoord(p.latitude);
        const lng = parseCoord(p.longitude);
        return lat != null && lng != null ? { lat, lng } : null;
      })
      .filter(Boolean) as { lat: number; lng: number }[];

    if (path.length === 0) continue;

    const last = path[path.length - 1];
    const prev = path.length > 1 ? path[path.length - 2] : path[0];
    const lastPoint = vehiclePoints[vehiclePoints.length - 1];

    tracks.push({
      vehicleId: lastPoint.vehicle_id,
      licensePlate: lastPoint.license_plate,
      driverName: lastPoint.driver_name,
      make: lastPoint.make,
      model: lastPoint.model,
      color: routeColor(colorIndex++),
      path,
      heading: bearingDeg(prev.lat, prev.lng, last.lat, last.lng),
      current: {
        lat: last.lat,
        lng: last.lng,
        speedKph: lastPoint.speed_kph,
        fuelLiters:
          lastPoint.fuel_level_liters != null
            ? Number(lastPoint.fuel_level_liters)
            : null,
      },
    });
  }

  return tracks.sort((a, b) => a.licensePlate.localeCompare(b.licensePlate));
}
