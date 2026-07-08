import type { FleetVehicle, TrackPoint, TrackTrip, VehicleTrack } from './api';
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

/** Distinct colour per trip so consecutive journeys never blur together. */
export function tripColor(index: number) {
  return ROUTE_COLORS[index % ROUTE_COLORS.length];
}

export function carSvgDataUrl(color: string, heading: number, selected: boolean) {
  return car3dSvgDataUrl(heading, selected, color || ROUTE_PRIMARY);
}

// A trip ends when the vehicle sits with the ignition off (or the tracker goes
// silent) for at least this long. Shorter stops — red lights, quick errands,
// noisy ignition-wire toggles — stay inside the same trip.
export const TRIP_BREAK_MS = 30 * 60 * 1000; // 30 minutes

// Trips shorter than this are parked-GPS jitter, not journeys.
const MIN_TRIP_KM = 0.3;

/**
 * Splits a vehicle's chronological track points into trips.
 * New trip when: recording gap ≥ 30 min, or a continuous ignition-off /
 * stationary stretch ≥ 30 min.
 */
function segmentTrips(vehiclePoints: TrackPoint[]): TrackTrip[] {
  const active = (pt: TrackPoint) =>
    pt.ignition_on === true || (pt.speed_kph != null && pt.speed_kph > 0);

  const trips: TrackTrip[] = [];
  let segment: TrackPoint[] = [];
  let lastActiveAt: number | null = null;

  const closeSegment = () => {
    if (segment.length < 2) {
      segment = [];
      lastActiveAt = null;
      return;
    }
    let km = 0;
    const path: { lat: number; lng: number }[] = [];
    for (const pt of segment) {
      const lat = parseCoord(pt.latitude);
      const lng = parseCoord(pt.longitude);
      if (lat == null || lng == null) continue;
      if (path.length > 0) {
        km += haversineKm(path[path.length - 1].lat, path[path.length - 1].lng, lat, lng);
      }
      path.push({ lat, lng });
    }
    if (km >= MIN_TRIP_KM && path.length >= 2) {
      trips.push({
        path,
        distanceKm: Math.round(km * 10) / 10,
        startAt: segment[0].recorded_at,
        endAt: segment[segment.length - 1].recorded_at,
      });
    }
    segment = [];
    lastActiveAt = null;
  };

  for (let i = 0; i < vehiclePoints.length; i++) {
    const pt = vehiclePoints[i];
    const t = new Date(pt.recorded_at).getTime();

    if (segment.length > 0) {
      const prevT = new Date(segment[segment.length - 1].recorded_at).getTime();
      const recordingGap = t - prevT;
      const inactiveFor = lastActiveAt != null ? t - lastActiveAt : 0;
      if (recordingGap >= TRIP_BREAK_MS || inactiveFor >= TRIP_BREAK_MS) {
        closeSegment();
      }
    }

    if (segment.length === 0) {
      // a trip only starts once the vehicle is actually doing something
      if (!active(pt)) continue;
      lastActiveAt = t;
      segment.push(pt);
      continue;
    }

    segment.push(pt);
    if (active(pt)) lastActiveAt = t;
  }
  closeSegment();

  return trips;
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

    const trips = segmentTrips(vehiclePoints);
    const lastTrip = trips[trips.length - 1];

    tracks.push({
      vehicleId: lastPoint.vehicle_id,
      licensePlate: lastPoint.license_plate,
      driverName: lastPoint.driver_name,
      make: lastPoint.make,
      model: lastPoint.model,
      color: routeColor(colorIndex++),
      path,
      trips,
      heading: bearingDeg(prev.lat, prev.lng, last.lat, last.lng),
      tripDistanceKm: lastTrip?.distanceKm ?? 0,
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
