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

/**
 * Why a request failed, not just that it did.
 *
 * A bare `catch` around `fetch` cannot tell a dropped connection from a broken
 * API — both arrive as an exception — so the distinction is made here, once.
 * It matters: telling someone to check their connection when our own server is
 * down sends them to reboot a router that was never the problem.
 */
export type ApiErrorKind = 'offline' | 'network' | 'timeout' | 'server' | 'request';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;

  /** Where it failed. Diagnostic only — never rendered to a user. */
  readonly detail: string | null;

  constructor(
    kind: ApiErrorKind,
    message: string,
    status: number | null = null,
    detail: string | null = null
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }

  /** Worth trying again on its own — a 400 never is. */
  get retryable(): boolean {
    return this.kind !== 'request';
  }
}

/**
 * One sentence: what happened, then what to do. `subject` names the thing that
 * failed to load ("receipts", "the fleet") so the message says which panel is
 * broken rather than making the user guess.
 */
export function apiErrorMessage(error: unknown, subject = 'this data'): string {
  if (!(error instanceof ApiError)) {
    return `Couldn't load ${subject}. Retry, or try again shortly.`;
  }

  switch (error.kind) {
    case 'offline':
      return `Couldn't load ${subject} — your device is offline. Reconnect and retry.`;
    case 'network':
      return `Couldn't reach the server. Check your connection, then retry.`;
    case 'timeout':
      return `Loading ${subject} is taking longer than expected. Retry.`;
    case 'server':
      return `Couldn't load ${subject} — the server had a problem. Retry, or try again shortly.`;
    case 'request':
      // 4xx carries a real explanation from the API; a generic line would
      // throw away the only useful thing about it.
      return error.message;
  }
}

const REQUEST_TIMEOUT_MS = 20_000;
/** Silent attempts before a banner is ever shown — most blips clear in one. */
const RETRY_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 400;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt<T>(path: string, options: ApiOptions): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (options.auth !== false) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  // A request that hangs forever reads to a user as a frozen page, so it is
  // given a deadline and reported as a timeout rather than never resolving.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers,
      signal: options.signal ?? controller.signal,
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new ApiError(
        'timeout',
        'This is taking longer than expected. Retry.',
        null,
        path
      );
    }
    // `fetch` rejects with a TypeError for DNS failures, refused connections,
    // CORS rejections and dropped networks alike — the browser deliberately
    // does not say which. `navigator.onLine` separates the one case it can.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new ApiError(
        'offline',
        'Your device is offline. Reconnect, then retry.',
        null,
        API_URL
      );
    }
    throw new ApiError(
      'network',
      "Couldn't reach the server. Check your connection, then retry.",
      null,
      API_URL
    );
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    // A dead/rotated JWT makes every panel error out — clear it and send the
    // user through login once instead.
    if (response.status === 401 && options.auth !== false && typeof window !== 'undefined') {
      clearToken();
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }

    const kind: ApiErrorKind = response.status >= 500 ? 'server' : 'request';
    throw new ApiError(
      kind,
      data.error || `Request failed (${response.status})`,
      response.status
    );
  }

  return data as T;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  // Only reads are retried. Replaying a POST could log the same receipt twice.
  const method = (options.method ?? 'GET').toUpperCase();
  const canRetry = method === 'GET' || method === 'HEAD';

  let lastError: unknown;

  for (let i = 0; i <= (canRetry ? RETRY_ATTEMPTS : 0); i += 1) {
    try {
      return await attempt<T>(path, options);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ApiError ? error.retryable : false;
      if (!retryable || i === RETRY_ATTEMPTS) break;
      // Backoff, so a server that is struggling is not hammered by every
      // panel on the dashboard at once.
      await sleep(RETRY_BASE_DELAY_MS * 2 ** i);
    }
  }

  throw lastError;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  company_name?: string | null;
  /** White-label branding; null falls back to the FuelSense mark. */
  logo_url?: string | null;
  brand_color?: string | null;
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
  fuel_source?: 'CAN' | 'OBD%' | 'virtual' | 'none' | null;
  fuel_rate_lph?: number | string | null;
  /** Distance the tracker has counted since it was fitted (AVL 16). */
  odometer_km: number | null;
  /** True vehicle mileage — null until a dashboard baseline is anchored. */
  total_odometer_km?: number | null;
  odometer_baseline_km?: number | null;
  odometer_baseline_at?: string | null;
  ignition_on: boolean | null;
  latitude: string | number | null;
  longitude: string | number | null;
  /** Set when latitude/longitude come from an older fix because the newest
   * telemetry had no satellite lock (vehicle parked indoors/underground). */
  gps_stale?: boolean | null;
  last_gps_fix_at?: string | null;
  speed_kph: number | null;
  last_telemetry_at: string | null;
  connection_status: 'online' | 'offline' | 'no_device';
  virtual_tank_capacity_liters?: number | string | null;
  virtual_tank_liters?: number | string | null;
  virtual_tank_confidence?: number | null;
  virtual_tank_calibrated_at?: string | null;
  learned_idle_lph?: number | string | null;
}

