'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, Bell, Info, ShieldAlert } from 'lucide-react';
import { api, getToken } from '@/lib/api';

interface DocAlert {
  type: string;
  label: string;
  severity: 'critical' | 'warning' | 'info';
  meaning: string;
  trigger: string;
  source: 'analysis' | 'device';
  emailable: boolean;
  email_enabled: boolean;
}

interface DocPayload {
  alerts: DocAlert[];
  fuel: {
    vehicle_types: Array<{
      key: string;
      label: string;
      consumption_l_per_100km: number;
      idle_burn_l_per_hour: number;
    }>;
    speed_buckets: Array<{ label: string; up_to_kph: number | null; multiplier: number }>;
    calibration_min_purchases: number;
  };
  limitations: string[];
}

const SEVERITY_STYLE: Record<DocAlert['severity'], string> = {
  critical: 'bg-bad/15 text-bad',
  warning: 'bg-warn/15 text-warn',
  info: 'bg-good/15 text-good',
};

const SEVERITY_ICON = {
  critical: ShieldAlert,
  warning: AlertTriangle,
  info: Info,
};

export default function DocumentationPage() {
  const [doc, setDoc] = useState<DocPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      setError('Sign in to view documentation.');
      return;
    }
    api<DocPayload>('/features/documentation')
      .then(setDoc)
      .catch((e) => setError((e as Error).message));
  }, []);

  return (
    <main className="min-h-screen bg-canvas px-6 py-10">
      <div className="mx-auto max-w-4xl">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-sm text-ink-dim hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" /> Back to dashboard
        </Link>

        <h1 className="mt-4 text-2xl font-bold text-ink">Documentation</h1>
        <p className="mt-1 text-sm text-ink-mid">
          What FuelSense watches for, how it decides, and where the limits are.
        </p>

        {error && (
          <p className="mt-6 rounded-lg bg-bad-deep/20 p-4 text-sm text-bad">{error}</p>
        )}

        {!doc && !error && <p className="mt-8 text-sm text-ink-dim">Loading…</p>}

        {doc && (
          <>
            <section className="mt-10">
              <h2 className="text-lg font-semibold text-ink">Alerts</h2>
              <p className="mt-1 text-sm text-ink-dim">
                Every alert the platform can raise. Those marked{' '}
                <span className="text-brand">Email</span> can also be sent to your inbox —
                nothing is emailed unless you switch it on.
              </p>

              <div className="mt-4 space-y-3">
                {doc.alerts.map((a) => {
                  const Icon = SEVERITY_ICON[a.severity];
                  return (
                    <div
                      key={a.type}
                      className="rounded-lg border border-edge bg-panel p-4"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${SEVERITY_STYLE[a.severity]}`}
                        >
                          <Icon className="h-3 w-3" /> {a.severity}
                        </span>
                        <h3 className="font-medium text-ink">{a.label}</h3>
                        <span className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-ink-dim">
                          {a.type}
                        </span>
                        {a.source === 'device' && (
                          <span className="text-[11px] text-ink-dim">needs tracker config</span>
                        )}
                        {a.emailable && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-brand">
                            <Bell className="h-3 w-3" />
                            Email {a.email_enabled ? 'on' : 'off'}
                          </span>
                        )}
                      </div>
                      <p className="mt-2 text-sm text-ink-mid">{a.meaning}</p>
                      <p className="mt-1 text-xs text-ink-dim">
                        <span className="text-ink-mid">Fires when:</span> {a.trigger}
                      </p>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="mt-10">
              <h2 className="text-lg font-semibold text-ink">How fuel estimates work</h2>
              <p className="mt-1 text-sm text-ink-mid">
                Every vehicle starts on an industry average for its class, then switches to
                its own measured rate once{' '}
                <strong className="text-ink">
                  {doc.fuel.calibration_min_purchases} fill-ups
                </strong>{' '}
                have been logged with odometer readings.
              </p>

              <div className="mt-4 overflow-x-auto rounded-lg border border-edge">
                <table className="w-full text-sm">
                  <thead className="bg-panel text-left text-xs uppercase tracking-wider text-ink-dim">
                    <tr>
                      <th className="px-4 py-2">Vehicle class</th>
                      <th className="px-4 py-2">Starting rate</th>
                      <th className="px-4 py-2">Idle burn</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-divider">
                    {doc.fuel.vehicle_types.map((v) => (
                      <tr key={v.key}>
                        <td className="px-4 py-2 text-ink">{v.label}</td>
                        <td className="px-4 py-2 font-mono text-ink-mid">
                          {v.consumption_l_per_100km} L/100km
                        </td>
                        <td className="px-4 py-2 font-mono text-ink-mid">
                          {v.idle_burn_l_per_hour} L/h
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="mt-4 text-sm text-ink-mid">
                Estimates also adjust for how the vehicle was driven — fuel economy is worse
                in stop-start traffic and at sustained high speed than at a steady cruise:
              </p>
              <ul className="mt-2 space-y-1 text-sm text-ink-dim">
                {doc.fuel.speed_buckets.map((b) => (
                  <li key={b.label}>
                    <span className="text-ink-mid">{b.label}</span>
                    {b.up_to_kph ? ` (under ${b.up_to_kph} km/h)` : ' (fastest)'} — ×
                    {b.multiplier}
                  </li>
                ))}
              </ul>
            </section>

            <section className="mt-10 mb-16">
              <h2 className="text-lg font-semibold text-ink">What this does not do</h2>
              <p className="mt-1 text-sm text-ink-dim">
                Worth being straight about, so the numbers are read for what they are.
              </p>
              <ul className="mt-3 space-y-2">
                {doc.limitations.map((l) => (
                  <li
                    key={l}
                    className="rounded-lg border-l-2 border-l-warn bg-warn-deep/10 px-4 py-3 text-sm text-ink-mid"
                  >
                    {l}
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
