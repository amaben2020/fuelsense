import type { FleetVehicle, TrackPoint, VehicleTrack } from './api';
import { car3dSvgDataUrl, ROUTE_PRIMARY } from './fleet-map-theme';

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
  return car3dSvgDataUrl(heading, selected, color || ROUTE_PRIMARY);
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

const LAGOS_ANCHORS = [
  { lat: 6.5244, lng: 3.3792 },
  { lat: 6.6018, lng: 3.3515 },
  { lat: 6.4474, lng: 3.4738 },
  { lat: 6.5789, lng: 3.2802 },
  { lat: 6.4969, lng: 3.3346 },
];

/** Client-side fallback when /tracks returns empty (offline demo). */
export function buildDemoTracksFromFleet(fleet: FleetVehicle[]): VehicleTrack[] {
  const points: TrackPoint[] = [];

  fleet.forEach((vehicle, index) => {
    const anchor = LAGOS_ANCHORS[index % LAGOS_ANCHORS.length];
    const baseLat = parseCoord(vehicle.latitude) ?? anchor.lat;
    const baseLng = parseCoord(vehicle.longitude) ?? anchor.lng;
    let lat = baseLat;
    let lng = baseLng;
    const steps = 24;

    for (let step = 0; step <= steps; step += 1) {
      if (step > 0) {
        lat += (Math.random() - 0.5) * 0.008;
        lng += (Math.random() - 0.5) * 0.008;
      }
      points.push({
        vehicle_id: vehicle.id,
        imei: vehicle.imei ?? `demo-${index}`,
        license_plate: vehicle.license_plate,
        make: vehicle.make,
        model: vehicle.model,
        driver_name: vehicle.driver_name ?? null,
        latitude: lat,
        longitude: lng,
        speed_kph: step === steps ? vehicle.speed_kph ?? 45 : 40 + Math.random() * 20,
        fuel_level_liters: vehicle.fuel_level_liters,
        ignition_on: true,
        recorded_at: new Date(Date.now() - (steps - step) * 240000).toISOString(),
      });
    }
  });

  return buildVehicleTracks(points);
}
