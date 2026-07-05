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
  latitude?: string | number | null;
  longitude?: string | number | null;
  fuel_level_liters?: string | number | null;
  fuel_drop_liters?: string | number | null;
  estimated_loss_ngn?: number | null;
  created_at: string;
}

export interface DashboardSummary {
  period_days: number;
  currency: 'NGN';
  price_per_liter_ngn: number;
  total_vehicles: number;
  online_vehicles: number;
  total_fuel_liters: number;
  low_fuel_vehicles: number;
  total_distance_km: number;
  total_fuel_used_liters: number;
  avg_efficiency_km_l: number | null;
  avg_efficiency_l_100km?: number | null;
  total_fuel_cost_ngn: number;
  active_alerts: number;
  theft_alerts: number;
  estimated_theft_loss_ngn: number;
}

export interface EstimatedConsumptionRow {
  vehicle_id: string;
  license_plate: string;
  model: string | null;
  driver_name: string | null;
  distance_km: number;
  efficiency_km_l: number;
  efficiency_mpg: number | null;
  estimated_fuel_liters: number;
  estimated_cost_ngn: number;
}

export interface EstimatedConsumptionTotals {
  distance_km: number;
  estimated_fuel_liters: number;
  estimated_cost_ngn: number;
}

export interface EstimatedConsumptionDay {
  date: string;
  vehicles: EstimatedConsumptionRow[];
  totals: EstimatedConsumptionTotals;
}

export interface EstimatedConsumptionResponse {
  period_days: number;
  price_per_liter_ngn: number;
  basis: string;
  vehicles: EstimatedConsumptionRow[];
  daily: EstimatedConsumptionDay[];
  totals: EstimatedConsumptionTotals;
}

export interface FuelAnomaly {
  id: string;
  vehicle_id?: string | null;
  vehicle_plate?: string | null;
  type: 'theft' | 'fraud' | 'idle' | 'driving' | 'efficiency' | 'route';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  details: string;
  liters_lost?: number;
  amount_lost_ngn?: number;
  timestamp: string;
  latitude?: string | number | null;
  longitude?: string | number | null;
  acknowledged: boolean;
}

export interface FleetEfficiency {
  vehicle_id: string;
  license_plate: string;
  driver_name?: string | null;
  model?: string | null;
  tank_capacity_liters: number | null;
  distance_km: number;
  fuel_used_liters: number;
  efficiency_km_l: number | null;
  efficiency_l_100km: number | null;
  expected_efficiency_km_l: number;
  expected_efficiency_l_100km: number;
  variance_percent: number | null;
  tank_distance_km?: number;
  tank_fuel_used_liters?: number;
  tank_efficiency_km_l?: number | null;
  tank_efficiency_l_100km?: number | null;
  tank_variance_percent?: number | null;
  expected_fuel_liters?: number;
  expected_cost_ngn: number;
  actual_cost_ngn: number;
  fuel_cost_ngn: number;
  savings_ngn: number;
  total_loss_ngn: number;
  efficiency_loss_ngn: number;
  theft_loss_ngn: number;
  receipt_fraud_loss_ngn?: number;
  alert_theft_loss_ngn?: number;
  co2_emissions_kg: number;
  status: 'verified' | 'theft_alert' | 'underperforming';
  period_days: number;
  price_per_liter_ngn?: number;
  last_purchase_at?: string | null;
  last_fuel_added_liters?: number | null;
  last_receipt_liters?: number | null;
  last_purchase_merchant?: string | null;
  distance_since_purchase_km?: number;
  fuel_since_purchase_liters?: number;
}

export interface FleetEfficiencySummary {
  total_distance_km: number;
  total_fuel_used_liters: number;
  total_expected_cost_ngn: number;
  total_actual_cost_ngn: number;
  total_telemetry_cost_ngn?: number;
  total_loss_ngn: number;
  total_savings_ngn: number;
  total_theft_loss_ngn: number;
  total_efficiency_loss_ngn: number;
  recoverable_ngn: number;
  price_per_liter_ngn: number;
  period_days: number;
}

export interface FleetEfficiencyResponse {
  summary: FleetEfficiencySummary;
  vehicles: FleetEfficiency[];
}

