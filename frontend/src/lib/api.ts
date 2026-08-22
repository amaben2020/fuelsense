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

export interface ImmobilizerStatus {
  immobilized: boolean;
  immobilizedAt: string | null;
  canImmobilize: boolean;
  blockedReason: string | null;
  deviceOnline: boolean;
}

export async function getImmobilizerStatus(vehicleId: string): Promise<ImmobilizerStatus> {
  return api(`/vehicles/${vehicleId}/immobilizer`);
}

export async function engageImmobilizer(vehicleId: string): Promise<ImmobilizerStatus> {
  return api(`/vehicles/${vehicleId}/immobilizer/engage`, { method: 'POST' });
}

export async function releaseImmobilizer(vehicleId: string): Promise<ImmobilizerStatus> {
  return api(`/vehicles/${vehicleId}/immobilizer/release`, { method: 'POST' });
}

/**
 * Units a dashboard economy readout might be in.
 *
 * Asked for explicitly rather than inferred: "15 mpg" is 6.38 km/L on a US
 * gauge and 5.31 km/L on an imperial one, and this figure becomes the
 * benchmark every economy number is judged against.
 */
/** 1 km/L = 2.35215 miles per US gallon. Mirrors the backend constant. */
export const KM_PER_LITER_TO_MPG = 2.35215;

export function kmLToMpg(kmL: number | null | undefined): number | null {
  if (kmL == null || kmL <= 0) return null;
  return Math.round(kmL * KM_PER_LITER_TO_MPG * 10) / 10;
}

export type EconomyUnit = 'mpg_us' | 'mpg_imp' | 'km_l' | 'l_100km';

export const ECONOMY_UNIT_LABELS: Record<EconomyUnit, string> = {
  mpg_us: 'mpg (US)',
  mpg_imp: 'mpg (imperial)',
  km_l: 'km/L',
  l_100km: 'L/100 km',
};

export interface VehicleEconomyResponse {
  success: boolean;
  rate_source: 'manual' | 'preset';
  entered?: { value: number; unit: EconomyUnit; label: string };
  consumption_l_per_100km: number;
  km_per_liter: number | null;
  mpg_us?: number | null;
}

export interface VehicleCalibrationStatus {
  vehicle_id: string;
  license_plate: string;
  vehicle_type_label: string;
  rate_l_per_100km: number | null;
  idle_burn_l_per_hour: number | null;
  /** 'manual' = a figure the manager entered; the tank burns at this rate. */
  rate_source: 'manual' | 'calibrated' | 'preset' | null;
  purchases_logged: number;
  usable_measurements: number;
  fill_ups_until_calibrated: number;
}

export function fetchCalibrationStatus(): Promise<{
  calibration_min_purchases: number;
  vehicles: VehicleCalibrationStatus[];
}> {
  return api('/features/calibration-status');
}

