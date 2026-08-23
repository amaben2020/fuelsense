const DRIVER_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
const DRIVER_TOKEN_KEY = 'fuelsense_driver_token';

export function getDriverToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(DRIVER_TOKEN_KEY);
}

export function setDriverToken(token: string) {
  localStorage.setItem(DRIVER_TOKEN_KEY, token);
}

export function clearDriverToken() {
  localStorage.removeItem(DRIVER_TOKEN_KEY);
}

export interface DriverSession {
  id: string;
  name: string;
  driver_code: string;
  vehicle_id: string | null;
  license_plate: string | null;
  model: string | null;
}

export interface ReceiptCheck {
  code: 'vehicle_present' | 'volume_fits_tank' | 'bought_vs_burned';
  label: string;
  outcome: 'pass' | 'fail' | 'unknown';
  detail: string;
}

export interface ReceiptVerification {
  status: 'matched' | 'pending' | 'flagged_theft';
  checks: ReceiptCheck[];
  summary: string;
  distance_meters?: number | null;
  estimatedLossNgn?: number;
}

export interface DriverReceipt {
  id: string;
  merchant_name: string | null;
  merchant_address?: string | null;
  transaction_date: string;
  declared_liters: string | number;
  obd_liters_actual: string | number | null;
  difference_liters: string | number | null;
  reconciliation_status: string;
  verification?: ReceiptVerification | null;
  total_amount: string | number | null;
  uploaded_at: string;
  license_plate: string;
}

export interface DriverVehicleStatus {
  vehicle_id: string;
  license_plate: string;
  model: string | null;
  make: string | null;
  tank_capacity_liters: number | null;
  connection_status: 'online' | 'offline';
  last_seen_at: string | null;
  recorded_at: string | null;
  fuel_level_liters: number | null;
  odometer_km: number | null;
  speed_kph: number | null;
  ignition_on: boolean | null;
  latitude: number | null;
  longitude: number | null;
  /** Whole percent (94 = 94%), matching the manager's gauge. Null until the
   *  tank has been calibrated. */
  fuel_confidence: number | null;
  fuel_calibrated_at: string | null;
}

export interface DriverTripsResponse {
  vehicle_id: string;
  license_plate: string;
  daily_history: Array<{
    activity_date: string;
    distance_km: number;
    fuel_used_liters: number;
    idle_hours: number;
    trip_count: number;
  }>;
  recent_starts: Array<{
    started_at: string;
    odometer_km: number | null;
    latitude: number | null;
    longitude: number | null;
  }>;
}

export interface SubmitReceiptResponse {
  success: boolean;
  receipt_id: string;
  reconciliation_status: string;
  obd_liters_actual: number | null;
  difference_liters: number | null;
  actual_from: string;
  message: string;
  duplicate?: boolean;
}

export interface ParseReceiptResponse {
  fields: {
    merchant_name: string;
    merchant_address: string | null;
    declared_liters: number | null;
    total_amount: number | null;
    price_per_liter: number | null;
    transaction_date: string;
  };
  confidence: Record<string, number>;
  parse_confidence: number;
  raw_text_preview: string;
  ocr_text?: string;
  ocr_provider?: string;
  ocr_line_count?: number;
}

async function driverApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  const token = getDriverToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${DRIVER_API_URL}${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

export async function driverLogin(driverCode: string, pin: string) {
  const response = await fetch(`${DRIVER_API_URL}/driver/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ driver_code: driverCode, pin }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Login failed');
  return data as { token: string; driver: DriverSession };
}

export async function fetchDriverMe() {
  return driverApi<DriverSession>('/driver/me');
}

export async function fetchDriverReceipts() {
  return driverApi<DriverReceipt[]>('/driver/receipts');
}

export async function fetchDriverVehicleStatus() {
  return driverApi<DriverVehicleStatus>('/driver/vehicle/status');
}

export async function fetchDriverTrips(days = 14) {
  return driverApi<DriverTripsResponse>(`/driver/trips?days=${days}`);
}

export async function parseDriverReceipt(imageDataUrl: string, merchantHint?: string) {
  return driverApi<ParseReceiptResponse>('/driver/receipts/ocr', {
    method: 'POST',
    body: JSON.stringify({ image_data_url: imageDataUrl, merchant_hint: merchantHint }),
  });
}

export async function parseDriverReceiptText(ocrText: string, merchantHint?: string) {
  return driverApi<ParseReceiptResponse>('/driver/receipts/parse', {
    method: 'POST',
    body: JSON.stringify({ ocr_text: ocrText, merchant_hint: merchantHint }),
  });
}

export interface AddressSuggestion {
  description: string;
  place_id: string;
}

export async function fetchAddressSuggestions(query: string) {
  return driverApi<AddressSuggestion[]>(
    `/places/autocomplete?q=${encodeURIComponent(query)}`
  );
}

export interface StationCheck {
  at_station: boolean | null;
  station_name: string | null;
  distance_m: number | null;
  radius_m: number;
}

export async function checkAtStation(lat: number, lng: number) {
  return driverApi<StationCheck>(`/driver/receipts/station-check?lat=${lat}&lng=${lng}`);
}

export async function submitDriverReceipt(body: Record<string, unknown>) {
  return driverApi<SubmitReceiptResponse>('/driver/receipts', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function syncPendingReceipt(
  receipt: Record<string, unknown>
): Promise<SubmitReceiptResponse> {
  return submitDriverReceipt(receipt);
}

export interface DriverAlert {
  id: number;
  alert_type: string;
  label: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  created_at: string;
  is_resolved: boolean;
  driver_note: string | null;
  driver_note_at: string | null;
  /** False once answered — an account is given once, not revised. */
  can_explain: boolean;
}

export interface DriverAlertsResponse {
  period_days: number;
  unanswered: number;
  alerts: DriverAlert[];
}

export async function fetchDriverAlerts(days = 14) {
  return driverApi<DriverAlertsResponse>(`/driver/alerts?days=${days}`);
}

/**
 * The driver's account of an alert. Everyday alerts close on being answered;
 * investigation-grade ones record the account and stay open for the manager,
 * which `resolved` in the response reports.
 */
export async function explainDriverAlert(id: number, note: string) {
  return driverApi<{ success: boolean; resolved: boolean; message: string }>(
    `/driver/alerts/${id}/explain`,
    { method: 'POST', body: JSON.stringify({ note }) }
  );
}