export interface VirtualTank {
  vehicle_id: string;
  capacity_liters: number;
  level_liters: number;
  level_percent: number | null;
  confidence: number;
  calibrated_at: string | null;
  calibration_source: string | null;
  consumed_since_calibration_liters: number;
  learned_idle_lph: number | string | null;
  last_reading_at: string | null;
}

export async function calibrateVirtualTank(
  vehicleId: string,
  liters?: number | null
): Promise<{ success: boolean; tank: VirtualTank }> {
  return api(`/vehicles/${vehicleId}/virtual-tank/calibrate`, {
    method: 'POST',
    body: JSON.stringify(liters != null ? { liters } : {}),
  });
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
  idle_hours: number;
  moving_fuel_liters: number;
  idle_fuel_liters: number;
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
  idle_burn_liters_per_hour: number;
  vehicles: EstimatedConsumptionRow[];
  daily: EstimatedConsumptionDay[];
  totals: EstimatedConsumptionTotals;
  purchases: {
    count: number;
    liters: number;
    cost_ngn: number;
  };
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

/** Why the extra fuel was burned, split into what the tracker can account for. */
export interface LossReason {
  excess_liters: number;
  idle_liters: number;
  idle_cost_ngn: number;
  idle_hours: number;
  unexplained_liters: number;
  unexplained_cost_ngn: number;
  harsh_event_count: number;
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
  idle_hours?: number;
  idle_fuel_liters?: number;
  idle_cost_ngn?: number;
  harsh_event_count?: number;
  loss_reason?: LossReason;
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
  total_expected_fuel_liters?: number;
  total_expected_cost_ngn: number;
  total_idle_hours?: number;
  total_idle_fuel_liters?: number;
  total_harsh_events?: number;
  loss_reason?: LossReason;
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

/** One calendar month of measured activity for a driver. */
export interface DriverMonth {
  month: string;
  distance_km: number;
  fuel_liters: number;
  /** null until there is enough distance and fuel to divide. */
  efficiency_km_l: number | null;
  efficiency_mpg: number | null;
  baseline_km_l: number | null;
  /** Share of the fuel this distance should have burned that was actually logged. */
  fuel_coverage: number | null;
  /** False when the fuel record is too patchy for km/L to mean anything. */
  fuel_complete: boolean;
  moving_hours: number;
  idle_hours: number;
  trips: number;
  active_days: number;
  vehicles: number;
  last_seen_at: string | null;
  top_location: {
    /** null when the coordinates were never geocoded — not a fallback label. */
    name: string | null;
    address: string | null;
    latitude: number;
    longitude: number;
    visits: number;
  } | null;
}

export interface DriverReport {
  driver_id: string | null;
  driver_name: string;
  months: DriverMonth[];
}

export interface DriverReportsResponse {
  months: number;
  /**
   * Telemetry has no driver column, so figures are attributed via the
   * vehicle's current assignment. The UI states this rather than implying the
   * tracker identified the driver.
   */
  attribution: 'vehicle_assignment';
  drivers: DriverReport[];
}

export function fetchDriverReports(months = 6): Promise<DriverReportsResponse> {
  return api<DriverReportsResponse>(`/drivers/reports?months=${months}`);
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

export interface ReceiptVerificationCheck {
  code: 'vehicle_present' | 'volume_fits_tank' | 'bought_vs_burned';
  label: string;
  outcome: 'pass' | 'fail' | 'unknown';
  detail: string;
}

export interface ReceiptStationEvidence {
  placeName: string | null;
  formattedAddress: string | null;
  photoUrl: string | null;
  imageKind: 'street_view' | 'place_photo' | 'map' | null;
  streetViewDate: string | null;
  source: 'receipt' | 'tracker';
}

/** What the tracker could and could not confirm about a receipt. */
export interface ReceiptVerification {
  status: 'matched' | 'pending' | 'flagged_theft';
  checks: ReceiptVerificationCheck[];
  summary: string;
  station: ReceiptStationEvidence | null;
  distanceMeters: number | null;
  nearestFixAt: string | null;
  tankLevelBeforeLiters: number | null;
  headroomLiters: number | null;
  overclaimedLiters: number | null;
  estimatedLossNgn: number;
  verifiedAt: string;
}

export interface FuelPurchase {
  id: string;
  verification?: ReceiptVerification | null;
  merchant_address?: string | null;
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

export interface FuelHistoryPoint {
  id: string;
  vehicle_id: string;
  recorded_at: string;
  fuel_level_liters: string | number | null;
  fuel_source: 'CAN' | 'OBD%' | 'virtual' | 'none' | null;
  fuel_rate_lph: string | number | null;
  odometer_km: string | number | null;
  speed_kph: number | null;
  ignition_on: boolean | null;
}

export async function getFuelHistory(
  vehicleId: string,
  limit = 300
): Promise<FuelHistoryPoint[]> {
  return api<FuelHistoryPoint[]>(
    `/telemetry/history?vehicle_id=${vehicleId}&limit=${limit}`
  );
}

export interface BenchmarkPrice {
  ngn_per_liter: number;
  effective_from: string;
  source: string;
  note: string | null;
}

export interface FuelPriceResponse {
  current: BenchmarkPrice | null;
  latest_receipt: { ngn_per_liter: number; as_of: string } | null;
  history: BenchmarkPrice[];
}

export async function getFuelPrice(): Promise<FuelPriceResponse> {
  return api<FuelPriceResponse>('/fuel-price');
}

export async function setFuelPrice(input: {
  ngnPerLiter: number;
  effectiveFrom?: string;
  note?: string;
}): Promise<BenchmarkPrice> {
  return api<BenchmarkPrice>('/fuel-price', {
    method: 'POST',
    body: JSON.stringify({
      ngn_per_liter: input.ngnPerLiter,
      effective_from: input.effectiveFrom,
      note: input.note,
    }),
  });
}

export interface VehicleSignal {
  avl_id: number;
  label: string;
  description: string | null;
  group: 'engine' | 'fuel' | 'movement' | 'electrical' | 'network' | 'gnss' | 'other';
  raw: number;
  value: number | null;
  unit: string | null;
  display: string;
  known: boolean;
}

export interface VehicleActivity {
  records: number;
  engine_on_seconds: string | number;
  moving_seconds: string | number;
  idle_seconds: string | number;
  ignition_cycles: number;
  max_speed_kph: number | null;
  avg_moving_speed_kph: number | null;
  first_moved_at: string | null;
  last_moved_at: string | null;
  distance_km: number | null;
  fuel_used_liters: string | number | null;
}

export interface VehicleSignalsResponse {
  imei: string | null;
  frame_at: string | null;
  gps_satellites: number | null;
  gps_valid: boolean | null;
  signals: VehicleSignal[];
  activity: VehicleActivity | null;
  days: number;
}

export async function getVehicleSignals(
  vehicleId: string,
  days = 1
): Promise<VehicleSignalsResponse> {
  return api<VehicleSignalsResponse>(
    `/telemetry/vehicle-signals?vehicle_id=${vehicleId}&days=${days}`
  );
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

export interface TripStop {
  lat: number;
  lng: number;
  arrived_at: string;
  departed_at: string;
  duration_minutes: number;
  kind: 'origin' | 'stop' | 'pause' | 'traffic' | 'destination';
  /** Present only when this spot is already in the place cache — resolving it
   *  live would bill a geocode per stop, every time the list is opened. */
  place_label?: string | null;
}

export interface StopPlace {
  latitude: number;
  longitude: number;
  formatted_address: string | null;
  place_name: string | null;
  place_id: string | null;
  photo_url: string | null;
  /** Street View shows the actual kerbside; place_photo is a nearby venue. */
  image_kind: 'street_view' | 'place_photo' | null;
  street_view_date: string | null;
}

/** Resolved on demand when a stop is opened — not for every stop in the list,
 *  so Google is only billed for places actually inspected. */
export async function fetchStopPlace(lat: number, lng: number): Promise<StopPlace> {
  return api<StopPlace>(`/telemetry/stop-place?lat=${lat}&lng=${lng}`);
}

/** Place photos stream through the backend, which holds the API key. */
export function placePhotoSrc(photoUrl: string | null): string | null {
  if (!photoUrl) return null;
  const base = API_URL.replace(/\/api$/, '');
  return photoUrl.startsWith('/api') ? `${base}${photoUrl}` : photoUrl;
}

export interface ServerTrip {
  start_at: string;
  end_at: string;
  duration_minutes: number;
  distance_km: number;
  avg_speed_kph: number;
  max_speed_kph: number;
  idle_minutes: number;
  active: boolean;
  estimated_fuel_liters: number;
  /** null until a real receipt establishes a price per litre. */
  estimated_cost_ngn: number | null;
  path: [number, number][];
  stops: TripStop[];
  /** Each stretch the engine ran while the vehicle stood still, with where. */
  idle_events?: IdleStretch[];
  /** 0-100. How much weight this trip's fuel figure can carry. */
  confidence: number;
  confidence_notes: string[];
}

export interface IdleStretch {
  started_at: string;
  ended_at: string | null;
  minutes: number;
  lat: number | null;
  lng: number | null;
  place_label?: string | null;
}

export interface TripsVehicle {
  vehicle_id: string;
  license_plate: string;
  model: string | null;
  driver_name: string | null;
  trips: ServerTrip[];
  total_distance_km: number;
  total_fuel_liters: number;
  total_cost_ngn: number | null;
}

export interface TripsResponse {
  period_minutes: number;
  /** Set only when an explicit calendar range was requested. */
  from?: string | null;
  to?: string | null;
  source: 'live' | 'historical';
  /** null when no fuel receipt has been logged yet. */
  price_per_liter_ngn: number | null;
  price_as_of?: string | null;
  vehicles: TripsVehicle[];
}

export interface TrackTrip {
  path: { lat: number; lng: number }[];
  distanceKm: number;
  startAt: string;
  endAt: string;
}

export interface VehicleTrack {
  vehicleId: string;
  licensePlate: string;
  driverName: string | null;
  make: string | null;
  model: string | null;
  color: string;
  path: { lat: number; lng: number }[];
  trips: TrackTrip[];
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

/** Anchor a vehicle's true mileage to its dashboard reading (in km). */
export async function setVehicleOdometer(
  vehicleId: string,
  odometerKm: number
): Promise<{ success: boolean; total_odometer_km: number }> {
  return api(`/vehicles/${vehicleId}/odometer`, {
    method: 'POST',
    body: JSON.stringify({ odometerKm }),
  });
}

export type FeatureFlags = Record<string, boolean>;

export interface FeatureCatalogueItem {
  key: string;
  label: string;
  description: string;
  default_enabled: boolean;
  enabled: boolean;
}

export async function fetchFeatureFlags(): Promise<{
  flags: FeatureFlags;
  catalogue: FeatureCatalogueItem[];
}> {
  return api('/features');
}

export async function setFeatureFlag(
  key: string,
  enabled: boolean
): Promise<{ success: boolean; flags: FeatureFlags }> {
  return api(`/features/${key}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
}

export const KM_TO_MILES = 0.621371;

/** Odometer display convention: miles (values are stored/transported in km). */
export function formatOdometerMiles(km: number | string | null | undefined): string {
  if (km == null) return '—';
  return `${Math.round(Number(km) * KM_TO_MILES).toLocaleString()} mi`;
}

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

// FMC150 scenario events decoded from GNSS + accelerometer AVL elements
export interface DeviceEvent {
  id: number;
  vehicle_id: string | null;
  license_plate: string | null;
  driver_name: string | null;
  event_type: string;
  severity: 'info' | 'warning' | 'critical';
  value: string | number | null;
  unit: string | null;
  speed_kph: number | null;
  latitude: string | number | null;
  longitude: string | number | null;
  occurred_at: string;
}

export interface DeviceEventsResponse {
  period_days: number;
  events: DeviceEvent[];
}

export interface BehaviorVehicle {
  vehicle_id: string;
  license_plate: string | null;
  driver_name: string | null;
  model: string | null;
  distance_km: number;
  idle_hours?: number;
  idle_fuel_liters?: number;
  score: number;
  grade: string;
  total_events: number;
  security_events: number;
  counts: Record<string, number>;
  last_event_at: string | null;
}

export interface DeviceEventsSummary {
  period_days: number;
  fleet: {
    avg_score: number | null;
    total_events: number;
    security_events: number;
    idle_hours?: number;
    idle_fuel_liters?: number;
    counts_by_type: Record<string, number>;
  };
  idle_burn_liters_per_hour?: number;
  vehicles: BehaviorVehicle[];
}

// ---------------------------------------------------------------------------
// Fleet intelligence — all derived from AVL elements the FMC150 already sends.
// ---------------------------------------------------------------------------

export interface MaintenanceItem {
  id: string;
  vehicle_id: string;
  license_plate: string;
  make: string | null;
  model: string | null;
  kind: string;
  interval_km: number | null;
  interval_days: number | null;
  last_service_km: number | null;
  last_service_at: string | null;
  current_km: number | null;
  /** False = mileage is distance-since-fitting, not the dashboard reading. */
  odometer_anchored: boolean;
  odometer_at: string | null;
  due_at_km: number | null;
  km_remaining: number | null;
  due_at: string | null;
  days_remaining: number | null;
  status: 'ok' | 'due_soon' | 'overdue';
}

export interface MaintenanceResponse {
  thresholds: { due_soon_km: number; due_soon_days: number };
  overdue: number;
  due_soon: number;
  items: MaintenanceItem[];
}

export interface SecurityEvent {
  vehicle_id: string;
  license_plate: string;
  driver_name: string | null;
  at: string;
  latitude: number | null;
  longitude: number | null;
  kind: 'signal_loss' | 'reporting_gap';
  gsm_signal: number | null;
  battery_current_ma: number | null;
  speed_before_kph: number | null;
  gap_seconds: number | null;
}

export interface SecurityResponse {
  period_days: number;
  thresholds: { weak_gsm_bars: number; reporting_gap_seconds: number };
  events: SecurityEvent[];
}

export interface HoursVehicle {
  vehicle_id: string;
  license_plate: string;
  driver_name: string | null;
  stretches: number;
  total_hours: number;
  longest_hours: number;
  long_stretches: number;
  night_stretches: number;
}

export interface HoursResponse {
  period_days: number;
  thresholds: { break_minutes: number; fatigue_hours: number };
  vehicles: HoursVehicle[];
  flagged: {
    license_plate: string;
    driver_name: string | null;
    started_at: string;
    ended_at: string;
    hours: number;
    night: boolean;
  }[];
}

export interface UtilisationVehicle {
  vehicle_id: string;
  license_plate: string;
  make: string | null;
  model: string | null;
  driver_name: string | null;
  distance_km: number;
  engine_hours: number;
  ignition_cycles: number;
  active_days: number;
  active_share: number;
  km_per_active_day: number | null;
  km_per_engine_hour: number | null;
}

export interface UtilisationResponse {
  period_days: number;
  vehicles: UtilisationVehicle[];
}

export interface Geofence {
  id: string;
  name: string;
  shape: string;
  center_lat: string | null;
  center_lng: string | null;
  radius_m: number | null;
  purpose: string;
  notify_on: string;
  vehicle_id: string | null;
  driver_id: string | null;
  active: boolean;
}

export interface GeofenceEvent {
  vehicle_id: string;
  license_plate: string;
  driver_name: string | null;
  zone_id: string;
  zone_name: string;
  purpose: string;
  direction: 'entered' | 'exited';
  at: string;
  latitude: number;
  longitude: number;
}

export const fetchMaintenance = () => api<MaintenanceResponse>('/maintenance');
export const fetchSecuritySignals = (days = 30) =>
  api<SecurityResponse>(`/intelligence/security?days=${days}`);
export const fetchDrivingHours = (days = 30) =>
  api<HoursResponse>(`/intelligence/hours?days=${days}`);
export const fetchUtilisation = (days = 30) =>
  api<UtilisationResponse>(`/intelligence/utilisation?days=${days}`);
export const fetchGeofences = () => api<Geofence[]>('/geofences');
export const fetchGeofenceEvents = (days = 30) =>
  api<{ period_days: number; evaluates: string; events: GeofenceEvent[] }>(
    `/geofences/events?days=${days}`
  );

export function createGeofence(input: {
  name: string;
  center_lat: number;
  center_lng: number;
  radius_m: number;
  purpose?: string;
  notify_on?: string;
  vehicle_id?: string | null;
  driver_id?: string | null;
}): Promise<Geofence> {
  return api<Geofence>('/geofences', { method: 'POST', body: JSON.stringify(input) });
}

export function deleteGeofence(id: string): Promise<void> {
  return api<void>(`/geofences/${id}`, { method: 'DELETE' });
}
