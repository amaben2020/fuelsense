'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Bell,
  Calculator,
  Clock,
  Fuel,
  Gauge,
  History,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  RadioTower,
  ReceiptText,
  Route,
  Search,
  Pentagon,
  Settings,
  SlidersHorizontal,
  ShieldAlert,
  Siren,
  Truck,
  Plus,
  Users,
  X,
} from 'lucide-react';
import {
  Alert,
  api,
  ApiError,
  clearToken,
  Customer,
  DashboardSummary,
  Driver,
  FleetEfficiency,
  FleetEfficiencyResponse,
  FleetEfficiencySummary,
  FleetVehicle,
  FuelAnomaly,
  FuelEventsResponse,
  FuelPurchasesResponse,
  FeatureFlags,
  fetchFeatureFlags,
  getToken,
  TrackPoint,
  TripsResponse,
} from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { buildVehicleTracks } from '@/lib/map-utils';
import { BrandMark } from '@/components/BrandMark';
import { AddDeviceModal } from '@/components/AddDeviceModal';
import { ThemeToggle } from '@/components/ThemeToggle';
import { FleetOperationsOverview } from '@/components/dashboard/FleetOperationsOverview';
import { DashboardKpis } from '@/components/dashboard/DashboardKpis';
import { DriverSettingsPanel } from '@/components/dashboard/DriverSettingsPanel';
import { FuelPricePanel } from '@/components/dashboard/FuelPricePanel';
import { DailyActivityTable } from '@/components/dashboard/DailyActivityTable';
import { EstimatedConsumptionTable } from '@/components/dashboard/EstimatedConsumptionTable';
import { FuelEstimatePanel } from '@/components/dashboard/FuelEstimatePanel';
import { VehicleShowcase } from '@/components/dashboard/VehicleShowcase';
import { TripHistoryPanel } from '@/components/dashboard/TripHistoryPanel';
import { FleetEfficiencyReport } from '@/components/dashboard/FleetEfficiencyReport';
import { SavingsDashboard } from '@/components/dashboard/SavingsDashboard';
import { SiphonEventsSidebar } from '@/components/dashboard/SiphonEventsSidebar';
import {
  countActiveFuelEvents,
  FuelAnomaliesPanel,
} from '@/components/dashboard/FuelAnomaliesPanel';
import { FuelPurchaseTable, ReceiptsPanel } from '@/components/dashboard/ReceiptsPanel';
import { FuelAnalyticsPanel } from '@/components/dashboard/FuelAnalyticsPanel';
import { LiveMonitoringMap } from '@/components/dashboard/LiveMonitoringMap';
import { TelemetryHistoryTable } from '@/components/dashboard/TelemetryHistoryTable';
import { AlertsList, TheftAlertBanner } from '@/components/dashboard/AlertsList';
import { LoadErrorBanner } from '@/components/dashboard/LoadErrorBanner';
import { isPro } from '@/lib/plan';
import { DrivingBehaviorPanel } from '@/components/dashboard/DrivingBehaviorPanel';
import { DriverManagementPanel } from '@/components/dashboard/DriverManagementPanel';
import { GeofencesPanel } from '@/components/dashboard/GeofencesPanel';
import { CalibrationGuidePanel } from '@/components/dashboard/CalibrationGuidePanel';
import { FleetIntelligencePanel } from '@/components/dashboard/FleetIntelligencePanel';
import { AccountingLedgerPanel } from '@/components/dashboard/AccountingLedgerPanel';
import { TheftPanel } from '@/components/dashboard/TheftPanel';
import {
  IconRail,
  PageHeader,
  Panel,
  RoundButton,
  StatPills,
  type RailGroup,
  type RailItem,
  type StatPill,
} from '@/components/ui/chrome';
import { FleetCommandLoader } from '@/components/dashboard/FleetCommandLoader';

// Full dashboard reload cadence. Keep this modest — each cycle fires ~10 API
// calls, and aggressive polling trips the backend rate limiter (self-DoS).
// Cadence is set by how often the tracker actually reports, not by how live we
// want the page to feel. The FMC150 sends roughly every 2 minutes, so polling
// live data every 3 s meant ~39 of every 40 requests returned unchanged rows —
// which is what exhausted the database's monthly transfer allowance on
// 2026-08-09. Both intervals already skip hidden tabs; these values cut what a
// *visible* tab costs by an order of magnitude, and the visibility listener
// below refreshes immediately on focus so the slower cadence is not felt.
const REFRESH_MS = 30000;
const LIVE_REFRESH_MS = 20000;

type DashboardView =
  | 'overview'
  | 'live'
  | 'vehicle'
  | 'trips'
  | 'behavior'
  | 'drivers'
  | 'intel'
  | 'geofences'
  | 'fuel'
  | 'estimate'
  | 'receipts'
  | 'accounting'
  | 'anomalies'
  | 'theft'
  | 'alerts'
  | 'calibration'
  | 'settings';

/** No lucide glyph for the naira sign, so the rail icon is the character
 * itself, sized and weighted to sit alongside the stroke icons around it. */