export type DailyActivityStatus =
  | 'normal'
  | 'low_efficiency'
  | 'high_usage'
  | 'data_anomaly'
  | 'unknown';

export type DailyFlagType =
  | 'low_efficiency'
  | 'high_fuel_per_km'
  | 'high_distance'
  | 'low_distance_use'
  | 'data_anomaly';

export interface DailyActivityFlagRow {
  id: string;
  vehicle_id: string;
  license_plate: string;
  driver_name: string | null;
  activity_date: string;
  flag_type: DailyFlagType;
  flag_label: string;
  severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
  reason: string;
  impact: string;
  suggestion: string;
}

export interface DailyActivityRow {
  vehicle_id: string;
  license_plate: string;
  driver_name: string | null;
  model: string | null;
  activity_date: string;
  activity_date_display: string;
  distance_km: number;
  fuel_used_liters: number;
  efficiency_l_100km: number | null;
  raw_efficiency_l_100km?: number | null;
  expected_efficiency_l_100km: number;
  expected_efficiency_km_l?: number;
  efficiency_deviation_percent: number | null;
  status: DailyActivityStatus;
  status_label: string;
  status_severity: string;
  data_anomaly: boolean;
  insight: string;
  expected_distance_min_km: number;
  expected_distance_max_km: number;
  expected_distance_km: number;
  idle_hours: number;
  trip_count: number;
}

export interface DailyActivityResponse {
  period_days: number;
  page: number;
  limit: number;
  total: number;
  total_pages: number;
  efficiency_tiers: Array<{
    status: string;
    label: string;
    severity: string;
    max_deviation_percent: number;
  }>;
  efficiency_variance_threshold_percent: number;
  daily_distance_by_model: Record<string, { min: number; max: number; expected: number }>;
  rows: DailyActivityRow[];
  active_flags: DailyActivityFlagRow[];
}

export interface SiphonEventRow {
  id: string;
  vehicle_id: string;
  vehicle_plate: string;
  driver_name: string | null;
  occurred_at: string;
  liters_stolen: number;
  estimated_loss_ngn: number;
  location_name: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
  status: string;
  evidence: {
    fuel_level_before: number;
    fuel_level_after: number;
    engine_state_before: boolean | null;
    engine_state_after: boolean | null;
    parked_duration_minutes: number | null;
  };
}

export interface ReceiptFlagRow {
  id: string;
  vehicle_plate: string;
  driver_name: string | null;
  merchant_name: string | null;
  transaction_date: string;
  declared_liters: number;
  obd_actual_liters: number | null;
  difference_liters: number | null;
  estimated_loss_ngn: number;
  status: string;
  receipt_photo_url: string | null;
}

export interface FuelEventsResponse {
  total_preventable_loss_ngn: number;
  siphon_events: SiphonEventRow[];
  receipt_flags: ReceiptFlagRow[];
}

export interface EventReplayMoment {
  index: number;
  type: 'fuel_drop' | 'fuel_rise' | 'anomaly' | 'idle_start' | 'trip_start';
  recorded_at: string;
  fuel_drop_liters?: number;
  fuel_rise_liters?: number;
  fuel_before?: number | null;
  fuel_after?: number | null;
  latitude: number | null;
  longitude: number | null;
  speed_kph?: number;
  ignition_on?: boolean;
  label: string;
}

export interface EventReplayReading {
  recorded_at: string;
  fuel_level_liters: number | null;
  speed_kph: number;
  ignition_on: boolean;
  latitude: number | null;
  longitude: number | null;
  odometer_km: number | null;
}

export interface EventReplayResponse {
  event_type: 'siphon' | 'receipt_fraud' | 'daily_flag' | 'low_efficiency' | 'data_anomaly';
  vehicle_plate: string;
  driver_name: string | null;
  vehicle_id: string;
  range_start: string;
  range_end: string;
  anomaly_at: string;
  anomaly_index: number;
  location_name: string | null;
  readings: EventReplayReading[];
  moments: EventReplayMoment[];
  anomaly_moment: EventReplayMoment | null;
  anomaly: {
    type: string;
    liters_lost: number;
    estimated_loss_ngn: number;
    confidence_percent: number;
    reasons: string[];
    declared_liters?: number;
    obd_liters_actual?: number | null;
    primary_explanation?: string;
    why_flagged?: string[];
    confidence_factors?: string[];
    recommended_actions?: string[];
    baseline_comparison?: {
      normal_label: string;
      normal_range: string;
      observed_label: string;
      observed_value: string;
    };
    certainty_timeline?: { time: string; percent: number }[];
  };
}

