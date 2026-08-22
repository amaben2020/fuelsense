'use client';

import { formatNgn, type FuelPriceTrend as Trend } from '@/lib/api';

/**
 * The declared fuel price as a zigzag, with the direction called out.
 *
 * Fuel price sets the value of every litre the fleet burns, so a manager
 * reading a cost total needs to know whether the rate behind it is climbing.
 * A list of effective dates does not answer that at a glance; a line does.
 *
 * Plotted against its own min and max rather than from zero. Nigerian pump
 * prices move a few percent at a time, and a zero-based axis would flatten
 * every one of those changes into the same horizontal line — which is exactly
 * the information this exists to show.
 */
export function FuelPriceTrend({
  trend,
  className = '',
}: {
  trend: Trend | undefined;
  className?: string;
}) {
  // One declared price is a fact, not a trend. Two is the minimum that can
  // point anywhere.
  if (!trend || trend.series.length < 2) return null;

  const values = trend.series.map((p) => p.ngn_per_liter);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const W = 96;
  const H = 28;
  const PAD = 3;

  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (W - PAD * 2) + PAD;
    // SVG y grows downward, so the highest price must map to the smallest y.
    const y = H - PAD - ((v - min) / span) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const rising = trend.direction === 'up';
  const falling = trend.direction === 'down';

  // Rising fuel costs money, so it is the warning colour; a fall is genuinely
  // good news for a fleet and reads as such.
  const stroke = rising ? 'var(--warn)' : falling ? 'var(--good)' : 'var(--ink-dim)';
  const textTone = rising ? 'text-warn' : falling ? 'text-good' : 'text-ink-dim';

  const last = values[values.length - 1];
  const first = values[0];

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="shrink-0 overflow-visible"
        role="img"
        aria-label={`Fuel price ${trend.direction === 'flat' ? 'unchanged at' : trend.direction === 'up' ? 'up to' : 'down to'} ${formatNgn(last)} per litre, from ${formatNgn(first)} across ${trend.changes} declared prices`}
      >
        <polyline
          points={points.join(' ')}
          fill="none"
          stroke={stroke}
          strokeWidth={1.75}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Only the newest point is marked. Dotting every vertex turns a
            three-point line into visual noise without adding meaning. */}
        <circle
          cx={points[points.length - 1].split(',')[0]}
          cy={points[points.length - 1].split(',')[1]}
          r={2.6}
          fill={stroke}
        />
      </svg>

      <span className={`flex items-baseline gap-1 text-[11px] font-medium ${textTone}`}>
        <span aria-hidden="true">{rising ? '▲' : falling ? '▼' : '—'}</span>
        <span className="tabular-nums">
          {trend.change_ngn === 0
            ? 'No change'
            : `${trend.change_ngn > 0 ? '+' : '−'}${formatNgn(Math.abs(trend.change_ngn))}`}
        </span>
        {trend.change_pct !== 0 && (
          <span className="tabular-nums text-ink-dim">
            ({trend.change_pct > 0 ? '+' : ''}
            {trend.change_pct}%)
          </span>
        )}
      </span>
    </div>
  );
}