function NairaIcon({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center justify-center font-bold ${className}`} aria-hidden>
      ₦
    </span>
  );
}

/** Sidebar entry -> feature flag key. A view with no mapping is always shown. */
const VIEW_FLAG: Partial<Record<DashboardView, string>> = {
  overview: 'fleet_overview',
  live: 'live_monitoring',
  vehicle: 'vehicle_view',
  trips: 'trip_history',
  behavior: 'driving_behavior',
  drivers: 'driver_management',
  intel: 'fleet_intelligence',
  geofences: 'geofences',
  fuel: 'fuel_analytics',
  estimate: 'fuel_estimate',
  receipts: 'receipts',
  accounting: 'accounting_ledger',
  anomalies: 'replay_events',
  theft: 'theft',
  alerts: 'alerts',
  calibration: 'calibration',
  settings: 'settings',
};

/** Views that depend on hardware a BASIC fleet does not have. */
const PRO_ONLY_VIEWS = new Set<DashboardView>(['anomalies']);

/** Immobilizer is still beta — one flag, flipped here, rather than tied to
 *  the subscription-tier logic `isPro()` drives. Swap for a real entitlement
 *  check once it graduates out of beta. */
const IMMOBILIZER_ENABLED = true;

/**
 * One record per destination. The rail, the mobile drawer and the page title
 * all read from here, so a new view needs a single entry rather than three
 * parallel edits. `nav` is the rail tooltip / drawer label; `title` is the
 * heading the page shows once the view is open.
 */
const VIEW_META: Record<
  DashboardView,
  { icon: React.ComponentType<{ className?: string }>; nav: string; title: string }
> = {
  overview: { icon: LayoutDashboard, nav: 'Fleet overview', title: 'Operations Dashboard' },
  live: { icon: RadioTower, nav: 'Live monitoring', title: 'Live monitoring' },
  vehicle: { icon: Truck, nav: 'Vehicle view', title: 'Vehicle view' },
  trips: { icon: Route, nav: 'Trip history', title: 'Trip history' },
  behavior: { icon: ShieldAlert, nav: 'Driving behavior', title: 'Driving behavior' },
  drivers: { icon: Users, nav: 'Driver management', title: 'Driver Management' },
  intel: { icon: Gauge, nav: 'Fleet intelligence', title: 'Fleet Intelligence' },
  geofences: { icon: Pentagon, nav: 'Geofencing', title: 'Geofencing' },
  fuel: { icon: Fuel, nav: 'Fuel analytics', title: 'Fuel analytics' },
  estimate: { icon: Calculator, nav: 'Fuel estimate', title: 'Fuel estimate' },
  receipts: { icon: ReceiptText, nav: 'Receipts', title: 'Receipts' },
  accounting: { icon: NairaIcon, nav: 'Accounting', title: 'Accounting' },
  anomalies: { icon: History, nav: 'Replay events', title: 'Replay events' },
  theft: { icon: Lock, nav: 'Theft', title: 'Theft & immobilizer' },
  alerts: { icon: Siren, nav: 'Alerts', title: 'Alerts' },
  calibration: { icon: SlidersHorizontal, nav: 'Calibration', title: 'Calibration' },
  settings: { icon: Settings, nav: 'Settings', title: 'Settings' },
};

const VIEWS: { id: DashboardView; label: string; hash: string }[] = [
  { id: 'overview', label: 'Operations', hash: 'overview' },
  { id: 'live', label: 'Live monitoring', hash: 'live' },
  { id: 'vehicle', label: 'Vehicle view', hash: 'vehicle' },
  { id: 'trips', label: 'Trip history', hash: 'trips' },
  { id: 'behavior', label: 'Driving behavior', hash: 'behavior' },
  { id: 'drivers', label: 'Driver management', hash: 'drivers' },
  { id: 'intel', label: 'Fleet intelligence', hash: 'intel' },
  { id: 'geofences', label: 'Geofencing', hash: 'geofences' },
  { id: 'fuel', label: 'Fuel analytics', hash: 'fuel' },
  { id: 'estimate', label: 'Fuel estimate', hash: 'estimate' },
  { id: 'receipts', label: 'Receipts', hash: 'receipts' },
  { id: 'accounting', label: 'Accounting', hash: 'accounting' },
  { id: 'anomalies', label: 'Replay events', hash: 'anomalies' },
  { id: 'theft', label: 'Theft', hash: 'theft' },
  { id: 'alerts', label: 'Alerts', hash: 'alerts' },
  { id: 'calibration', label: 'Calibration', hash: 'calibration' },
  { id: 'settings', label: 'Settings', hash: 'settings' },
];

/**
 * The rail groups seventeen destinations into five sections, matching what a
 * fleet manager is actually trying to do — get the daily picture, watch the
 * fleet, manage fuel spend, handle security, or configure the account —
 * rather than one undifferentiated list from Overview through Settings.
 */
const NAV_GROUPS: { label: string; views: DashboardView[] }[] = [
  { label: 'Overview', views: ['overview', 'live'] },
  { label: 'Fleet', views: ['vehicle', 'trips', 'behavior', 'drivers', 'intel', 'geofences'] },
  { label: 'Fuel', views: ['fuel', 'estimate', 'receipts', 'accounting', 'anomalies'] },
  { label: 'Security', views: ['theft', 'alerts'] },
  { label: 'System', views: ['calibration', 'settings'] },
];

export default function DashboardPage() {
  const router = useRouter();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [fleet, setFleet] = useState<FleetVehicle[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [anomalies, setAnomalies] = useState<FuelAnomaly[]>([]);
  const [efficiency, setEfficiency] = useState<FleetEfficiency[]>([]);
  const [efficiencySummary, setEfficiencySummary] = useState<FleetEfficiencySummary | null>(null);
  const [fuelPurchases, setFuelPurchases] = useState<FuelPurchasesResponse | null>(null);
  const [fuelPurchasePage, setFuelPurchasePage] = useState(1);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [todaySummary, setTodaySummary] = useState<DashboardSummary | null>(null);
  const [fuelEvents, setFuelEvents] = useState<FuelEventsResponse | null>(null);
  const [liveTracks, setLiveTracks] = useState(
    () => buildVehicleTracks([] as TrackPoint[])
  );
  const [trips, setTrips] = useState<TripsResponse | null>(null);
  const [pendingTripFocus, setPendingTripFocus] = useState<{
    vehicleId: string;
    startAt: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [efficiencyError, setEfficiencyError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [activeView, setActiveView] = useState<DashboardView>('overview');
  const [autoDrawZone, setAutoDrawZone] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const [followVehicle, setFollowVehicle] = useState(true);
  // Window the operational snapshot aggregates over. The API caps `days` at 90,
  // so a "year" option would have to be faked — these three are all real.
  const [periodDays, setPeriodDays] = useState(7);
  const periodDaysRef = useRef(7);
  periodDaysRef.current = periodDays;
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  // Sidebar visibility. Defaults to everything on so the nav never flashes
  // empty while the flags load; the server response then narrows it.
  const [flags, setFlags] = useState<FeatureFlags>({});
  const [trailMinutes, setTrailMinutes] = useState(1440);
  const trailMinutesRef = useRef(1440);
  trailMinutesRef.current = trailMinutes;
  // Explicit calendar range from the date picker. When set it supersedes the
  // rolling preset above; clearing it returns to the presets.
  const [tripRange, setTripRange] = useState<{ from: string; to: string } | null>(null);
  const tripRangeRef = useRef(tripRange);
  tripRangeRef.current = tripRange;
  // Opt-in to the server's "show the most recent journeys instead" widening.
  // Off by default so a chosen window always reports what is actually in it.
  const [tripFallback, setTripFallback] = useState(false);
  const tripFallbackRef = useRef(tripFallback);
  tripFallbackRef.current = tripFallback;
  const [siphonSidebarOpen, setSiphonSidebarOpen] = useState(false);
  const [fuelEventCount, setFuelEventCount] = useState(0);
  const { customer: cachedCustomer, setCustomer: cacheCustomer, clearAuth } = useAuthStore();
  const fleetRef = useRef(fleet);
  fleetRef.current = fleet;
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;

  const selectedVehicle = useMemo(
    () => fleet.find((v) => v.id === selectedVehicleId) ?? fleet[0] ?? null,
    [fleet, selectedVehicleId]
  );

  const onlineCount = fleet.filter((v) => v.connection_status === 'online').length;

  /**
   * Quick-jump for the top-bar search. Scoped to the fleet the dashboard has
   * already loaded, so it never issues a request — the field is a navigation
   * shortcut, not a backend search.
   */
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return fleet
      .filter((v) =>
        [v.license_plate, v.make, v.model, v.driver_name]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(q))
      )
      .slice(0, 6);
  }, [searchQuery, fleet]);

  const loadFuelPurchases = async (page = fuelPurchasePage, forReceipts = false) => {
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: forReceipts ? '50' : '10',
      });
      if (forReceipts) params.set('include_summary', 'true');
      const purchaseData = await api<FuelPurchasesResponse>(
        `/telemetry/fuel-purchases?${params.toString()}`
      );
      setFuelPurchases((prev) => ({
        ...purchaseData,
        summary: purchaseData.summary ?? prev?.summary,
      }));
      setFuelPurchasePage(purchaseData.page);
    } catch {
      setFuelPurchases((prev) => prev);
    }
  };

  // Live positions only need a short tail — trip trails come from /trips,
  // which is segmented and downsampled server-side (no 2000-point cap).
  const loadLiveTracks = useCallback(async () => {
    try {
      const trackPoints = await api<TrackPoint[]>('/telemetry/tracks?minutes=15');
      setLiveTracks(buildVehicleTracks(trackPoints));
    } catch {
      // no-op — keep existing tracks on error
    }
  }, []);

  const loadTrips = useCallback(async () => {
    try {
      const range = tripRangeRef.current;
      const params = new URLSearchParams(
        range
          ? { from: range.from, to: range.to }
          : { minutes: String(trailMinutesRef.current) },
      );
      if (tripFallbackRef.current) params.set('fallback', '1');
      const data = await api<TripsResponse>(`/telemetry/trips?${params.toString()}`);
      setTrips(data);
    } catch {
      // no-op — keep existing trips on error
    }
  }, []);

  const loadDashboard = async () => {
    try {
      const [meOrNull, fleetRows, alertList, anomalyList, fuelEvents] = await Promise.all([
        cachedCustomer ? Promise.resolve(cachedCustomer) : api<Customer>('/auth/me'),
        api<FleetVehicle[]>('/vehicles/fleet'),
        api<Alert[]>('/alerts'),
        api<FuelAnomaly[]>('/alerts/anomalies').catch(() => [] as FuelAnomaly[]),
        api<FuelEventsResponse>('/fuel-events').catch(() => null),
      ]);
      const me = meOrNull as Customer;
      if (!cachedCustomer) cacheCustomer(me);

      if (!me.onboarding_completed && fleetRows.length === 0) {
        router.replace('/onboarding');
        return;
      }

      let efficiencyRows: FleetEfficiency[] = [];
      let summaryRow: DashboardSummary | null = null;

      try {
        const efficiencyData = await api<FleetEfficiencyResponse>(
          `/telemetry/fleet-efficiency?days=${periodDaysRef.current}`
        );
        efficiencyRows = efficiencyData.vehicles ?? [];
        setEfficiencySummary(efficiencyData.summary ?? null);
        setEfficiencyError(null);
      } catch (effErr) {
        setEfficiencySummary(null);
        setEfficiencyError(
          effErr instanceof Error ? effErr.message : 'Efficiency data unavailable'
        );
      }

      try {
        summaryRow = await api<DashboardSummary>(
          `/dashboard/summary?days=${periodDaysRef.current}`
        );
      } catch {
        summaryRow = null;
      }

      let todayRow: DashboardSummary | null = null;
      try {
        todayRow = await api<DashboardSummary>('/dashboard/summary?days=1');
      } catch {
        todayRow = null;
      }

      try {
        if (activeViewRef.current !== 'receipts') {
          await loadFuelPurchases(fuelPurchasePage);
        }
      } catch {
        /* fuel tab handles its own refresh */
      }

      let driverRows: Driver[] = [];
      try {
        driverRows = await api<Driver[]>('/drivers');
      } catch {
        driverRows = [];
      }

      // Visibility switches. On failure the existing flags stand rather than
      // collapsing the nav to nothing.
      try {
        setFlags((await fetchFeatureFlags()).flags);
      } catch {
        /* keep whatever we already resolved */
      }

      let trackPoints: TrackPoint[] = [];
      try {
        trackPoints = await api<TrackPoint[]>('/telemetry/tracks?minutes=15');
      } catch {
        trackPoints = [];
      }

      setCustomer(me);
      setFleet(fleetRows);
      setAlerts(alertList);
      setAnomalies(anomalyList);
      setFuelEvents(fuelEvents);
      setFuelEventCount(countActiveFuelEvents(fuelEvents));
      setEfficiency(efficiencyRows);
      setSummary(summaryRow);
      setTodaySummary(todayRow);
      setDrivers(driverRows);
      setLiveTracks(buildVehicleTracks(trackPoints));
      setLastUpdated(new Date());
      setTick((t) => t + 1);
      setError(null);

      setSelectedVehicleId((prev) => {
        if (prev && fleetRows.some((v) => v.id === prev)) return prev;
        return fleetRows[0]?.id ?? null;
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        window.location.replace('/login');
        return;
      }
      // The error object is kept whole, not flattened to a string: the banner
      // needs its kind to say whether the network or the server is at fault.
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!getToken()) {
      window.location.replace('/login');
      return;
    }

    loadDashboard();
    const interval = setInterval(() => {
      if (!document.hidden) loadDashboard();
    }, REFRESH_MS);
    return () => clearInterval(interval);
  }, [router]);

  // Returning to the tab refreshes once, rather than waiting out the interval.
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden || !getToken()) return;
      loadDashboard();
      if (activeViewRef.current === 'live') loadLiveTracks();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadLiveTracks]);

  useEffect(() => {
    if (activeView !== 'live' || !getToken()) return;
    loadLiveTracks();
    loadTrips();
    const interval = setInterval(() => {
      if (!document.hidden) loadLiveTracks();
    }, LIVE_REFRESH_MS);
    // Trips change slowly — refresh on a relaxed cadence
    const tripsInterval = setInterval(() => {
      if (!document.hidden) loadTrips();
    }, 30000);
    return () => {
      clearInterval(interval);
      clearInterval(tripsInterval);
    };
  }, [activeView, loadLiveTracks, loadTrips]);

  // Re-fetch immediately when the user changes trail duration, picks a date
  // range, or opts into the historical widening
  useEffect(() => {
    if (activeView === 'live' && getToken()) loadTrips();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trailMinutes, tripRange, tripFallback]);

  useEffect(() => {
    if (!getToken()) return;
    loadFuelPurchases(fuelPurchasePage, activeView === 'receipts');
  }, [fuelPurchasePage, activeView]);

  // Refetch when the snapshot window changes. Skips the first run so changing
  // the period costs one request, not two on top of the initial load.
  const periodPrimed = useRef(false);
  useEffect(() => {
    if (!periodPrimed.current) {
      periodPrimed.current = true;
      return;
    }
    if (!getToken()) return;
    loadDashboard();
  }, [periodDays]);

  useEffect(() => {
    const hash = globalThis.window?.location.hash.replace('#', '') as DashboardView;
    if (hash && VIEWS.some((v) => v.id === hash)) {
      setActiveView(hash);
    }
  }, []);

  // ⌘K / Ctrl-K focuses the quick-jump, matching the hint rendered in the field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape') {
        setSearchQuery('');
        searchRef.current?.blur();
      }
    };
    globalThis.window?.addEventListener('keydown', onKey);
    return () => globalThis.window?.removeEventListener('keydown', onKey);
  }, []);

  // Unmapped views and not-yet-loaded flags both show, so nothing disappears
  // on a slow response — only an explicit `false` hides an entry.
  const isVisible = (view: DashboardView): boolean => {
    // Replay events replays fuel *leaving* a tank, which needs a level sensor.
    // On GNSS-only hardware it has nothing to show, so it is held for PRO
    // rather than shipped as an empty screen.
    if (PRO_ONLY_VIEWS.has(view) && !isPro()) return false;
    if (view === 'theft' && !IMMOBILIZER_ENABLED) return false;
    const key = VIEW_FLAG[view];
    return key == null || flags[key] !== false;
  };

  const switchView = (view: DashboardView) => {
    setActiveView(view);
    setMobileNavOpen(false);
    if (globalThis.window) {
      globalThis.window.history.replaceState(null, '', `#${view}`);
    }
  };

  const handleViewAlertOnMap = (alert: Alert) => {
    if (alert.vehicle_id) setSelectedVehicleId(alert.vehicle_id);
    switchView('live');
  };

  const handleViewAnomalyOnMap = (anomaly: FuelAnomaly) => {
    if (anomaly.vehicle_id) setSelectedVehicleId(anomaly.vehicle_id);
    switchView('live');
  };

  /**
   * Dismiss one alert from the list.
   *
   * The row is already animating out by the time this runs, so it is removed
   * optimistically — putting it back on failure would be a row flying out and
   * then reappearing, which reads as a bug rather than as an error.
   */
  const handleDismissAlert = async (alert: Alert) => {
    setAlerts((prev) => prev.filter((a) => a.id !== alert.id));
    try {
      await api(`/alerts/${alert.id}/acknowledge`, { method: 'PATCH' });
    } catch {
      // Restore it, since the alert is genuinely still open server-side.
      setAlerts((prev) => [alert, ...prev]);
    }
  };

  const handleAcknowledgeAnomaly = async (id: string) => {
    try {
      await api(`/alerts/${id}/acknowledge`, { method: 'PATCH' });
      setAnomalies((prev) =>
        prev.map((a) => (a.id === id ? { ...a, acknowledged: true } : a))
      );
      setAlerts((prev) => prev.filter((a) => String(a.id) !== id));
    } catch {
      /* keep UI unchanged on failure */
    }
  };

  const handleLogout = () => {
    clearToken();
    clearAuth();
    router.push('/login');
  };

  const handleDeviceAdded = (row: FleetVehicle) => {
    setFleet((prev) => {
      const exists = prev.some((v) => v.id === row.id);
      return exists ? prev.map((v) => (v.id === row.id ? row : v)) : [row, ...prev];
    });
    setSelectedVehicleId(row.id);
    switchView('overview');
  };

  const viewTitle = VIEW_META[activeView].title;

  const todayLabel = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const initials = (customer?.company_name || customer?.name || 'FuelSense')
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();

  /** Badge counts are only meaningful on a handful of destinations. */
  const navBadge: Partial<Record<DashboardView, number | undefined>> = {
    live: liveTracks.length || undefined,
    receipts: fuelPurchases?.total || undefined,
    anomalies: fuelEventCount || undefined,
    alerts: alerts.length || undefined,
  };

  const navItems: RailItem<DashboardView>[] = VIEWS.filter((v) => isVisible(v.id)).map((v) => ({
    id: v.id,
    icon: VIEW_META[v.id].icon,
    label: VIEW_META[v.id].nav,
    badge: navBadge[v.id],
    tag: v.id === 'theft' ? 'Beta' : undefined,
  }));

  // Same items, sectioned per NAV_GROUPS. Built off `navItems` rather than
  // VIEWS directly so a view a feature flag has hidden drops out of its group
  // instead of leaving a labelled section with nothing under it; a group that
  // ends up empty (every view in it flagged off) is dropped entirely.
  const navGroups: RailGroup<DashboardView>[] = NAV_GROUPS.map((g) => ({
    label: g.label,
    items: g.views
      .map((id) => navItems.find((item) => item.id === id))
      .filter((item): item is RailItem<DashboardView> => item != null),
  })).filter((g) => g.items.length > 0);

  /** The Haulix metric strip. Values stay terse — the row has to stay one line. */
  const statPills: StatPill[] = [
    {
      icon: Truck,
      label: 'Active',
      value: `${onlineCount}/${fleet.length}`,
      title: 'Vehicles reporting in the last cycle',
    },
    { icon: Users, label: 'Drivers', value: String(drivers.length) },
    {
      icon: Route,
      label: 'Trips',
      value: String(trips?.vehicles.reduce((n, v) => n + v.trips.length, 0) ?? 0),
    },
    // Efficiency is only shown once the backend has enough distance and fuel to
    // divide; an early "0.0 km/L" would read as a broken fleet rather than a
    // fleet that has not driven yet.
    ...(summary?.avg_efficiency_km_l != null
      ? [
          {
            icon: Fuel,
            label: 'Avg.',
            value: `${Number(summary.avg_efficiency_km_l).toFixed(1)} km/L`,
          } satisfies StatPill,
        ]
      : []),
    {
      // An absolute clock time rather than "12s ago": the relative form has to
      // read the wall clock during render, which is impure and re-renders
      // unpredictably.
      icon: Clock,
      label: 'Updated',
      value: lastUpdated
        ? lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '—',
    },
  ];

  if (loading) {
    return <FleetCommandLoader />;
  }

  /* The rail mark. Falls back to the FuelSense Orbit Node when a white-label
     customer has not supplied their own logo. */
  const brandMark = customer?.logo_url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={customer.logo_url}
      alt={customer.company_name ?? customer.name}
      className="h-9 w-9 rounded-xl object-contain"
    />
  ) : (
    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-y text-accent-y-ink">
      <BrandMark className="h-6 w-6" strokeWidth={4} ariaLabel={customer?.company_name || 'FuelSense'} />
    </div>
  );

  const rail = (
    <IconRail
      brand={brandMark}
      brandLabel={customer?.company_name || customer?.name || 'FuelSense'}
      groups={navGroups}
      active={activeView}
      onSelect={switchView}
      footer={
        <>
          <ThemeToggle />
          <RoundButton icon={LogOut} label="Sign out" onClick={handleLogout} size="sm" />
        </>
      }
    />
  );

  const sidebar = (
    <>
      <div className="px-6 pb-6 pt-8">
        {/* White-label: a customer's own mark and name replace ours wherever
            they have supplied one. Everything falls back to FuelSense branding,
            so an account that has set nothing still looks finished. */}
        <div className="flex items-center gap-2.5">
          {customer?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={customer.logo_url}
              alt={customer.company_name ?? customer.name}
              className="h-7 w-7 shrink-0 rounded object-contain"
            />
          ) : (
            <BrandMark className="h-7 w-7 shrink-0 text-brand" strokeWidth={4} ariaLabel="FuelSense" />
          )}
          <p
            className={`text-2xl font-bold ${customer?.brand_color ? '' : 'neon-text'}`}
            style={customer?.brand_color ? { color: customer.brand_color } : undefined}
          >
            {customer?.company_name || 'FuelSense'}
          </p>
        </div>
        <p className="mt-1 text-[10px] uppercase tracking-wider text-good">
          Command center
        </p>
        <p className="text-xs text-ink-dim">
          {onlineCount}/{fleet.length} online
          {lastUpdated ? ` · ${lastUpdated.toLocaleTimeString()}` : ''}
        </p>
      </div>
      <nav className="px-3">
        {navGroups.map((group, gi) => (
          <div key={group.label} className={gi > 0 ? 'mt-4' : undefined}>
            <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-dim">
              {group.label}
            </p>
            <div className="space-y-1">
              {group.items.map((item) => (
                <NavItem
                  key={item.id}
                  icon={item.icon}
                  label={item.label}
                  badge={item.badge}
                  active={activeView === item.id}
                  onClick={() => switchView(item.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>
    </>
  );

  return (
    <div
      className={`bg-canvas text-ink ${activeView === 'live' ? 'h-screen overflow-hidden' : 'min-h-screen'}`}
    >
      <aside className="fixed left-0 top-0 z-40 hidden h-full border-r border-edge bg-panel lg:block">
        {rail}
      </aside>

      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/60"
            aria-label="Close menu"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="relative h-full w-64 border-r border-edge bg-panel">
            <button
              type="button"
              onClick={() => setMobileNavOpen(false)}
              className="absolute right-3 top-3 rounded p-1 text-ink-mid"
            >
              <X className="h-5 w-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <main
        className={`lg:ml-[76px] ${activeView === 'live' ? 'h-screen overflow-hidden' : ''}`}
      >
        <div
          className={
            activeView === 'live'
              ? 'flex h-full flex-col overflow-hidden px-2 py-3 sm:px-4'
              : 'mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8'
          }
        >
          {/* Metric strip + global search + identity. Scrolls away with the
              page rather than sticking, matching the reference. */}
          <div
            className={`flex flex-wrap items-center justify-between gap-3 ${
              activeView === 'live' ? 'mb-2 shrink-0 px-1' : 'mb-7'
            }`}
          >
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setMobileNavOpen(true)}
                aria-label="Open menu"
                className="rounded-full border border-edge bg-panel p-2.5 lg:hidden"
              >
                <Menu className="h-5 w-5" />
              </button>
              <StatPills items={statPills} className="hidden sm:flex" />
            </div>

            <div className="flex items-center gap-2">
              <div className="relative hidden md:block">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-dim" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  ref={searchRef}
                  placeholder="Search vehicles, trips, or more…"
                  aria-label="Search vehicles and trips"
                  className="w-64 rounded-full border border-edge bg-panel py-2.5 pl-10 pr-14 text-sm text-ink placeholder:text-ink-dim focus:border-accent-y focus:outline-none lg:w-80"
                />
                <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-edge bg-panel-deep px-1.5 py-0.5 text-[10px] font-medium text-ink-dim">
                  ⌘K
                </kbd>
                {searchQuery.trim() !== '' && (
                  <div className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-2xl border border-edge bg-panel shadow-xl">
                    {searchResults.length === 0 ? (
                      <p className="px-4 py-3 text-sm text-ink-dim">
                        No vehicle matches “{searchQuery.trim()}”
                      </p>
                    ) : (
                      searchResults.map((v) => (
                        <button
                          key={v.id}
                          type="button"
                          onClick={() => {
                            setSelectedVehicleId(v.id);
                            setSearchQuery('');
                            searchRef.current?.blur();
                            switchView('vehicle');
                          }}
                          className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-panel-hover"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-ink">
                              {v.license_plate}
                            </span>
                            <span className="block truncate text-xs text-ink-dim">
                              {[v.make, v.model].filter(Boolean).join(' ') || 'Unknown model'}
                              {v.driver_name ? ` · ${v.driver_name}` : ''}
                            </span>
                          </span>
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${
                              v.connection_status === 'online' ? 'bg-good' : 'bg-ink-dim'
                            }`}
                          />
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              <div className="relative">
                <RoundButton
                  icon={Bell}
                  label={`Alerts${alerts.length ? ` (${alerts.length})` : ''}`}
                  onClick={() => switchView('alerts')}
                />
                {alerts.length > 0 && (
                  <span className="pointer-events-none absolute -right-1 -top-1 inline-flex min-w-[1.15rem] justify-center rounded-full bg-bad-bright px-1 text-[10px] font-bold leading-[1.15rem] text-white">
                    {alerts.length > 99 ? '99+' : alerts.length}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2.5 rounded-full border border-edge bg-panel py-1.5 pl-1.5 pr-3.5">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-accent-y text-xs font-bold text-accent-y-ink">
                  {initials}
                </span>
                <div className="hidden leading-tight sm:block">
                  <p className="text-xs font-semibold text-ink">
                    {customer?.company_name || customer?.name || 'FuelSense'}
                  </p>
                  <p className="text-[10px] text-ink-dim">Manager</p>
                </div>
              </div>
            </div>
          </div>

          <header
            className={`flex flex-wrap items-start justify-between gap-4 ${
              activeView === 'live' ? 'mb-2 shrink-0 px-1' : 'mb-8'
            }`}
          >
            <PageHeader
              title={viewTitle}
              subtitle={
                activeView === 'live'
                  ? `${customer?.company_name || customer?.name} · ${onlineCount}/${fleet.length} online · refresh every ${LIVE_REFRESH_MS / 1000}s`
                  : `${todayLabel} · ${
                      lastUpdated
                        ? `updated ${lastUpdated.toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}`
                        : 'updating…'
                    }`
              }
            />
            {/* Theme toggle and sign-out now live in the rail footer, so the
                header keeps only the controls that act on the current view. */}
            <div className="flex flex-wrap items-center gap-2">
              {activeView === 'live' && (
                <button
                  type="button"
                  onClick={() => setFollowVehicle((v) => !v)}
                  className={`rounded-full border px-4 py-2 text-sm transition-colors ${
                    followVehicle
                      ? 'border-good bg-good/10 text-good'
                      : 'border-edge bg-panel text-ink-mid hover:bg-panel-hover'
                  }`}
                >
                  {followVehicle ? 'Following vehicle' : 'Free map'}
                </button>
              )}
              <div className="flex items-center gap-2 rounded-full border border-edge bg-panel px-4 py-2 text-sm">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-good opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-good" />
                </span>
                <span className="text-good">{onlineCount} live</span>
              </div>
              <Link
                href="/dashboard/orders/new"
                className="rounded-full border border-edge bg-panel px-4 py-2 text-sm text-ink-mid transition-colors hover:bg-panel-hover"
              >
                Buy trackers
              </Link>
              <button
                onClick={() => setModalOpen(true)}
                className="flex items-center gap-2 rounded-full bg-accent-y px-4 py-2 text-sm font-semibold text-accent-y-ink transition-opacity hover:opacity-90"
              >
                <Plus className="h-4 w-4" /> Add device
              </button>
            </div>
          </header>

          <LoadErrorBanner
            error={error}
            subject="the dashboard"
            onRetry={() => loadDashboard()}
            className={activeView === 'live' ? 'mb-2 shrink-0' : 'mb-6'}
          />

          {activeView === 'overview' && (
            <div className="space-y-6">
              <TheftAlertBanner alerts={alerts} onViewOnMap={handleViewAlertOnMap} />
              <FleetOperationsOverview
                periodDays={periodDays}
                onPeriodChange={setPeriodDays}
                summary={summary}
                todaySummary={todaySummary}
                efficiency={efficiency}
                efficiencySummary={efficiencySummary}
                alerts={alerts}
                anomalies={anomalies}
                fuelEvents={fuelEvents}
                fleet={fleet}
                onOpenLive={(vehicleId) => {
                  if (vehicleId) setSelectedVehicleId(vehicleId);
                  switchView('live');
                }}
                onOpenAnomalies={() => switchView('anomalies')}
                onViewOnMap={(vehicleId) => {
                  setSelectedVehicleId(vehicleId);
                  switchView('live');
                }}
              />
            </div>
          )}

          {activeView === 'live' && (
            <div className="min-h-0 flex-1 overflow-hidden">
              <LiveMonitoringMap
                tracks={liveTracks}
                trips={trips}
                fleet={fleet}
                startDrawing={autoDrawZone}
                onDrawingStarted={() => setAutoDrawZone(false)}
                initialFocus={pendingTripFocus}
                onFocusConsumed={() => setPendingTripFocus(null)}
                selectedVehicleId={selectedVehicleId}
                onSelectVehicle={setSelectedVehicleId}
                followSelected={followVehicle}
                onUserPan={() => setFollowVehicle(false)}
                trailMinutes={trailMinutes}
                onTrailMinutesChange={(m) => {
                  setTripRange(null);
                  setTripFallback(false);
                  setTrailMinutes(m);
                }}
                dateRange={tripRange}
                onDateRangeChange={(r) => {
                  setTripFallback(false);
                  setTripRange(r);
                }}
                onShowRecentInstead={() => setTripFallback(true)}
              />
            </div>
          )}

          {activeView === 'fuel' && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => switchView('anomalies')}
                  className="rounded-lg border border-bad/40 bg-bad-deep/20 px-4 py-2 text-sm text-bad hover:bg-bad-deep/30"
                >
                  Replay events →
                </button>
              </div>
              <DashboardKpis summary={summary} />
              {efficiencyError && (
                <p className="text-sm text-warn">{efficiencyError}</p>
              )}
              <SavingsDashboard summary={efficiencySummary} />
              <FuelAnalyticsPanel
                efficiency={efficiency}
                efficiencySummary={efficiencySummary}
                anomalies={anomalies}
                onAcknowledgeAnomaly={handleAcknowledgeAnomaly}
                onViewOnMap={handleViewAnomalyOnMap}
              />
              <EstimatedConsumptionTable />
              <FleetEfficiencyReport rows={efficiency} summary={efficiencySummary} />
              <DailyActivityTable
                onViewDay={(vehicleId) => {
                  setSelectedVehicleId(vehicleId);
                  switchView('live');
                }}
              />
              <TelemetryHistoryTable />
              <FuelPurchaseTable
                data={fuelPurchases}
                fleet={fleet}
                page={fuelPurchasePage}
                onPageChange={setFuelPurchasePage}
                onRefresh={() => loadFuelPurchases(fuelPurchasePage, false)}
                onOpenReceipts={() => switchView('receipts')}
              />
            </div>
          )}

          {activeView === 'trips' && (
            <TripHistoryPanel
              onViewTrip={(vehicleId, tripStartAt) => {
                setSelectedVehicleId(vehicleId);
                setPendingTripFocus({ vehicleId, startAt: tripStartAt });
                setFollowVehicle(false);
                switchView('live');
              }}
            />
          )}

          {activeView === 'behavior' && (
            <DrivingBehaviorPanel
              onViewOnMap={(vehicleId) => {
                setSelectedVehicleId(vehicleId);
                switchView('live');
              }}
            />
          )}

          {activeView === 'intel' && <FleetIntelligencePanel />}

          {activeView === 'calibration' && <CalibrationGuidePanel fleet={fleet} />}

          {activeView === 'geofences' && (
            <GeofencesPanel
              onDrawZone={() => {
                setAutoDrawZone(true);
                switchView('live');
              }}
            />
          )}

          {activeView === 'drivers' && (
            <DriverManagementPanel onViewVehicle={() => switchView('vehicle')} />
          )}

          {activeView === 'vehicle' && (
            <VehicleShowcase
              fleet={fleet}
              selectedVehicleId={selectedVehicleId}
              onSelectVehicle={setSelectedVehicleId}
              onOpenLive={(vehicleId) => {
                setSelectedVehicleId(vehicleId);
                switchView('live');
              }}
            />
          )}

          {activeView === 'estimate' && <FuelEstimatePanel />}

          {activeView === 'receipts' && (
            <ReceiptsPanel
              data={fuelPurchases}
              fleet={fleet}
              page={fuelPurchasePage}
              onPageChange={setFuelPurchasePage}
              onRefresh={() => loadFuelPurchases(fuelPurchasePage, true)}
            />
          )}

          {activeView === 'accounting' && <AccountingLedgerPanel />}

          {activeView === 'anomalies' && (
            <FuelAnomaliesPanel
              active={activeView === 'anomalies'}
              onViewOnMap={(lat, lng, vehicleId) => {
                setSelectedVehicleId(vehicleId);
                switchView('live');
              }}
            />
          )}

          {activeView === 'theft' && <TheftPanel fleet={fleet} alerts={alerts} />}

          {activeView === 'alerts' && (
            <div className="rounded-lg border border-edge bg-panel p-6">
              <h2 className="font-semibold text-ink">All active alerts</h2>
              <p className="mt-1 text-xs text-ink-dim">
                Fuel anomaly alerts include GPS coordinates from the tracker
              </p>
              <div className="mt-4">
                <AlertsList
                  alerts={alerts}
                  onViewOnMap={handleViewAlertOnMap}
                  onDismiss={handleDismissAlert}
                />
              </div>
            </div>
          )}

          {activeView === 'settings' && (
            /* Settings was three components with three different container
               styles stacked in a full-width column, which read as unrelated
               pages. One Panel shell, one column width, and the shortcuts as a
               uniform icon grid pulls it back into a single screen. */
            <div className="mx-auto max-w-4xl space-y-4">
              <Panel
                icon={Settings}
                title="Fleet setup"
                subtitle="Register hardware and hand drivers the tools they need"
              >
                <div className="grid gap-2.5 sm:grid-cols-3">
                  {[
                    {
                      key: 'add-device',
                      icon: Plus,
                      title: 'Add vehicle + IMEI',
                      hint: 'Register a new tracker',
                      onClick: () => setModalOpen(true),
                    },
                    {
                      key: 'driver-portal',
                      icon: ReceiptText,
                      title: 'Driver receipt portal',
                      hint: 'Mobile upload — matches OBD automatically',
                      href: '/driver',
                    },
                    {
                      key: 'order',
                      icon: Truck,
                      title: 'Order trackers',
                      hint: 'Buy additional FMC150 devices',
                      href: '/dashboard/orders/new',
                    },
                  ].map(({ key, icon: ItemIcon, title, hint, onClick, href }) => {
                    const body = (
                      <>
                        <span className="mb-2.5 flex h-10 w-10 items-center justify-center rounded-xl border border-edge bg-canvas text-ink-mid">
                          <ItemIcon className="h-[18px] w-[18px]" />
                        </span>
                        <span className="block text-sm font-semibold text-ink">{title}</span>
                        <span className="mt-0.5 block text-xs leading-snug text-ink-dim">
                          {hint}
                        </span>
                      </>
                    );
                    const shell =
                      'block rounded-xl border border-edge bg-panel-deep p-4 text-left transition-colors hover:bg-panel-hover';
                    return href ? (
                      <Link key={key} href={href} className={shell}>
                        {body}
                      </Link>
                    ) : (
                      <button key={key} type="button" onClick={onClick} className={shell}>
                        {body}
                      </button>
                    );
                  })}
                </div>
              </Panel>

              <FuelPricePanel />
              <DriverSettingsPanel
                drivers={drivers}
                fleet={fleet}
                onAssigned={loadDashboard}
              />
            </div>
          )}
        </div>
      </main>

      <AddDeviceModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onAdded={handleDeviceAdded}
      />

      <SiphonEventsSidebar
        isOpen={siphonSidebarOpen}
        onClose={() => setSiphonSidebarOpen(false)}
        onViewOnMap={(lat, lng, vehicleId) => {
          setSelectedVehicleId(vehicleId);
          setSiphonSidebarOpen(false);
          switchView('live');
        }}
      />
    </div>
  );
}

function NavItem({
  icon: Icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
        active
          ? 'border-l-2 border-l-brand bg-accent/10 text-brand'
          : 'text-ink-mid hover:bg-panel-hover'
      }`}
    >
      <Icon className="h-5 w-5 shrink-0" />
      <span>{label}</span>
      {badge != null && badge > 0 && (
        <span className="ml-auto rounded-full bg-good/20 px-1.5 py-0.5 text-xs text-good">
          {badge}
        </span>
      )}
    </button>
  );
}
