'use client';

import { useEffect, useMemo, useState } from 'react';
import { Gauge } from 'lucide-react';
import { HealthTrendResponse, api } from '@/lib/api';
import { IconTile } from '@/components/ui/chrome';

type Tone = 'default' | 'good' | 'warn' | 'bad';

/**
 * The Fleet health tile used to be a bare number with a one-line hint —
 * accurate, but it answered "what is the score" and nothing else: not
 * whether that's good, not what it's made of, not whether it's trending the
 * right way.
 *
 * The trend line is real, not decorative: `/dashboard/health-trend` replays
 * the alerts table's `created_at`/`resolved_at` to say what was actually
 * open at the end of each of the last 7 days. It deliberately does NOT
 * replay the efficiency component day-by-day — that figure comes from a
 * trailing-window aggregate with no per-day value to plot honestly, so it's
 * held at today's figure across the whole trend and the footnote says so,
 * rather than the line implying a daily efficiency history that was never
 * measured.
 */
export function FleetHealthCard({
  score,
  tone,
  concerningAlerts,
  theftAlerts,
  underperforming,
  connScore,
  offlineCount,
  className = '',
}: {
  score: number | null;
  tone: Tone;
  concerningAlerts: number;
  theftAlerts: number;
  underperforming: number;
  connScore: number | null;
  offlineCount: number;
  className?: string;
}) {
  const [trend, setTrend] = useState<HealthTrendResponse['days'] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const result = await api<HealthTrendResponse>('/dashboard/health-trend');
        if (!live) return;
        setTrend(result.days ?? []);
        setFailed(false);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Same weights as fleetHealthScore, applied to that day's real alert load
  // with today's underperforming count held constant.
  const trendScores = useMemo(() => {
    if (!trend?.length) return null;
    return trend.map((d) =>
      Math.max(
        0,
        Math.min(100, Math.round(100 - d.concerning_alerts * 2 - d.theft_alerts * 10 - underperforming * 7))
      )
    );
  }, [trend, underperforming]);

  const toneVar = {
    default: 'var(--ink-dim)',
    good: 'var(--good)',
    warn: 'var(--warn)',
    bad: 'var(--bad)',
  }[tone];

  const meaning =
    score == null
      ? 'No data yet.'
      : score >= 90
        ? 'No notable driving or fuel issues.'
        : score >= 75
          ? 'Good, with minor items worth a look.'
          : score >= 50
            ? 'Some driving or fuel issues need attention.'
            : 'Multiple issues need attention now.';

  return (
    <div className={`flex flex-col rounded-xl border border-edge bg-panel p-5 ${className}`}>
      <div className="flex items-center gap-3">
        <IconTile icon={Gauge} tone={tone === 'default' ? 'neutral' : tone} />
        <p className="text-xs font-medium uppercase tracking-[0.1em] text-ink-dim">Fleet health</p>
      </div>

      <div className="mt-3 flex items-center gap-4">
        <HealthGauge score={score} toneVar={toneVar} />
        <div className="min-w-0">
          <p className="text-4xl font-bold leading-none tracking-tight tabular-nums text-ink">
            {score != null ? score : '—'}
            <span className="text-lg font-semibold text-ink-mid">/100</span>
          </p>
          <p className="mt-1.5 text-sm leading-snug text-ink-mid">{meaning}</p>
        </div>
      </div>

      <dl className="mt-4 space-y-1.5 border-t border-edge pt-3 text-xs">
        <BreakdownRow label="Concerning alerts" value={concerningAlerts} points={-2} />
        <BreakdownRow label="Theft flags" value={theftAlerts} points={-10} />
        <BreakdownRow label="Underperforming vehicles" value={underperforming} points={-7} />
        <div className="flex items-baseline justify-between gap-3 pt-1 text-ink-dim">
          <dt>Connectivity (not scored)</dt>
          <dd className="font-mono tabular-nums text-ink-mid">
            {connScore != null ? `${connScore}%` : '—'}
            {offlineCount > 0 ? ` · ${offlineCount} offline` : ''}
          </dd>
        </div>
      </dl>

      <div className="mt-4 border-t border-edge pt-3">
        <div className="flex items-center justify-between">
          <p className="text-[11px] uppercase tracking-[0.08em] text-ink-dim">7-day trend</p>
          {trendScores && trendScores.length >= 2 && (
            <p className="text-[11px] tabular-nums text-ink-dim">
              {trendScores[0]} → {trendScores[trendScores.length - 1]}
            </p>
          )}
        </div>
        <div className="mt-1.5 h-8">
          {failed ? (
            <p className="text-[11px] text-ink-dim">Could not load trend</p>
          ) : trendScores && trendScores.length >= 2 ? (
            <Sparkline values={trendScores} toneVar={toneVar} />
          ) : (
            <p className="text-[11px] text-ink-dim">{trend ? 'Not enough history yet' : 'Loading…'}</p>
          )}
        </div>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-ink-dim">
        0 = severe driving/fuel issues, 100 = none detected. Connectivity is tracked separately and
        never lowers this score. The trend replays each day&apos;s actual alert load; the efficiency
        component isn&apos;t measured per day, so it&apos;s held at today&apos;s value throughout.
      </p>
    </div>
  );
}

function BreakdownRow({ label, value, points }: { label: string; value: number; points: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-dim">{label}</dt>
      <dd className={`font-mono tabular-nums ${value > 0 ? 'text-ink' : 'text-ink-dim'}`}>
        {value} {value === 1 ? 'item' : 'items'}
        {value > 0 && <span className="ml-1.5 text-ink-dim">({points * value} pts)</span>}
      </dd>
    </div>
  );
}

function HealthGauge({ score, toneVar }: { score: number | null; toneVar: string }) {
  const size = 88;
  const cx = size / 2;
  const cy = size / 2 + 6;
  const r = size / 2 - 10;
  const arcLen = Math.PI * r;
  const pct = score != null ? Math.max(0, Math.min(100, score)) / 100 : 0;

  return (
    <svg
      width={size}
      height={size / 2 + 14}
      viewBox={`0 0 ${size} ${size / 2 + 14}`}
      className="shrink-0"
      role="img"
      aria-label={score != null ? `Fleet health score ${score} out of 100` : 'Fleet health score unavailable'}
    >
      <path
        d={`M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy}`}
        fill="none"
        stroke="var(--edge)"
        strokeWidth={8}
        strokeLinecap="round"
      />
      <path
        d={`M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy}`}
        fill="none"
        stroke={toneVar}
        strokeWidth={8}
        strokeLinecap="round"
        strokeDasharray={`${arcLen} ${arcLen}`}
        strokeDashoffset={arcLen * (1 - pct)}
      />
    </svg>
  );
}

/**
 * Plotted on a fixed 0-100 domain, not auto-scaled to the window's own
 * min/max. Auto-scaling makes every trend fill the full height, so a score
 * that drifted 99 → 98 would draw the same cliff as one that fell 90 → 20,
 * and a score that never moved would flatten onto the floor as if it were
 * zero. The score already has a meaningful fixed range, so the slope here
 * means the same thing every time it is read.
 */
function Sparkline({ values, toneVar }: { values: number[]; toneVar: string }) {
  const width = 220;
  const height = 32;
  // Keeps the 2px stroke from being clipped at a full 100 or a bottomed-out 0.
  const pad = 2;
  const plot = height - pad * 2;

  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = pad + (1 - Math.max(0, Math.min(100, v)) / 100) * plot;
    return `${x},${y}`;
  });

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={toneVar}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