export interface Driver {
  id: string;
  full_name: string;
  phone: string | null;
  license_number: string | null;
  status: string;
  vehicle_id: string | null;
  license_plate: string | null;
  created_at: string;
}

export interface FuelPurchaseTimeline {
  purchased_at: string | null;
  obd_refuel_detected_at: string | null;
  ignition_on_at: string | null;
  purchase_to_obd_minutes: number | null;
  obd_to_ignition_minutes: number | null;
  purchase_to_ignition_minutes: number | null;
}

export interface FuelPurchaseEventStep {
  key: 'purchase' | 'obd' | 'ignition';
  label: string;
  at: string;
  source: string;
  detail: string;
  minutes_after_previous: number | null;
  note: string | null;
}

export interface FuelPurchaseEventAssessment {
  chronological_timeline: FuelPurchaseEventStep[];
  expected_sequence: string;
  theft_probability: number;
  verdict: 'verified' | 'review' | 'suspicious' | 'likely_theft';
  summary: string;
  reasons: string[];
  signals: Array<{ code: string; weight: number; message: string }>;
  estimated_loss_ngn: number;
  license_plate: string | null;
  liters_declared: number;
  liters_actual: number | null;
  difference_liters: number | null;
}

export interface FuelPurchase {
  id: string;
  vehicle_id: string;
  license_plate: string;
  driver_name?: string | null;
  timestamp: string;
  purchased_at?: string;
  obd_refuel_detected_at?: string | null;
  ignition_on_at?: string | null;
  timeline?: FuelPurchaseTimeline;
  event_assessment?: FuelPurchaseEventAssessment;
  liters_declared: number;
  liters_actual: number | null;
  difference_liters: number;
  cost_per_liter_ngn: number;
  total_cost_ngn: number;
  odometer_km?: number | null;
  merchant: string;
  receipt_reference?: string | null;
  status: 'verified' | 'flagged_theft' | 'pending_receipt';
  actual_from?: string;
}

export interface FuelPurchaseDailyTotal {
  activity_date: string;
  driver_name: string;
  receipt_count: number;
  total_cost_ngn: number;
  total_receipt_liters: number;
  total_obd_liters: number;
}

export interface FuelPurchaseSummary {
  daily_totals: FuelPurchaseDailyTotal[];
  grand_total: {
    receipt_count: number;
    total_cost_ngn: number;
    total_receipt_liters: number;
    total_obd_liters: number;
  };
}

export interface FuelPurchasesResponse {
  source: 'database' | 'empty' | 'telemetry' | 'demo';
  page: number;
  limit: number;
  total: number;
  total_pages: number;
  purchases: FuelPurchase[];
  summary?: FuelPurchaseSummary;
  note?: string;
}

export interface TelemetryReading {
  id: string;
  vehicle_id: string;
  license_plate: string;
  driver_name: string | null;
  recorded_at: string;
  fuel_level_liters: string | number | null;
  odometer_km: string | number | null;
  speed_kph: number | null;
  ignition_on: boolean | null;
  latitude: string | number | null;
  longitude: string | number | null;
}

export interface TelemetryReadingsResponse {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
  rows: TelemetryReading[];
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
  tripDistanceKm: number;
  current: {
    lat: number;
    lng: number;
    speedKph: number | null;
    fuelLiters: number | null;
    ignitionOn: boolean | null;
    recordedAt: string;
  };
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
  const theftLossNgn = alerts
    .filter((a) => a.alert_type === 'fuel_theft')
    .reduce((sum, a) => sum + (Number(a.estimated_loss_ngn) || 0), 0);

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

/** Always NGN — never use $ or other currencies in the UI */
export function formatFuelPricePerLiter(amount: number) {
  return `${formatNgn(amount)}/L`;
}
