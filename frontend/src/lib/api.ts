const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
const TOKEN_KEY = 'fuelsense_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function isAuthenticated(): boolean {
  return !!getToken();
}

interface ApiOptions extends RequestInit {
  auth?: boolean;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (options.auth !== false) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }

  return data as T;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  company_name?: string | null;
  subscription_status: string;
  onboarding_completed?: boolean;
  created_at: string;
}

export interface AuthResponse {
  token: string;
  customer: Customer;
}

export interface Vehicle {
  id: string;
  customer_id: string;
  license_plate: string;
  make: string | null;
  model: string | null;
  year: number | null;
  tank_capacity_liters?: number | null;
  created_at: string;
}

export interface FleetVehicle {
  id: string;
  license_plate: string;
  make: string | null;
  model: string | null;
  year: number | null;
  tank_capacity_liters: number | null;
  driver_name?: string | null;
  imei: string | null;
  device_model: string | null;
  last_seen_at: string | null;
  device_active: boolean | null;
  fuel_level_liters: number | null;
  odometer_km: number | null;
  ignition_on: boolean | null;
  latitude: string | number | null;
  longitude: string | number | null;
  speed_kph: number | null;
  last_telemetry_at: string | null;
  connection_status: 'online' | 'offline' | 'no_device';
}

export function fleetMetrics(fleet: FleetVehicle[]) {
  const withFuel = fleet.filter((v) => v.fuel_level_liters != null);
  const online = fleet.filter((v) => v.connection_status === 'online').length;
  const offline = fleet.filter((v) => v.connection_status === 'offline').length;
  const onMap = fleet.filter(
    (v) => v.latitude != null && v.longitude != null
  ).length;
  const totalFuel = withFuel.reduce(
    (sum, v) => sum + Number(v.fuel_level_liters),
    0
  );
  const lowFuel = withFuel.filter((v) => Number(v.fuel_level_liters) < 20).length;

  return {
    total: fleet.length,
    online,
    offline,
    onMap,
    totalFuel,
    avgFuel: withFuel.length ? totalFuel / withFuel.length : null,
    lowFuel,
  };
}

export interface Device {
  imei: string;
  vehicle_id: string;
  customer_id: string;
  device_model?: string;
  is_active: boolean;
  installed_at: string;
  last_seen_at: string | null;
  license_plate?: string;
  make?: string;
  model?: string;
}

export interface Alert {
  id: number;
  alert_type: string;
  message: string;
  license_plate?: string;
  vehicle_id?: string;
  created_at: string;
}

export interface FleetEfficiency {
  vehicle_id: string;
  license_plate: string;
  tank_capacity_liters: number | null;
  distance_km: number;
  fuel_used_liters: number;
  efficiency_km_l: number | null;
  fuel_cost_ngn: number;
  co2_emissions_kg: number;
  period_days: number;
}

export interface TrackPoint {
  vehicle_id: string;
  imei: string;
  license_plate: string;
  make: string | null;
  model: string | null;
  driver_name: string | null;
  latitude: string | number;
  longitude: string | number;
  speed_kph: number | null;
  fuel_level_liters: string | number | null;
  ignition_on: boolean | null;
  recorded_at: string;
}

export interface VehicleTrack {
  vehicleId: string;
  licensePlate: string;
  driverName: string | null;
  make: string | null;
  model: string | null;
  color: string;
  path: { lat: number; lng: number }[];
  heading: number;
  current: { lat: number; lng: number; speedKph: number | null; fuelLiters: number | null };
}

export type VehicleDisplayStatus = 'online' | 'idle' | 'offline' | 'no_device';

export function fuelPercent(row: FleetVehicle): number | null {
  if (row.fuel_level_liters == null || !row.tank_capacity_liters) return null;
  return Math.round(
    (Number(row.fuel_level_liters) / row.tank_capacity_liters) * 100
  );
}

export function vehicleDisplayStatus(row: FleetVehicle): VehicleDisplayStatus {
  if (row.connection_status === 'no_device') return 'no_device';
  if (row.connection_status === 'offline') return 'offline';
  if (row.ignition_on === false && (row.speed_kph == null || row.speed_kph === 0)) {
    return 'idle';
  }
  return 'online';
}

export function computeDashboardStats(
  fleet: FleetVehicle[],
  alerts: Alert[],
  efficiency: FleetEfficiency[]
) {
  const metrics = fleetMetrics(fleet);
  const totalFuelCost = efficiency.reduce((s, e) => s + e.fuel_cost_ngn, 0);
  const totalDistance = efficiency.reduce((s, e) => s + e.distance_km, 0);
  const effValues = efficiency
    .map((e) => e.efficiency_km_l)
    .filter((v): v is number => v != null && v > 0);
  const avgEfficiency =
    effValues.length > 0
      ? effValues.reduce((s, v) => s + v, 0) / effValues.length
      : null;
  const theftAlerts = alerts.filter((a) => a.alert_type === 'fuel_theft');
  const theftLossNgn = theftAlerts.length * 15 * 650;

  return {
    ...metrics,
    totalFuelCost,
    totalDistance,
    avgEfficiency,
    criticalAlerts: alerts.length,
    theftLossNgn,
  };
}

export interface DeviceOrder {
  id: string;
  customer_id: string;
  order_date: string;
  status: string;
  device_imeis: string[];
  quantity: number;
  total_amount_ngn: number;
  shipping_address: string | null;
  created_at: string;
}

export interface OrderCheckoutResponse {
  order: DeviceOrder;
  payment: { id: string; reference: string; amount_ngn: number; status: string };
  checkout: {
    amountNgn: number;
    quantity: number;
    pricePerTrackerNgn: number;
    message: string;
  };
}

export interface WithDeviceResponse {
  success: boolean;
  message: string;
  vehicle: Vehicle;
  imei: string;
  fleetRow: FleetVehicle | null;
}

export interface BulkVehiclesResponse {
  success: boolean;
  message: string;
  vehicles: Vehicle[];
  fleet: FleetVehicle[];
}

export const PRICE_PER_TRACKER_NGN = 120_000;

export function formatNgn(amount: number) {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 0,
  }).format(amount);
}