/** Set the vehicle's own economy figure, or pass null to clear it. */
export async function setVehicleEconomy(
  vehicleId: string,
  input: { value: number; unit: EconomyUnit } | null
): Promise<VehicleEconomyResponse> {
  return api(`/vehicles/${vehicleId}/economy`, {
    method: 'POST',
    body: JSON.stringify(input ?? { value: null }),
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
  /**
   * Open alerts that say something about how the fleet is driven and fuelled,
   * excluding notifications (a receipt filed, a zone crossed) and tracker
   * connectivity, which has its own tile. Optional because a backend deployed
   * before this field existed simply omits it.
   */
  concerning_alerts?: number;
  theft_alerts: number;
  estimated_theft_loss_ngn: number;
}

export interface HealthTrendDay {
  date: string;
  concerning_alerts: number;
  theft_alerts: number;
}

export interface HealthTrendResponse {
  days: HealthTrendDay[];
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
  /**
   * The rate currently in force — a caption only. Each day in `daily` is valued
   * at the rate that applied on that day. Null when the fleet has never
   * recorded a benchmark or a receipt, in which case costs are not shown.
   */
  price_per_liter_ngn: number | null;
  price_source?: 'benchmark' | 'receipt' | null;
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

export interface EventReplayManoeuvre {
  type: 'harsh_braking' | 'harsh_acceleration' | 'harsh_cornering' | string;
  occurred_at: string;
  severity: string;
  /** Peak magnitude of the manoeuvre in m/s², as computed from the GPS trace. */
  magnitude_ms2: number | null;
  speed_kph: number | null;
  /** Nearest entry in `readings`, so the map can colour the right segment. */
  index: number;
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
  /**
   * Harsh manoeuvres inside the window, positioned against `readings`. Derived
   * from the GPS speed and heading series — the tracker's own Green Driving
   * scenario is disabled on this fleet, so it reports none itself.
   */
  manoeuvres?: EventReplayManoeuvre[];
  /** The fleet's declared limit for this vehicle, km/h. Null when none is set. */
  speed_limit_kph?: number | null;
  anomaly: {
    type: string;
    liters_lost: number;
    /**
     * Null when the fleet has never recorded a price. Losses are valued at the
     * benchmark or receipt rate in force when they happened, not at a flat
     * constant, so this can legitimately be absent — show litres alone rather
     * than a made-up naira figure.
     */
    estimated_loss_ngn: number | null;
    price_ngn_per_liter?: number | null;
    price_source?: 'benchmark' | 'receipt' | null;
    /** Absent where no evidence-weighted score was computed for the branch. */
    confidence_percent?: number;
    reasons: string[];
    declared_liters?: number;
    /** Litres the modelled tank actually rose by. Named for history, not OBD. */
    obd_liters_actual?: number | null;
    primary_explanation?: string;
    why_flagged?: string[];
    confidence_factors?: string[];
    recommended_actions?: string[];
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
export interface DriverPeriod {
  /** `YYYY-MM`, ISO week `YYYY-Www`, or `YYYY-MM-DD` depending on the bucket. */
  period: string;
  period_start: string;
  period_end: string;
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
  periods: DriverPeriod[];
}

/** Calendar grain the driver report groups on. */
export type ReportBucket = 'month' | 'week' | 'day';

export interface DriverReportsResponse {
  bucket: ReportBucket;
  /** Buckets covered by the rolling window; ignored when from/to are set. */
  periods: number;
  from: string | null;
  to: string | null;
  /**
   * Telemetry has no driver column, so figures are attributed via the
   * vehicle's current assignment. The UI states this rather than implying the
   * tracker identified the driver.
   */
  attribution: 'vehicle_assignment';
  drivers: DriverReport[];
}

export interface DriverReportQuery {
  bucket?: ReportBucket;
  periods?: number;
  /** Explicit window. When set, it replaces the rolling `periods` lookback. */
  from?: string | null;
  to?: string | null;
}

export function fetchDriverReports(
  query: DriverReportQuery = {},
): Promise<DriverReportsResponse> {
  const params = new URLSearchParams();
  if (query.bucket) params.set('bucket', query.bucket);
  if (query.periods) params.set('periods', String(query.periods));
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  const qs = params.toString();
  return api<DriverReportsResponse>(`/drivers/reports${qs ? `?${qs}` : ''}`);
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
  /** `awaiting_evidence` = nothing known yet; never an accusation. */
  verdict: 'verified' | 'review' | 'suspicious' | 'likely_theft' | 'awaiting_evidence';
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
  /** Fill-to-fill distance since the previous purchase, GPS preferred over odometer. */
  distance_km?: number | null;
  merchant: string;
  receipt_reference?: string | null;
  /** `manually_verified` / `rejected` are manager verdicts on a pending row. */
  status:
    | 'verified'
    | 'flagged_theft'
    | 'pending_receipt'
    | 'manually_verified'
    | 'rejected';
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
  id: number;
  ngn_per_liter: number;
  effective_from: string;
  source: string;
  note: string | null;
}

export interface SetFuelPriceResult extends BenchmarkPrice {
  previous: BenchmarkPrice | null;
  change_fraction: number | null;
  notable_change: boolean;
}

/**
 * How the declared fuel price has moved. Every naira figure in the product is
 * derived from this, so the direction is worth stating rather than leaving a
 * manager to infer it from a list of dates.
 */
export interface FuelPriceTrend {
  /** Oldest first, so it plots left to right without reversing. */
  series: { ngn_per_liter: number; effective_from: string }[];
  change_ngn: number;
  change_pct: number;
  direction: 'up' | 'down' | 'flat';
  /** How many prices have been declared, not how many times it rose. */
  changes: number;
  low: number | null;
  high: number | null;
}

export interface FuelPriceResponse {
  current: BenchmarkPrice | null;
  latest_receipt: { ngn_per_liter: number; as_of: string } | null;
  history: BenchmarkPrice[];
  /** Absent from a backend deployed before the trend was added. */
  trend?: FuelPriceTrend;
}

export async function getFuelPrice(): Promise<FuelPriceResponse> {
  return api<FuelPriceResponse>('/fuel-price');
}

/**
 * Whether the trackers are judging harsh driving themselves, alongside the
 * measurement FuelSense derives from GPS. Both feed the safety score, so a
 * manager reading that score needs to know when two sources are contributing.
 */
export interface GreenDrivingStatus {
  period_days: number;
  /** True when Green Driving frames actually arrived, not when a flag is set. */
  active: boolean;
  device_events: number;
  devices_reporting: number;
  last_device_event_at: string | null;
  /** The GPS-derived harsh events over the same window, for comparison. */
  derived_events: number;
}

export async function getGreenDrivingStatus(
  days = 7
): Promise<GreenDrivingStatus> {
  return api<GreenDrivingStatus>(`/devices/green-driving?days=${days}`);
}

export async function setFuelPrice(input: {
  ngnPerLiter: number;
  effectiveFrom?: string;
  note?: string;
}): Promise<SetFuelPriceResult> {
  return api<SetFuelPriceResult>('/fuel-price', {
    method: 'POST',
    body: JSON.stringify({
      ngn_per_liter: input.ngnPerLiter,
      effective_from: input.effectiveFrom,
      note: input.note,
    }),
  });
}

/** Reverts the price change from `setFuelPrice`, if it's still undoable. */
export async function undoFuelPrice(id: number): Promise<BenchmarkPrice | null> {
  return api<BenchmarkPrice | null>(`/fuel-price/${id}`, { method: 'DELETE' });
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
  /**
   * Where the vehicle was last seen before it set off without a GPS lock.
   *
   * Present only on the first trip after a cold start, and only when it is far
   * enough from the first plotted fix to matter. The route between the two is
   * genuinely unknown, so it must never be drawn as a solid trail.
   */
  blind_origin?: {
    latitude: number;
    longitude: number;
    last_known_at: string;
    distance_m: number;
  };
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

/**
 * Litres still in the tank when a real vehicle's low-fuel light comes on —
 * manufacturers hold back roughly 10-12 L near empty so the electric fuel
 * pump, submerged in the tank and cooled by the fuel around it, never runs
 * dry. A driver already reads that point as "empty"; showing a gauge against
 * full nameplate capacity instead makes the app look more full than the
 * vehicle's own dashboard would, and less full than that is exactly the
 * complaint a manager who has driven the vehicle will make.
 *
 * A flat litre figure rather than a percentage of capacity, because the
 * reserve is sized to the pump, not the tank.
 */
export const RESERVE_LITERS_DEFAULT = 11;

/**
 * Percent of *usable* fuel — capacity minus the reserve — floored at 0 once
 * the tank is inside the reserve band. This is what a driver's own gauge
 * shows them, so it is what a manager should see too.
 */
export function usableFuelPercent(
  liters: number | null | undefined,
  capacityLiters: number | null | undefined
): number | null {
  if (liters == null || !capacityLiters) return null;
  const usableCapacity = Math.max(1, capacityLiters - RESERVE_LITERS_DEFAULT);
  const usableLiters = Math.max(0, liters - RESERVE_LITERS_DEFAULT);
  return Math.max(0, Math.min(100, Math.round((usableLiters / usableCapacity) * 100)));
}

/** Whether the tank has dropped into the reserve band — the same moment a
 *  real dashboard's low-fuel warning light would already be on. */
export function isInFuelReserve(liters: number | null | undefined): boolean {
  return liters != null && liters <= RESERVE_LITERS_DEFAULT;
}

export function fuelPercent(row: FleetVehicle): number | null {
  if (row.fuel_level_liters == null || !row.tank_capacity_liters) return null;
  return usableFuelPercent(Number(row.fuel_level_liters), row.tank_capacity_liters);
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

/**
 * NGN prefix rather than the ₦ glyph. Confirmed on this machine (and every
 * font tested — Inter, system-ui, Arial, monospace all show the same thing)
 * that U+20A6 NAIRA SIGN renders as a single diagonal slash through the N in
 * this environment, not the real double-bar Naira sign — reading as a
 * struck-through, invalidated number at headline sizes. "NGN" sidesteps the
 * glyph entirely and is what most Nigerian fintech UIs use for exactly this
 * reason.
 */
export function formatNgn(amount: number) {
  const n = new Intl.NumberFormat('en-NG', { maximumFractionDigits: 0 }).format(amount);
  return `NGN ${n}`;
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

/** A polygon ring point, stored [latitude, longitude]. */
export type GeofencePoint = [number, number];

export interface Geofence {
  id: string;
  name: string;
  /** 'circle' | 'polygon'. Rectangles are stored as four-point polygons. */
  shape: string;
  center_lat: string | null;
  center_lng: string | null;
  radius_m: number | null;
  polygon: GeofencePoint[] | null;
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

/**
 * The service kinds offered by default. Free text is still accepted by the
 * API — these are the ones worth one tap, with intervals that are ordinary
 * for Nigerian fleet operation rather than manufacturer ideals.
 */
export const MAINTENANCE_PRESETS: {
  kind: string;
  label: string;
  intervalKm: number;
  intervalDays: number | null;
}[] = [
  { kind: 'oil_change', label: 'Oil change', intervalKm: 5000, intervalDays: 180 },
  { kind: 'tyres', label: 'Tyres', intervalKm: 40000, intervalDays: null },
  { kind: 'brakes', label: 'Brakes', intervalKm: 25000, intervalDays: null },
  { kind: 'service', label: 'Full service', intervalKm: 10000, intervalDays: 365 },
];

export interface CreateMaintenanceInput {
  vehicleId: string;
  kind: string;
  intervalKm?: number | null;
  intervalDays?: number | null;
  lastServiceKm?: number | null;
  lastServiceAt?: string | null;
  notes?: string | null;
}

export const createMaintenance = (input: CreateMaintenanceInput) =>
  api<MaintenanceItem>('/maintenance', {
    method: 'POST',
    body: JSON.stringify({
      vehicle_id: input.vehicleId,
      kind: input.kind,
      interval_km: input.intervalKm ?? null,
      interval_days: input.intervalDays ?? null,
      last_service_km: input.lastServiceKm ?? null,
      last_service_at: input.lastServiceAt ?? null,
      notes: input.notes ?? null,
    }),
  });

/**
 * Records a service as done, restarting the interval from here. Omitting the
 * odometer reading is normal: the backend then uses the vehicle's current
 * measured mileage rather than storing "unknown".
 */
export const completeMaintenance = (id: string, atKm?: number | null) =>
  api<MaintenanceItem>(`/maintenance/${id}/complete`, {
    method: 'PATCH',
    body: JSON.stringify({ at_km: atKm ?? null }),
  });

export const deleteMaintenance = (id: string) =>
  api<{ success: boolean }>(`/maintenance/${id}`, { method: 'DELETE' });
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
  /** Omit for polygon zones; required for circles. */
  shape?: 'circle' | 'polygon';
  center_lat?: number;
  center_lng?: number;
  radius_m?: number;
  /** [[lat, lng], ...] ring. Rectangles send their four corners. */
  polygon?: GeofencePoint[];
  purpose?: string;
  notify_on?: string;
  vehicle_id?: string | null;
  driver_id?: string | null;
}): Promise<Geofence> {
  return api<Geofence>('/geofences', { method: 'POST', body: JSON.stringify(input) });
}

/**
 * Resolve many alerts in one request.
 *
 * Returns the ids the server actually resolved, which can be fewer than were
 * asked for — another session may have cleared some already. The caller should
 * reconcile against what comes back rather than assuming its own list won.
 */
export function resolveAlerts(ids: number[]): Promise<{ resolved: number; ids: number[] }> {
  return api('/alerts/resolve', { method: 'POST', body: JSON.stringify({ ids }) });
}

/**
 * Record a manager's verdict on a receipt the reconciler left pending.
 *
 * Only pending rows are accepted server-side, so a double-submit or a stale
 * tab cannot overwrite a reconciliation the system already performed.
 */
export function resolvePendingReceipt(
  id: string,
  decision: 'accept' | 'reject'
): Promise<{ ok: true; id: string; status: string }> {
  return api(`/telemetry/fuel-purchases/${id}/resolve`, {
    method: 'PATCH',
    body: JSON.stringify({ decision }),
  });
}

export function deleteGeofence(id: string): Promise<void> {
  return api<void>(`/geofences/${id}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Vehicle catalogue
//
// Make / model / year with the figures a new vehicle is seeded from. Served
// whole because it is small and static, so the Add Vehicle form can narrow its
// dropdowns instantly rather than round-tripping between each one.
// ---------------------------------------------------------------------------

export type VehicleBodyType =
  | 'sedan'
  | 'suv_pickup'
  | 'van_bus'
  | 'medium_truck'
  | 'heavy_truck'
  | 'motorcycle';

export interface CatalogueModel {
  model: string;
  type: VehicleBodyType;
  tank_liters: number;
  /** Mixed city traffic, not a combined-cycle rating. */
  consumption_l_per_100km: number;
  idle_burn_l_per_hour: number;
  year_from: number;
  year_to: number;
  note: string | null;
}

export interface CatalogueMake {
  make: string;
  models: CatalogueModel[];
}

export interface VehicleCatalogue {
  min_year: number;
  max_year: number;
  makes: CatalogueMake[];
}

export function fetchVehicleCatalogue(): Promise<VehicleCatalogue> {
  return api<VehicleCatalogue>('/vehicles/catalogue');
}
