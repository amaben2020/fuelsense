'use client';

import {
  AlertTriangle,
  Battery,
  Droplet,
  Fuel,
  Locate,
  Receipt,
  Shield,
  TrendingDown,
  X,
} from 'lucide-react';

export function FuelAnomalyModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="relative mx-4 max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-edge bg-panel shadow-2xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-edge bg-panel px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-bad/10 p-2">
              <AlertTriangle className="h-5 w-5 text-bad" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-ink">Fuel anomalies explained</h2>
              <p className="text-sm text-ink-mid">What we detect and how we protect your fleet</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 transition-colors hover:bg-divider"
          >
            <X className="h-5 w-5 text-ink-mid" />
          </button>
        </div>

        <div className="space-y-6 p-6">
          <div className="rounded-lg border border-edge bg-canvas p-4">
            <p className="leading-relaxed text-ink">
              FuelSense detects{' '}
              <span className="font-semibold text-bad">fuel anomalies</span> in real-time by
              comparing OBD fuel level and GPS data against expected consumption. When something
              does not add up, you get an instant alert via TCP telemetry.
            </p>
          </div>

          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-mid">
              What we detect
            </h3>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <AnomalyCard
                icon={Droplet}
                color="#ffb4ab"
                title="Possible fuel anomaly (siphoning)"
                body="Fuel drops while parked (ignition OFF). Flagged for investigation — not a final verdict."
                rule="Engine OFF + fuel ↓ &gt; 5 L = REVIEW"
              />
              <AnomalyCard
                icon={Receipt}
                color="#ffb95f"
                title="Receipt overcharging"
                body="Receipt claims more liters than OBD recorded entering the tank."
                rule="Receipt L − OBD L &gt; 5 L = REVIEW"
              />
              <AnomalyCard
                icon={Battery}
                color="#ffb95f"
                title="Excessive idling"
                body="Engine running while stationary for extended periods — fuel wasted without revenue."
                rule="Engine ON + speed 0 &gt; 15 min = WASTE"
              />
              <AnomalyCard
                icon={TrendingDown}
                color="#ffb95f"
                title="Poor fuel economy"
                body="Distance per liter falls below vehicle baseline from historical OBD data."
                rule="km/L &lt; baseline × 0.8 = UNDERPERFORMING"
              />
              <AnomalyCard
                icon={Locate}
                color="#b8c3ff"
                title="Unauthorized route"
                body="Vehicle outside approved geofence zones for too long."
                rule="GPS outside zone &gt; 15 min = VIOLATION"
              />
            </div>
          </div>

          <div className="rounded-lg border border-edge bg-canvas p-4">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-mid">
              How it works
            </h3>
            <ol className="space-y-3 text-sm">
              <Step n={1} title="OBD data stream" text="FMC150 sends fuel, odometer, RPM, and ignition every few seconds over TCP." />
              <Step n={2} title="Pattern analysis" text="Algorithms compare each reading against vehicle baselines and physics." />
              <Step n={3} title="Anomaly detection" text="Threshold violations create alerts stored in PostgreSQL instantly." />
              <Step n={4} title="Dashboard alert" text="Fleet managers see anomalies here with liters lost and NGN impact." />
            </ol>
          </div>

          <div className="rounded-lg border border-accent/30 bg-accent/10 p-4">
            <div className="flex items-start gap-3">
              <Shield className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
              <p className="text-xs text-ink-mid">
                Demo mode runs <code className="text-brand">simulate-fleet</code> automatically
                with the backend. Real FMC150 devices use the same TCP pipeline — no dashboard
                changes required.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AnomalyCard({
  icon: Icon,
  color,
  title,
  body,
  rule,
}: {
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  title: string;
  body: string;
  rule: string;
}) {
  return (
    <div
      className="rounded-lg bg-canvas p-4"
      style={{ borderLeft: `2px solid ${color}` }}
    >
      <div className="mb-2 flex items-center gap-2">
        <span style={{ color }}>
          <Icon className="h-4 w-4" />
        </span>
        <h4 className="font-semibold text-ink">{title}</h4>
      </div>
      <p className="text-sm leading-relaxed text-ink-mid">{body}</p>
      <div
        className="mt-2 rounded p-2 font-mono text-xs"
        style={{ color, backgroundColor: `${color}18` }}
      >
        {rule}
      </div>
    </div>
  );
}

function Step({ n, title, text }: { n: number; title: string; text: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/20 text-xs font-bold text-brand">
        {n}
      </span>
      <div>
        <p className="font-medium text-ink">{title}</p>
        <p className="text-xs text-ink-mid">{text}</p>
      </div>
    </li>
  );
}
