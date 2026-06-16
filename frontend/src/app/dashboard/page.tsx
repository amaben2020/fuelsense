'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  Fuel,
  Menu,
  Play,
  Plus,
  Radio,
  Receipt,
  Settings,
  X,
} from 'lucide-react';
import {
  Alert,
  api,
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
  getToken,
  TrackPoint,
} from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { buildVehicleTracks } from '@/lib/map-utils';
import { AddDeviceModal } from '@/components/AddDeviceModal';
import { FleetOperationsOverview } from '@/components/dashboard/FleetOperationsOverview';
import { DashboardKpis } from '@/components/dashboard/DashboardKpis';
import { DriverSettingsPanel } from '@/components/dashboard/DriverSettingsPanel';
import { DailyActivityTable } from '@/components/dashboard/DailyActivityTable';
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
import { FleetCommandLoader } from '@/components/dashboard/FleetCommandLoader';

const REFRESH_MS = 3000;
const LIVE_REFRESH_MS = 2000;

type DashboardView = 'overview' | 'live' | 'fuel' | 'receipts' | 'anomalies' | 'alerts' | 'settings';

const VIEWS: { id: DashboardView; label: string; hash: string }[] = [
  { id: 'overview', label: 'Operations', hash: 'overview' },
  { id: 'live', label: 'Live monitoring', hash: 'live' },
  { id: 'fuel', label: 'Fuel analytics', hash: 'fuel' },
  { id: 'receipts', label: 'Receipts', hash: 'receipts' },
  { id: 'anomalies', label: 'Replay events', hash: 'anomalies' },
  { id: 'alerts', label: 'Alerts', hash: 'alerts' },
  { id: 'settings', label: 'Settings', hash: 'settings' },
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [efficiencyError, setEfficiencyError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [activeView, setActiveView] = useState<DashboardView>('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const [followVehicle, setFollowVehicle] = useState(true);
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

  const loadLiveTracks = async () => {
    try {
      const trackPoints = await api<TrackPoint[]>('/telemetry/tracks?minutes=30');
      setLiveTracks(buildVehicleTracks(trackPoints));
    } catch {
      // no-op — keep existing tracks on error
    }
  };

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
          '/telemetry/fleet-efficiency?days=7'
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
        summaryRow = await api<DashboardSummary>('/dashboard/summary?days=7');
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

      let trackPoints: TrackPoint[] = [];
      try {
        trackPoints = await api<TrackPoint[]>('/telemetry/tracks?minutes=90');
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
      if (err instanceof Error && err.message.includes('401')) {
        clearToken();
        router.replace('/login');
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }

    loadDashboard();
    const interval = setInterval(loadDashboard, REFRESH_MS);
    return () => clearInterval(interval);
  }, [router]);

  useEffect(() => {
    if (activeView !== 'live' || !getToken()) return;

    const poll = () => loadLiveTracks();
    poll();
    const interval = setInterval(poll, LIVE_REFRESH_MS);
    return () => clearInterval(interval);
  }, [activeView]);

  useEffect(() => {
    if (!getToken()) return;
    loadFuelPurchases(fuelPurchasePage, activeView === 'receipts');
  }, [fuelPurchasePage, activeView]);

  useEffect(() => {
    const hash = globalThis.window?.location.hash.replace('#', '') as DashboardView;
    if (hash && VIEWS.some((v) => v.id === hash)) {
      setActiveView(hash);
    }
  }, []);

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

  const viewTitle = {
    overview: 'Operations',
    live: 'Live monitoring',
    fuel: 'Fuel analytics',
    receipts: 'Receipts',
    anomalies: 'Replay events',
    alerts: 'Alerts',
    settings: 'Settings',
  }[activeView];

  if (loading) {
    return <FleetCommandLoader />;
  }

  const sidebar = (
    <>
      <div className="px-6 pb-6 pt-8">
        <p className="text-2xl font-bold text-[#b8c3ff]">FuelSense</p>
        <p className="mt-1 text-[10px] uppercase tracking-wider text-[#4edea3]">
          Command center
        </p>
        <p className="text-xs text-[#8e90a2]">
          {onlineCount}/{fleet.length} online
          {lastUpdated ? ` · ${lastUpdated.toLocaleTimeString()}` : ''}
        </p>
      </div>
      <nav className="space-y-1 px-3">
        <NavItem
          icon={Activity}
          label="Fleet overview"
          active={activeView === 'overview'}
          onClick={() => switchView('overview')}
        />
        <NavItem
          icon={Radio}
          label="Live monitoring"
          active={activeView === 'live'}
          onClick={() => switchView('live')}
          badge={liveTracks.length || undefined}
        />
        <NavItem
          icon={Fuel}
          label="Fuel analytics"
          active={activeView === 'fuel'}
          onClick={() => switchView('fuel')}
        />
        <NavItem
          icon={Receipt}
          label="Receipts"
          badge={fuelPurchases?.total || undefined}
          active={activeView === 'receipts'}
          onClick={() => switchView('receipts')}
        />
        <NavItem
          icon={Play}
          label="Replay events"
          badge={fuelEventCount || undefined}
          active={activeView === 'anomalies'}
          onClick={() => switchView('anomalies')}
        />
        <NavItem
          icon={AlertTriangle}
          label="Alerts"
          badge={alerts.length || undefined}
          active={activeView === 'alerts'}
          onClick={() => switchView('alerts')}
        />
        <NavItem
          icon={Settings}
          label="Settings"
          active={activeView === 'settings'}
          onClick={() => switchView('settings')}
        />
      </nav>
    </>
  );

  return (
    <div
      className={`bg-[#0b1326] text-[#dae2fd] ${activeView === 'live' ? 'h-screen overflow-hidden' : 'min-h-screen'}`}
    >
      <aside className="fixed left-0 top-0 z-40 hidden h-full w-64 border-r border-[#434656] bg-[#171f33] lg:block">
        {sidebar}
      </aside>

      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/60"
            aria-label="Close menu"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="relative h-full w-64 border-r border-[#434656] bg-[#171f33]">
            <button
              type="button"
              onClick={() => setMobileNavOpen(false)}
              className="absolute right-3 top-3 rounded p-1 text-[#c4c5d9]"
            >
              <X className="h-5 w-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <main className={`lg:ml-64 ${activeView === 'live' ? 'h-screen overflow-hidden' : ''}`}>
        <div
          className={
            activeView === 'live'
              ? 'flex h-full flex-col overflow-hidden px-2 py-3 sm:px-4'
              : 'mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8'
          }
        >
          <header
            className={`flex flex-wrap items-start justify-between gap-4 ${
              activeView === 'live' ? 'mb-2 shrink-0 px-1' : 'mb-8'
            }`}
          >
            <div className="flex items-start gap-3">
              <button
                type="button"
                onClick={() => setMobileNavOpen(true)}
                className="rounded-lg border border-[#434656] bg-[#171f33] p-2 lg:hidden"
              >
                <Menu className="h-5 w-5" />
              </button>
              <div>
                <h1 className="text-2xl font-bold text-[#dae2fd]">{viewTitle}</h1>
                {activeView !== 'live' && (
                  <>
                    <p className="mt-1 text-[#c4c5d9]">
                      {customer?.company_name || customer?.name} · Real-time fuel intelligence
                    </p>
                    <p className="mt-1 text-xs text-[#8e90a2]">
                      Refresh #{tick} · every {REFRESH_MS / 1000}s
                    </p>
                  </>
                )}
                {activeView === 'live' && (
                  <p className="mt-1 text-xs text-[#8e90a2]">
                    {customer?.company_name || customer?.name} · {onlineCount} vehicles · refresh
                    every {LIVE_REFRESH_MS / 1000}s
                  </p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {activeView === 'live' && (
                <button
                  type="button"
                  onClick={() => setFollowVehicle((v) => !v)}
                  className={`rounded-lg border px-3 py-2 text-sm ${
                    followVehicle
                      ? 'border-[#4edea3] bg-[#4edea3]/10 text-[#4edea3]'
                      : 'border-[#434656] bg-[#171f33] text-[#c4c5d9]'
                  }`}
                >
                  {followVehicle ? 'Following vehicle' : 'Free map'}
                </button>
              )}
              <div className="flex items-center gap-2 rounded-lg border border-[#434656] bg-[#171f33] px-3 py-2 text-sm">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#4edea3] opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-[#4edea3]" />
                </span>
                <span className="text-[#4edea3]">{onlineCount} live</span>
              </div>
              <Link
                href="/dashboard/orders/new"
                className="rounded-lg border border-[#434656] bg-[#171f33] px-4 py-2 text-sm text-[#c4c5d9] hover:bg-[#222a3d]"
              >
                Buy trackers
              </Link>
              <button
                onClick={() => setModalOpen(true)}
                className="flex items-center gap-2 rounded-lg bg-[#2e5bff] px-4 py-2 text-sm font-medium text-white hover:bg-[#2448cc]"
              >
                <Plus className="h-4 w-4" /> Add device
              </button>
              <button
                onClick={handleLogout}
                className="rounded-lg border border-[#434656] bg-[#171f33] px-4 py-2 text-sm text-[#c4c5d9] hover:bg-[#222a3d]"
              >
                Sign out
              </button>
            </div>
          </header>

          {error && (
            <div
              className={`rounded-lg border border-[#ffb95f]/40 bg-[#996100]/20 p-4 text-[#ffb95f] ${
                activeView === 'live' ? 'mb-2 shrink-0' : 'mb-6'
              }`}
            >
              {error}
            </div>
          )}

          {activeView === 'overview' && (
            <div className="space-y-6">
              <TheftAlertBanner alerts={alerts} onViewOnMap={handleViewAlertOnMap} />
              <FleetOperationsOverview
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
                fleet={fleet}
                selectedVehicleId={selectedVehicleId}
                onSelectVehicle={setSelectedVehicleId}
                followSelected={followVehicle}
                onUserPan={() => setFollowVehicle(false)}
              />
            </div>
          )}

          {activeView === 'fuel' && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => switchView('anomalies')}
                  className="rounded-lg border border-[#ffb4ab]/40 bg-[#93000a]/20 px-4 py-2 text-sm text-[#ffb4ab] hover:bg-[#93000a]/30"
                >
                  Replay events →
                </button>
              </div>
              <DashboardKpis summary={summary} />
              {efficiencyError && (
                <p className="text-sm text-[#ffb95f]">{efficiencyError}</p>
              )}
              <SavingsDashboard summary={efficiencySummary} />
              <FuelAnalyticsPanel
                efficiency={efficiency}
                efficiencySummary={efficiencySummary}
                anomalies={anomalies}
                onAcknowledgeAnomaly={handleAcknowledgeAnomaly}
                onViewOnMap={handleViewAnomalyOnMap}
              />
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

          {activeView === 'receipts' && (
            <ReceiptsPanel
              data={fuelPurchases}
              fleet={fleet}
              page={fuelPurchasePage}
              onPageChange={setFuelPurchasePage}
              onRefresh={() => loadFuelPurchases(fuelPurchasePage, true)}
            />
          )}

          {activeView === 'anomalies' && (
            <FuelAnomaliesPanel
              active={activeView === 'anomalies'}
              onViewOnMap={(lat, lng, vehicleId) => {
                setSelectedVehicleId(vehicleId);
                switchView('live');
              }}
            />
          )}

          {activeView === 'alerts' && (
            <div className="rounded-lg border border-[#434656] bg-[#171f33] p-6">
              <h2 className="font-semibold text-[#dae2fd]">All active alerts</h2>
              <p className="mt-1 text-xs text-[#8e90a2]">
                Fuel anomaly alerts include GPS coordinates from the tracker
              </p>
              <div className="mt-4">
                <AlertsList alerts={alerts} onViewOnMap={handleViewAlertOnMap} />
              </div>
            </div>
          )}

          {activeView === 'settings' && (
            <div className="space-y-6">
              <div className="rounded-lg border border-[#434656] bg-[#171f33] p-6">
                <h2 className="font-semibold text-[#dae2fd]">Fleet settings</h2>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setModalOpen(true)}
                    className="rounded-lg border border-[#434656] bg-[#0b1326] px-4 py-3 text-left text-sm hover:bg-[#222a3d]"
                  >
                    <p className="font-medium text-[#dae2fd]">Add vehicle + IMEI</p>
                    <p className="text-xs text-[#8e90a2]">Register a new tracker</p>
                  </button>
                <Link
                  href="/driver"
                  className="rounded-lg border border-[#434656] bg-[#0b1326] px-4 py-3 text-left text-sm hover:bg-[#222a3d]"
                >
                  <p className="font-medium text-[#dae2fd]">Driver receipt portal</p>
                  <p className="text-xs text-[#8e90a2]">Mobile upload — matches OBD automatically</p>
                </Link>
                <Link
                  href="/dashboard/orders/new"
                  className="rounded-lg border border-[#434656] bg-[#0b1326] px-4 py-3 text-left text-sm hover:bg-[#222a3d]"
                >
                  <p className="font-medium text-[#dae2fd]">Order trackers</p>
                  <p className="text-xs text-[#8e90a2]">Buy additional FMC150 devices</p>
                </Link>
                </div>
              </div>
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
          ? 'border-l-2 border-l-[#b8c3ff] bg-[#2e5bff]/10 text-[#b8c3ff]'
          : 'text-[#c4c5d9] hover:bg-[#222a3d]'
      }`}
    >
      <Icon className="h-5 w-5 shrink-0" />
      <span>{label}</span>
      {badge != null && badge > 0 && (
        <span className="ml-auto rounded-full bg-[#4edea3]/20 px-1.5 py-0.5 text-xs text-[#4edea3]">
          {badge}
        </span>
      )}
    </button>
  );
}
