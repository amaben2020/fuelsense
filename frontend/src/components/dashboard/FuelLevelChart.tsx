'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FuelHistoryPoint, getFuelHistory } from '@/lib/api';

const W = 720;
const H = 220;
const PAD = { top: 12, right: 12, bottom: 24, left: 40 };

interface ChartPoint {
  t: number;
  fuel: number | null;
  rate: number | null;
  speed: number | null;
  idle: boolean;
}

// Fuel level over time with amber blocks marking engine-idling periods
// (ignition on, speed ~0 — fuel burning while going nowhere).
export function FuelLevelChart({
  vehicleId,
  capacityLiters,
  refreshKey = 0,
}: {
  vehicleId: string;
  capacityLiters?: number | null;
  refreshKey?: number | string;
}) {
  const [rows, setRows] = useState<FuelHistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    let cancelled = false;
    getFuelHistory(vehicleId, 300)
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [vehicleId, refreshKey]);

  const points = useMemo<ChartPoint[]>(
    () =>
      [...rows]
        .reverse()
        .map((r) => ({
          t: new Date(r.recorded_at).getTime(),
          fuel: r.fuel_level_liters != null ? Number(r.fuel_level_liters) : null,
          rate: r.fuel_rate_lph != null ? Number(r.fuel_rate_lph) : null,
          speed: r.speed_kph,
          idle: !!r.ignition_on && (r.speed_kph ?? 0) < 2,
        }))
        .filter((p) => Number.isFinite(p.t)),
    [rows]
  );

  const { xFor, yFor, fuelPath, idleBlocks, yTicks, t0, t1 } = useMemo(() => {
    const withFuel = points.filter((p) => p.fuel != null);
    const t0 = points.length ? points[0].t : 0;
    const t1 = points.length ? points[points.length - 1].t : 1;
    const maxFuel = Math.max(
      capacityLiters ?? 0,
      ...withFuel.map((p) => p.fuel as number),
      1
    );

    const xFor = (t: number) =>
      PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.left - PAD.right);
    const yFor = (liters: number) =>
      H - PAD.bottom - (liters / maxFuel) * (H - PAD.top - PAD.bottom);

    let fuelPath = '';
    for (const p of withFuel) {
      fuelPath += `${fuelPath ? 'L' : 'M'}${xFor(p.t).toFixed(1)},${yFor(p.fuel as number).toFixed(1)}`;
    }

    // Merge consecutive idle points into shaded time blocks
    const idleBlocks: Array<{ x1: number; x2: number }> = [];
    let blockStart: number | null = null;
    for (let i = 0; i < points.length; i++) {
      if (points[i].idle && blockStart == null) blockStart = points[i].t;
      if ((!points[i].idle || i === points.length - 1) && blockStart != null) {
        const end = points[i].idle ? points[i].t : points[Math.max(0, i - 1)].t;
        idleBlocks.push({ x1: xFor(blockStart), x2: xFor(end) });
        blockStart = null;
      }
    }

    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
      y: yFor(f * maxFuel),
      label: Math.round(f * maxFuel),
    }));

    return { xFor, yFor, fuelPath, idleBlocks, yTicks, t0, t1 };
  }, [points, capacityLiters]);

  const handleMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!svgRef.current || points.length === 0) return;
      const rect = svgRef.current.getBoundingClientRect();
      const t =
        t0 +
        (((e.clientX - rect.left) / rect.width) * W - PAD.left) /
          Math.max(1e-9, (W - PAD.left - PAD.right) / Math.max(1, t1 - t0));
      let best = 0;
      let bestDist = Infinity;
      points.forEach((p, i) => {
        const d = Math.abs(p.t - t);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      setHoverIdx(best);
    },
    [points, t0, t1]
  );

  const hover = hoverIdx != null ? points[hoverIdx] : null;

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-ink-dim">
        Loading fuel telemetry…
      </div>
    );
  }

  if (points.filter((p) => p.fuel != null).length < 2) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-ink-dim">
        Not enough fuel telemetry yet — the curve appears once the tracker streams.
      </div>
    );
  }

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {idleBlocks.map((b, i) => (
          <rect
            key={i}
            x={b.x1}
            y={PAD.top}
            width={Math.max(2, b.x2 - b.x1)}
            height={H - PAD.top - PAD.bottom}
            fill="var(--warn)"
            opacity={0.14}
          />
        ))}

        {yTicks.map((tick) => (
          <g key={tick.label}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={tick.y}
              y2={tick.y}
              stroke="var(--edge)"
              strokeDasharray="3 5"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 6}
              y={tick.y + 3}
              textAnchor="end"
              fontSize="10"
              fill="var(--ink-dim)"
            >
              {tick.label}
            </text>
          </g>
        ))}

        <path d={fuelPath} fill="none" stroke="var(--brand)" strokeWidth="2" />

        {hover && hover.fuel != null && (
          <g>
            <line
              x1={xFor(hover.t)}
              x2={xFor(hover.t)}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke="var(--ink-dim)"
              strokeWidth="1"
            />
            <circle cx={xFor(hover.t)} cy={yFor(hover.fuel)} r="4" fill="var(--brand)" />
          </g>
        )}

        <text x={PAD.left} y={H - 8} fontSize="10" fill="var(--ink-dim)">
          {new Date(t0).toLocaleTimeString()}
        </text>
        <text x={W - PAD.right} y={H - 8} fontSize="10" fill="var(--ink-dim)" textAnchor="end">
          {new Date(t1).toLocaleTimeString()}
        </text>
      </svg>

      {hover && (
        <div className="pointer-events-none absolute right-2 top-2 rounded-lg border border-edge bg-canvas/95 px-3 py-2 text-xs">
          <p className="font-mono text-ink">
            {hover.fuel != null ? `${hover.fuel.toFixed(1)} L` : '—'}
            {hover.rate != null && (
              <span className="text-ink-dim"> · {hover.rate.toFixed(1)} L/h</span>
            )}
          </p>
          <p className="mt-0.5 text-ink-dim">
            {new Date(hover.t).toLocaleTimeString()} ·{' '}
            {hover.speed != null ? `${hover.speed} km/h` : 'speed —'}
            {hover.idle && <span className="text-warn"> · idling</span>}
          </p>
        </div>
      )}

      <div className="mt-2 flex items-center gap-4 text-[11px] text-ink-dim">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-brand" /> Fuel level (L)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded bg-warn/30" /> Engine idling
        </span>
      </div>
    </div>
  );
}
