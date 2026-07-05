import type { FleetVehicle, TrackPoint, VehicleTrack } from './api';
import { car3dSvgDataUrl, ROUTE_PRIMARY } from './fleet-map-theme';

export function parseCoord(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

export function timeAgo(isoTimestamp: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(isoTimestamp).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
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

// FMC150 IO-239 (ignition) can toggle false for 2-30 s due to alternator load spikes
// or a noisy ignition wire, while the vehicle is clearly still moving. We bridge any
// inactive gap shorter than STOP_GAP_MS before declaring a new trip segment.
const STOP_GAP_MS = 5 * 60 * 1000; // 5 minutes

function computeTripDistanceKm(vehiclePoints: TrackPoint[]): number {
  if (vehiclePoints.length === 0) return 0;

  // "active" = ignition on, or speed > 0 (catches legacy rows where speed wasn't zeroed)
  const active = (pt: TrackPoint) =>
    pt.ignition_on === true || (pt.speed_kph != null && pt.speed_kph > 0);

  // Walk forward finding the LAST continuous active segment (debounced).
  // When we see a gap >= STOP_GAP_MS of inactivity, the previous segment ends
  // and we look for the next one. The final segment is the current/last trip.
  let segStart = -1;
  let lastActiveIdx = -1;

  for (let i = 0; i < vehiclePoints.length; i++) {
    if (active(vehiclePoints[i])) {
      if (segStart === -1) segStart = i;
      lastActiveIdx = i;
    } else if (segStart !== -1) {
      const gapMs =
        new Date(vehiclePoints[i].recorded_at).getTime() -
        new Date(vehiclePoints[lastActiveIdx].recorded_at).getTime();
      if (gapMs >= STOP_GAP_MS) {
        // Genuine stop — the old segment is done; reset for the next one
        segStart = -1;
        lastActiveIdx = -1;
      }
      // gap < STOP_GAP_MS → noise or red-light stop, keep the segment open
    }
  }

  if (segStart === -1 || lastActiveIdx <= segStart) return 0;

  let km = 0;
  for (let i = segStart + 1; i <= lastActiveIdx; i++) {
    const a = vehiclePoints[i - 1];
    const b = vehiclePoints[i];
    const aLat = parseCoord(a.latitude);
    const aLng = parseCoord(a.longitude);
    const bLat = parseCoord(b.latitude);
    const bLng = parseCoord(b.longitude);
    if (aLat != null && aLng != null && bLat != null && bLng != null) {
      km += haversineKm(aLat, aLng, bLat, bLng);
    }
  }
  return Math.round(km * 10) / 10;
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

    const tripDistanceKm = computeTripDistanceKm(vehiclePoints);

    tracks.push({
      vehicleId: lastPoint.vehicle_id,
      licensePlate: lastPoint.license_plate,
      driverName: lastPoint.driver_name,
      make: lastPoint.make,
      model: lastPoint.model,
      color: routeColor(colorIndex++),
      path,
      heading: bearingDeg(prev.lat, prev.lng, last.lat, last.lng),
      tripDistanceKm: Math.round(tripDistanceKm * 10) / 10,
      current: {
        lat: last.lat,
        lng: last.lng,
        speedKph: lastPoint.speed_kph,
        fuelLiters:
          lastPoint.fuel_level_liters != null
            ? Number(lastPoint.fuel_level_liters)
            : null,
        ignitionOn: lastPoint.ignition_on,
        recordedAt: lastPoint.recorded_at,
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
