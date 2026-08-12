'use client';

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';
import {
  ArrowUpRight,
  CheckCircle2,
  Cpu,
  Fuel,
  Gauge,
  Settings2,
  TriangleAlert,
} from 'lucide-react';
import { Panel, StatusChip } from '@/components/ui/chrome';
import {
  ECONOMY_UNIT_LABELS,
  EconomyUnit,
  FleetVehicle,
  VehicleCalibrationStatus,
  fetchCalibrationStatus,
  setVehicleEconomy,
} from '@/lib/api';

const Tracker3D = dynamic(() => import('./Tracker3D').then((m) => m.Tracker3D), { ssr: false });

/**
 * The Configurator values a fitter types in. These drive the device's own fuel
 * algorithm — with them blank, AVL 12 barely moves and the virtual tank cannot
 * track real burn, which is the single most common reason a fleet's numbers
 * look wrong.
 */
const CONFIGURATOR_ROWS: { field: string; value: string; note: string }[] = [
  { field: 'City consumption', value: '12.5 l/100km', note: 'Referenced at 30 km/h' },
  { field: 'Average consumption', value: '10.0 l/100km', note: 'Referenced at 60 km/h' },
  { field: 'Highway consumption', value: '8.5 l/100km', note: 'Referenced at 90 km/h' },
  { field: 'Consumption on idling', value: '1.4 l/h', note: 'Default 1.0 is low for a 2.5 L with AC' },
  { field: 'Correction coefficient', value: '1', note: 'Leave until two receipts disagree' },
];

const IO_ROWS: { field: string; value: string; note: string }[] = [
  { field: 'Fuel Used GPS (12)', value: 'Low priority', note: 'The burn accumulator, in ml' },
  { field: 'Fuel Rate GPS (13)', value: 'Low priority', note: 'Cross-check for the accumulator' },
  { field: 'External Voltage (66)', value: 'Low priority', note: 'Vehicle battery health' },
  { field: 'Battery Voltage (67)', value: 'Low priority', note: 'Tracker backup cell' },
  { field: 'Trip Odometer (199)', value: 'Low priority', note: 'Required by continuous counting' },
];

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3.5">
      <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-brand/40 bg-brand/10 text-xs font-bold text-brand">
        {n}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="mt-1 text-sm leading-relaxed text-ink-mid">{children}</p>
      </div>
    </li>
  );
}

