'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Truck } from 'lucide-react';
import {
  DriverSession,
  clearDriverToken,
  fetchDriverMe,
  getDriverToken,
  setDriverToken,
  driverLogin,
} from '@/lib/driver-api';
import { DriverTabBar, DriverTab } from '@/components/driver/DriverTabBar';
import { DriverFuelScreen } from '@/components/driver/DriverFuelScreen';
import { DriverVehicleScreen } from '@/components/driver/DriverVehicleScreen';
import { DriverTripsScreen } from '@/components/driver/DriverTripsScreen';

const TEST_DRIVERS = [
  { code: 'CHIDI-ABC', pin: '1234', name: 'Chidi · ABC-123' },
  { code: 'AMARA-456', pin: '1234', name: 'Amara · LAG-456-CD' },
  { code: 'NGOZI-789', pin: '1234', name: 'Ngozi · LAG-789-EF' },
];

export default function DriverPortalPage() {
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<DriverTab>('fuel');
  const [driverCode, setDriverCode] = useState('CHIDI-ABC');
  const [pin, setPin] = useState('1234');
  const [driver, setDriver] = useState<DriverSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (!getDriverToken()) return;
    fetchDriverMe()
      .then((d) => {
        setDriver(d);
        setAuthed(true);
      })
      .catch(() => {
        clearDriverToken();
      });
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const { token, driver: session } = await driverLogin(driverCode.trim().toUpperCase(), pin);
      setDriverToken(token);
      setDriver(session);
      setAuthed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    }
  };

  const logout = () => {
    clearDriverToken();
    setDriver(null);
    setAuthed(false);
  };

  if (!authed) {
    return (
      <div className="min-h-screen bg-canvas px-4 py-8">
        <div className="mx-auto max-w-md">
          <div className="mb-8 flex items-center gap-3">
            <div className="rounded-xl bg-accent/20 p-2.5">
              <Truck className="h-7 w-7 text-brand" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-ink">FuelSense Driver</h1>
              <p className="text-sm text-ink-dim">Mobile fuel & fleet portal</p>
            </div>
          </div>

          <form onSubmit={handleLogin} className="space-y-4 rounded-2xl border border-edge bg-panel p-5">
            {error && <p className="text-sm text-bad">{error}</p>}
            <label className="block text-xs text-ink-dim">
              Driver code
              <input
                value={driverCode}
                onChange={(e) => setDriverCode(e.target.value)}
                autoComplete="username"
                className="mt-1 w-full rounded-xl border border-edge bg-canvas px-3 py-3 text-base text-ink"
              />
            </label>
            <label className="block text-xs text-ink-dim">
              PIN
              <input
                type="password"
                inputMode="numeric"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                autoComplete="current-password"
                className="mt-1 w-full rounded-xl border border-edge bg-canvas px-3 py-3 text-base text-ink"
              />
            </label>
            <button
              type="submit"
              className="w-full rounded-xl bg-accent py-3.5 text-sm font-semibold text-white"
            >
              Sign in
            </button>
          </form>

          <div className="mt-6">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-dim">
              Test drivers
            </p>
            <div className="space-y-2">
              {TEST_DRIVERS.map((d) => (
                <button
                  key={d.code}
                  type="button"
                  onClick={() => {
                    setDriverCode(d.code);
                    setPin(d.pin);
                  }}
                  className="w-full rounded-xl border border-edge bg-panel/60 px-4 py-3 text-left text-sm text-ink-mid active:bg-panel-hover"
                >
                  <span className="font-mono text-brand">{d.code}</span>
                  <span className="text-ink-dim"> · PIN {d.pin}</span>
                  <span className="block text-xs text-ink-dim">{d.name}</span>
                </button>
              ))}
            </div>
          </div>

          <Link
            href="/login"
            className="mt-6 block text-center text-xs text-ink-dim hover:text-brand"
          >
            Fleet manager login →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-canvas pb-24">
      <header className="sticky top-0 z-30 border-b border-edge bg-canvas/95 px-4 py-4 backdrop-blur-md">
        <div className="mx-auto flex max-w-lg items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-wider text-good">Driver</p>
            <p className="font-semibold text-ink">{driver?.name}</p>
            <p className="text-xs text-ink-dim">
              {driver?.license_plate ?? 'No vehicle'} · {driver?.driver_code}
            </p>
          </div>
          <button type="button" onClick={logout} className="text-xs text-ink-dim">
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-lg px-4 py-4">
        {tab === 'fuel' && driver && (
          <DriverFuelScreen driver={driver} onPendingChange={setPendingCount} />
        )}
        {tab === 'vehicle' && <DriverVehicleScreen />}
        {tab === 'trips' && <DriverTripsScreen />}
      </main>

      <DriverTabBar active={tab} onChange={setTab} pendingCount={pendingCount} />
    </div>
  );
}
