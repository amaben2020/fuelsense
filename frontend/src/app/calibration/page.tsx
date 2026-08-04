'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, CircleDashed, Fuel, Gauge, Satellite } from 'lucide-react';
import { api, getToken } from '@/lib/api';

interface FuelConfig {
  vehicle_types: Array<{
    key: string;
    label: string;
    consumption_l_per_100km: number;
    idle_burn_l_per_hour: number;
  }>;
  speed_buckets: Array<{ label: string; up_to_kph: number | null; multiplier: number }>;
  calibration_min_purchases: number;
}

interface CalibrationVehicle {
  vehicle_id: string;
  license_plate: string;
  vehicle_type_label: string;
  rate_l_per_100km: number | null;
  rate_source: string;
  purchases_logged: number;
  usable_measurements: number;
  distance_mismatches: number;
  fill_ups_until_calibrated: number;
}

export default function CalibrationPage() {
  const [config, setConfig] = useState<FuelConfig | null>(null);
  const [status, setStatus] = useState<CalibrationVehicle[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      setError('Sign in to view calibration status.');
      return;
    }
    Promise.all([
      api<FuelConfig>('/features/fuel-config'),
      api<{ vehicles: CalibrationVehicle[] }>('/features/calibration-status'),
    ])
      .then(([cfg, st]) => {
        setConfig(cfg);
        setStatus(st.vehicles);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const threshold = config?.calibration_min_purchases ?? 2;

  return (
    <main className="min-h-screen bg-canvas px-6 py-10">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-sm text-ink-dim hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" /> Back to dashboard
        </Link>

        <h1 className="mt-4 text-2xl font-bold text-ink">How your fuel numbers are worked out</h1>
        <p className="mt-2 text-sm text-ink-mid">
          Estimates start rough and get sharper as your drivers log fill-ups. Here is exactly
          how that works, and where each of your vehicles currently stands.
        </p>

        {error && <p className="mt-6 rounded-lg bg-bad-deep/20 p-4 text-sm text-bad">{error}</p>}

        <Section
          icon={Satellite}
          title="Why we work it out from movement, not a fuel gauge"
        >
          <p>
            Reading a tank directly means trusting the vehicle&apos;s own fuel sensor, and across
            this fleet those readings have proven unreliable. Rather than show you a number we
            can&apos;t stand behind, FuelSense works fuel out from things we can measure
            accurately: how far the vehicle actually moved, how long it idled, and what your
            drivers actually bought.
          </p>
        </Section>

        <Section icon={Fuel} title="Where a new vehicle starts">
          <p>
            A vehicle we&apos;ve never seen before starts on the typical figure for its class.
            It&apos;s an industry average, not your vehicle — a fair starting point, nothing more.
          </p>
          {config && (
            <div className="mt-3 overflow-x-auto rounded-lg border border-edge">
              <table className="w-full text-sm">
                <thead className="bg-panel text-left text-xs uppercase tracking-wider text-ink-dim">
                  <tr>
                    <th className="px-4 py-2">Class</th>
                    <th className="px-4 py-2">Starting rate</th>
                    <th className="px-4 py-2">Idling</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-divider">
                  {config.vehicle_types.map((v) => (
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
          )}
        </Section>

        <Section icon={Gauge} title="How it becomes your vehicle's real number">
          <p>
            Every time a driver logs a fill-up with the odometer reading, we do a simple sum:
            the litres they bought, divided by the distance covered since the last fill-up. That
            is this vehicle&apos;s real consumption — measured, not assumed.
          </p>
          <p className="mt-2">
            After <strong className="text-ink">{threshold} logged fill-ups</strong>, we stop using
            the class average altogether and switch to your vehicle&apos;s own figure, kept as a
            rolling average of its recent fill-ups so it tracks the vehicle as it ages.
          </p>
          <p className="mt-2 text-ink-dim">
            Readings that can&apos;t be right — an odometer that went backwards, didn&apos;t move,
            or jumped thousands of kilometres — are set aside rather than allowed to drag the
            number around.
          </p>
        </Section>

        <Section icon={Satellite} title="How we check the odometer is telling the truth">
          <p>
            The tracker already knows how far the vehicle went. So when a fill-up is logged, we
            compare the odometer distance against what GPS recorded for the same period. If the
            two disagree by more than 15%, the purchase is flagged rather than quietly accepted —
            it usually means a mistyped reading or a tracker that lost signal, and occasionally
            something worth asking about.
          </p>
        </Section>

        <Section icon={CheckCircle2} title="What you can do to make it sharper">
          <ul className="list-disc space-y-1 pl-5">
            <li>Log every fill-up, not just some — gaps break the distance-to-litres link.</li>
            <li>Enter the odometer exactly as shown. Rounding to the nearest hundred introduces error the maths can&apos;t recover.</li>
            <li>Where possible keep vehicles in areas with GPS coverage, so the cross-check has something to compare against.</li>
          </ul>
        </Section>

        <section className="mt-8 mb-16">
          <h2 className="text-lg font-semibold text-ink">Where your vehicles stand right now</h2>
          {status.length === 0 && !error && (
            <p className="mt-2 text-sm text-ink-dim">Loading…</p>
          )}
          {status.length > 0 && (
            <div className="mt-3 overflow-x-auto rounded-lg border border-edge">
              <table className="w-full text-sm">
                <thead className="bg-panel text-left text-xs uppercase tracking-wider text-ink-dim">
                  <tr>
                    <th className="px-4 py-2">Vehicle</th>
                    <th className="px-4 py-2">Rate in use</th>
                    <th className="px-4 py-2">Based on</th>
                    <th className="px-4 py-2">Fill-ups logged</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-divider">
                  {status.map((v) => {
                    const calibrated = v.rate_source === 'calibrated';
                    return (
                      <tr key={v.vehicle_id}>
                        <td className="px-4 py-2">
                          <span className="text-ink">{v.license_plate}</span>
                          <span className="ml-2 text-xs text-ink-dim">{v.vehicle_type_label}</span>
                        </td>
                        <td className="px-4 py-2 font-mono text-ink-mid">
                          {v.rate_l_per_100km ?? '—'} L/100km
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                              calibrated ? 'bg-good/15 text-good' : 'bg-warn/15 text-warn'
                            }`}
                          >
                            {calibrated ? (
                              <>
                                <CheckCircle2 className="h-3 w-3" /> This vehicle&apos;s own data
                              </>
                            ) : (
                              <>
                                <CircleDashed className="h-3 w-3" /> Class average
                              </>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-ink-mid">
                          {v.usable_measurements} usable
                          {!calibrated && v.fill_ups_until_calibrated > 0 && (
                            <span className="ml-1 text-xs text-ink-dim">
                              · {v.fill_ups_until_calibrated} more to switch over
                            </span>
                          )}
                          {v.distance_mismatches > 0 && (
                            <span className="ml-1 text-xs text-warn">
                              · {v.distance_mismatches} flagged
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Fuel;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
        <Icon className="h-4 w-4 text-brand" /> {title}
      </h2>
      <div className="mt-2 text-sm leading-relaxed text-ink-mid">{children}</div>
    </section>
  );
}