function SpecTable({ rows }: { rows: { field: string; value: string; note: string }[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[30rem] text-left text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.field} className="border-b border-edge/60 last:border-0">
              <td className="py-2 pr-3 text-ink-mid">{r.field}</td>
              <td className="py-2 pr-3 font-mono font-semibold tabular-nums text-ink">
                {r.value}
              </td>
              <td className="py-2 text-xs text-ink-dim">{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The vehicle's own economy figure, typed in from its trip computer.
 *
 * Every "vs benchmark" number on the dashboard is currently judged against a
 * table keyed on model name — a RAV4 is assumed to do 7 km/L regardless of its
 * age, engine or condition. A reading off the vehicle's own dashboard is better
 * evidence than that guess, so this replaces it when one is entered.
 */
function EconomyCalibration({ fleet }: { fleet: FleetVehicle[] }) {
  const [vehicleId, setVehicleId] = useState<string>(fleet[0]?.id ?? '');
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState<EconomyUnit>('mpg_us');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<VehicleCalibrationStatus[]>([]);

  const selected = fleet.find((v) => v.id === vehicleId) ?? fleet[0] ?? null;

  // What each vehicle is burning at right now, so the manager can see which
  // ones are still on a class preset rather than a figure from their own dash.
  const loadStatus = useCallback(() => {
    fetchCalibrationStatus()
      .then((res) => setStatus(res.vehicles))
      .catch(() => setStatus([]));
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const currentFor = (id: string) => status.find((s) => s.vehicle_id === id) ?? null;
  const current = selected ? currentFor(selected.id) : null;

  const save = useCallback(async () => {
    if (!selected) return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Enter the figure your dashboard shows.');
      return;
    }
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const res = await setVehicleEconomy(selected.id, { value: parsed, unit });
      setResult(
        `Saved — ${selected.license_plate} is now benchmarked at ${res.km_per_liter?.toFixed(2)} km/L ` +
          `(${res.consumption_l_per_100km.toFixed(2)} L/100 km).`
      );
      loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that figure.');
    } finally {
      setSaving(false);
    }
  }, [selected, value, unit, loadStatus]);

  const clear = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const res = await setVehicleEconomy(selected.id, null);
      setValue('');
      setResult(
        `Cleared — ${selected.license_plate} is back on the class preset ` +
          `(${res.km_per_liter?.toFixed(2)} km/L).`
      );
      loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not clear that figure.');
    } finally {
      setSaving(false);
    }
  }, [selected, loadStatus]);

  if (!selected) {
    return (
      <Panel icon={Gauge} title="Fuel economy" subtitle="No vehicles yet.">
        <p className="text-sm text-ink-dim">Add a vehicle to set its economy benchmark.</p>
      </Panel>
    );
  }

  return (
    <Panel
      icon={Gauge}
      title="Fuel economy benchmark"
      subtitle="What this vehicle actually does, read off its own trip computer"
      chip={<StatusChip tone="accent">Optional</StatusChip>}
    >
      <p className="text-sm leading-relaxed text-ink-mid">
        Without this, FuelSense benchmarks the vehicle against a figure for its model — a guess
        that ignores age, engine and condition. If the dashboard shows a long-term average, put it
        in and it becomes the benchmark instead.
      </p>

      {/* Always rendered, even for a single vehicle: this is a per-vehicle
          setting, and hiding the selector made it look fleet-wide. */}
      <div className="mt-4 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-ink-dim">Vehicle</span>
          <select
            value={selected.id}
            onChange={(e) => {
              setVehicleId(e.target.value);
              setValue('');
              setResult(null);
              setError(null);
            }}
            className="rounded-lg border border-edge bg-panel px-2.5 py-2 text-sm text-ink"
          >
            {fleet.map((v) => {
              const s = currentFor(v.id);
              const kmL =
                s?.rate_l_per_100km && s.rate_l_per_100km > 0 ? 100 / s.rate_l_per_100km : null;
              return (
                <option key={v.id} value={v.id}>
                  {v.license_plate}
                  {kmL ? ` — ${kmL.toFixed(1)} km/L (${s?.rate_source})` : ''}
                </option>
              );
            })}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-ink-dim">Reading</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.1"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="15"
            className="w-28 rounded-lg border border-edge bg-panel px-2.5 py-2 text-sm text-ink"
          />
        </label>

        {/* The unit is a required choice, not a default we quietly apply: 15 mpg
            is 6.38 km/L on a US gauge and 5.31 on an imperial one, a 20% gap in
            the number the whole fuel model is anchored on. */}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-ink-dim">Unit</span>
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value as EconomyUnit)}
            className="rounded-lg border border-edge bg-panel px-2.5 py-2 text-sm text-ink"
          >
            {(Object.keys(ECONOMY_UNIT_LABELS) as EconomyUnit[]).map((u) => (
              <option key={u} value={u}>
                {ECONOMY_UNIT_LABELS[u]}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={save}
          disabled={saving || !value}
          className="rounded-lg bg-accent-y px-4 py-2 text-sm font-semibold text-accent-y-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={saving}
          className="rounded-lg border border-edge bg-panel px-3 py-2 text-sm text-ink-mid transition-colors hover:text-ink disabled:opacity-40"
          title="Revert to the model preset and let fill-to-fill calibration resume"
        >
          Clear
        </button>
      </div>

      <p className="mt-2 text-[11px] text-ink-dim">
        Not sure which mpg? A vehicle imported from the US shows US gallons; one from the UK shows
        imperial. If the dash offers km/L or L/100 km, prefer those — they are unambiguous.
      </p>

      {/* What this vehicle is burning at right now, and where that came from.
          The tank itself runs on this rate, so it is not only a benchmark. */}
      {current && (
        <div className="mt-4 rounded-xl bg-panel-deep px-3.5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">
            {selected.license_plate} is currently running on
          </p>
          <p className="mt-1 text-sm text-ink">
            {current.rate_l_per_100km && current.rate_l_per_100km > 0 ? (
              <>
                <span className="font-semibold tabular-nums">
                  {(100 / current.rate_l_per_100km).toFixed(2)} km/L
                </span>{' '}
                <span className="text-ink-dim">
                  ({current.rate_l_per_100km.toFixed(2)} L/100 km
                  {current.idle_burn_l_per_hour
                    ? `, ${current.idle_burn_l_per_hour.toFixed(1)} L/h idling`
                    : ''}
                  )
                </span>
              </>
            ) : (
              <span className="text-ink-dim">no rate recorded</span>
            )}
          </p>
          <p className="mt-1 text-[11px] text-ink-dim">
            {current.rate_source === 'manual'
              ? 'From your dashboard reading — the tank burns at this rate.'
              : current.rate_source === 'calibrated'
                ? `Measured from ${current.usable_measurements} fill-to-fill interval(s).`
                : `Class preset for ${current.vehicle_type_label} — enter your own figure to replace it.`}
          </p>
        </div>
      )}

      {result && <p className="mt-3 text-sm text-good">{result}</p>}
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
    </Panel>
  );
}

export function CalibrationGuidePanel({ fleet = [] }: { fleet?: FleetVehicle[] }) {
  const [tab, setTab] = useState<'tank' | 'economy' | 'device'>('tank');

  return (
    <div className="space-y-6">
      <Panel
        icon={Fuel}
        title="Calibration"
        subtitle="Two different things share this name. Do them in order — the device first, the tank second."
      >
        <div className="flex gap-2">
          {(
            [
              ['tank', 'Tank calibration'],
              ['economy', 'Fuel economy'],
              ['device', 'Teltonika Configurator'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                tab === id
                  ? 'bg-brand text-canvas'
                  : 'border border-edge text-ink-mid hover:bg-panel-hover'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-4 flex gap-2.5 rounded-xl border border-warn/40 bg-warn-deep/20 px-3.5 py-3">
          <TriangleAlert className="mt-px h-4 w-4 shrink-0 text-warn" />
          <p className="text-xs leading-relaxed text-warn">
            Order matters. Calibrating the tank <em>before</em> the Configurator profile is set
            anchors it to a burn rate the device is about to stop using, and the anchor has to be
            thrown away again.
          </p>
        </div>
      </Panel>

      {tab === 'economy' ? (
        <EconomyCalibration fleet={fleet} />
      ) : tab === 'tank' ? (
        <>
          <Panel
            icon={Fuel}
            title="Tank calibration"
            subtitle="Tells FuelSense how much fuel is in the tank right now"
            chip={<StatusChip tone="accent">Do second</StatusChip>}
          >
            <div>
              <div>
                <p className="text-sm leading-relaxed text-ink-mid">
                  This vehicle has no fuel-level sensor on CAN or OBD, so the level you see is a
                  model: an anchor set at a known quantity, drained by the burn the tracker counts,
                  and credited by receipts. Calibration is how you set that anchor. Everything
                  before the anchor is discarded, which is exactly why it fixes a drifted tank.
                </p>
                <ol className="mt-4 space-y-4">
                  <Step n={1} title="Fill the tank">
                    A known quantity is the only honest anchor. A full tank is best because you do
                    not have to trust a gauge reading — but a partial fill works if you enter the
                    litres.
                  </Step>
                  <Step n={2} title="Calibrate immediately">
                    Open Vehicle view and press <strong>Calibrate tank</strong>. Leave it blank for
                    a full tank, or enter the litres for a partial one. Confidence resets to 100%.
                  </Step>
                  <Step n={3} title="Let receipts accumulate">
                    After two fills, tank-to-tank gives real litres against device litres. That
                    ratio is what corrects the device&rsquo;s own estimate — one receipt cannot tell
                    a profile error from a partial fill.
                  </Step>
                </ol>
              </div>
            </div>
          </Panel>

          <Panel icon={CheckCircle2} title="When to recalibrate">
            <ul className="space-y-2.5 text-sm text-ink-mid">
              {[
                'Confidence has fallen below about 60% — it decays with consumption and days since the last anchor.',
                'You changed the Configurator fuel profile, which changes what the burn counter means.',
                'A refuel could not physically fit in the modelled headroom, which means the tank held less than the model believed.',
                'The tracker was unpowered long enough to miss a fill.',
              ].map((t) => (
                <li key={t} className="flex gap-2.5">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                  {t}
                </li>
              ))}
            </ul>
          </Panel>
        </>
      ) : (
        <>
          <Panel
            icon={Settings2}
            title="Teltonika Configurator"
            subtitle="Sets up the device's own fuel algorithm"
            chip={<StatusChip tone="warn">Do first</StatusChip>}
          >
            <div className="grid gap-5 md:grid-cols-[1fr_180px]">
              <p className="text-sm leading-relaxed text-ink-mid">
                The FMC150 computes fuel itself, from GPS speed and a consumption profile you give
                it. With that profile blank the accumulator barely moves — on this fleet it counted
                83 ml across a real 28 km trip, when it should have been roughly 2,700 ml. Until it
                is set, distance ÷ baseline is the only trustworthy figure.
                <br />
                <br />
                Connect over USB, <strong>Load</strong> the current config first so nothing is
                wiped, then open <strong>Trip \ Odometer</strong>.
              </p>
              <div className="h-44 rounded-xl border border-edge bg-panel-deep md:h-full">
                <Tracker3D online />
              </div>
            </div>

            <p className="mt-5 mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
              Trip \ Odometer → Fuel Consumption
            </p>
            <SpecTable rows={CONFIGURATOR_ROWS} />

            <p className="mt-5 mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
              I/O settings — enable at Low priority or higher
            </p>
            <SpecTable rows={IO_ROWS} />

            <p className="mt-4 text-xs leading-relaxed text-ink-dim">
              Values visible in the Configurator&rsquo;s I/O Info tab does <em>not</em> mean they are
              being transmitted. The only proof is server-side: idle for ten minutes and check the
              burn counter moved roughly 230 ml at 1.4 l/h.
            </p>
          </Panel>

          <Panel icon={Cpu} title="Verify it took">
            <ol className="space-y-4">
              <Step n={1} title="Save to device, then power-cycle">
                Save to file alone changes nothing on the tracker.
              </Step>
              <Step n={2} title="Idle ten minutes and check the counter">
                Roughly 230 ml at 1.4 l/h. Zero movement means the I/O priority did not stick; about
                10 ml means the Fuel Consumption group did not save.
              </Step>
              <Step n={3} title="Drive a known distance">
                A 28 km trip should accumulate roughly 2,800–3,500 ml.
              </Step>
            </ol>
          </Panel>
        </>
      )}

      <Panel title="How the numbers are worked out">
        <p className="text-sm text-ink-mid">
          For the methodology behind the estimates — baselines, idle burn and odometer
          cross-checks — see the full explainer.
        </p>
        <Link
          href="/calibration"
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:underline"
        >
          Read the methodology
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </Panel>
    </div>
  );
}
