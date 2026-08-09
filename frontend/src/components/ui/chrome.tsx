'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Home, RotateCw } from 'lucide-react';

/**
 * Haulix-language chrome primitives.
 *
 * Two navigation systems live here and they are not interchangeable:
 * `TabRow` is the underline tab strip used *inside* a detail record
 * (Overview / Cargo / Trips), while `SegmentedPills` is the rounded filter
 * group used to narrow a *list* (All / Active / Idle). Mixing them flattens
 * the hierarchy the design depends on.
 */

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'accent';

const TONE_CHIP: Record<Tone, string> = {
  neutral: 'bg-ink-dim/15 text-ink-mid',
  good: 'bg-good/15 text-good',
  warn: 'bg-warn/15 text-warn',
  bad: 'bg-bad/15 text-bad',
  info: 'bg-accent/20 text-accent-soft',
  accent: 'bg-accent-y/15 text-accent-y-dim',
};

/** Small pill label — "Active", "Critical", "Fragile". */
export function StatusChip({
  tone = 'neutral',
  dot = false,
  children,
  className = '',
}: {
  tone?: Tone;
  dot?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium leading-5 ${TONE_CHIP[tone]} ${className}`}
    >
      {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** Count badge that trails a tab or filter label. */
function CountChip({ value, active }: { value: number; active?: boolean }) {
  return (
    <span
      className={`ml-1.5 inline-flex min-w-[1.25rem] justify-center rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums ${
        active ? 'bg-ink/15 text-ink' : 'bg-ink-dim/15 text-ink-dim'
      }`}
    >
      {value}
    </span>
  );
}

export type StatPill = {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  title?: string;
};

/**
 * The metric strip that runs across the top of every Haulix screen.
 * Values stay bold and white; labels stay dim — the contrast split is what
 * makes the row scannable at a glance.
 */
export function StatPills({ items, className = '' }: { items: StatPill[]; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {/* Matches the identity chip on the right of the bar: a tinted glyph
          plate, a quiet label, and the value carrying the weight. The old flat
          row read as five disconnected fragments. */}
      {items.map(({ icon: Icon, label, value, title }) => (
        <div
          key={label}
          title={title}
          className="inline-flex items-center gap-2 rounded-full border border-edge bg-panel py-1.5 pl-1.5 pr-3.5 shadow-sm"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-y/12 text-accent-y">
            <Icon className="h-3.5 w-3.5" />
          </span>
          <span className="leading-tight">
            <span className="block text-[10px] font-medium uppercase tracking-wider text-ink-dim">
              {label}
            </span>
            <span className="block text-xs font-bold tabular-nums text-ink">{value}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

export type Crumb = { label: string; onClick?: () => void };

/** `⌂ Dashboard › Fleet Vehicles › TX-4821-HX` — last crumb is the current page. */
export function Breadcrumb({ items, className = '' }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={`flex items-center gap-1.5 text-xs ${className}`}>
      <Home className="h-3.5 w-3.5 shrink-0 text-ink-dim" />
      {items.map((item, i) => {
        const last = i === items.length - 1;
        return (
          <React.Fragment key={`${item.label}-${i}`}>
            {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-ink-dim/60" />}
            {last || !item.onClick ? (
              <span className={last ? 'font-medium text-ink' : 'text-ink-dim'}>{item.label}</span>
            ) : (
              <button
                type="button"
                onClick={item.onClick}
                className="text-ink-dim transition-colors hover:text-ink"
              >
                {item.label}
              </button>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

/**
 * Page title block. `subtitle` is the dim line under the title
 * ("Monday, April 8, 2026 · Real-time overview"); `actions` is the
 * right-aligned control cluster.
 */
export function PageHeader({
  title,
  subtitle,
  breadcrumb,
  status,
  actions,
  className = '',
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  breadcrumb?: Crumb[];
  status?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      {breadcrumb && breadcrumb.length > 0 && <Breadcrumb items={breadcrumb} className="mb-3" />}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-[2.5rem] sm:leading-[1.1]">
              {title}
            </h1>
            {status}
          </div>
          {subtitle && <p className="mt-1.5 text-sm text-ink-dim">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export type TabItem<T extends string> = { id: T; label: string; count?: number };

/** Underline tabs for switching sections within one record. */
export function TabRow<T extends string>({
  items,
  active,
  onChange,
  className = '',
}: {
  items: TabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-1 overflow-x-auto border-b border-divider ${className}`}>
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            aria-current={isActive ? 'page' : undefined}
            className={`-mb-px shrink-0 border-b-2 px-3.5 pb-2.5 pt-2 text-sm transition-colors ${
              isActive
                ? 'border-ink font-semibold text-ink'
                : 'border-transparent text-ink-dim hover:text-ink-mid'
            }`}
          >
            {item.label}
            {item.count != null && <CountChip value={item.count} active={isActive} />}
          </button>
        );
      })}
    </div>
  );
}

/** Rounded segmented filter group for narrowing a list. */
export function SegmentedPills<T extends string>({
  items,
  active,
  onChange,
  className = '',
}: {
  items: TabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={`inline-flex items-center gap-1 rounded-full border border-edge bg-panel p-1 ${className}`}
    >
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(item.id)}
            className={`inline-flex shrink-0 items-center rounded-full px-3.5 py-1.5 text-sm transition-colors ${
              isActive
                ? 'bg-panel-hover font-semibold text-ink shadow-sm'
                : 'text-ink-dim hover:text-ink-mid'
            }`}
          >
            {item.label}
            {item.count != null && <CountChip value={item.count} active={isActive} />}
          </button>
        );
      })}
    </div>
  );
}

/** Circular icon button — the rail, map controls, and panel refresh all use it. */
export function RoundButton({
  icon: Icon,
  label,
  onClick,
  active = false,
  size = 'md',
  className = '',
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick?: () => void;
  active?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const box = size === 'sm' ? 'h-8 w-8' : 'h-10 w-10';
  const glyph = size === 'sm' ? 'h-3.5 w-3.5' : 'h-[1.05rem] w-[1.05rem]';
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`inline-flex ${box} shrink-0 items-center justify-center rounded-full border transition-colors ${
        active
          ? 'border-transparent bg-ink text-canvas'
          : 'border-edge bg-panel text-ink-dim hover:bg-panel-hover hover:text-ink'
      } ${className}`}
    >
      <Icon className={glyph} />
    </button>
  );
}

/**
 * Deterministic avatar. Drivers have no photo column, so rather than block on
 * uploads this derives a stable hue from the name and renders initials over a
 * generated gradient — same person, same colour, every session, no network.
 * Swap the inner content for an <img> the moment real photos land.
 */
export function Avatar({
  name,
  size = 44,
  className = '',
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();

  // Cheap string hash -> hue. Stable across reloads and machines.
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 360;

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-2xl font-bold text-white ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.34,
        background: `linear-gradient(145deg, hsl(${hash} 62% 52%), hsl(${(hash + 42) % 360} 58% 34%))`,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.28), 0 6px 14px -6px rgba(0,0,0,0.6)',
      }}
      aria-hidden
    >
      {/* Top-light sheen — what sells the raised, moulded look. */}
      <span
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 80% at 30% 0%, rgba(255,255,255,0.34), transparent 60%)',
        }}
      />
      <span className="relative">{initials}</span>
    </span>
  );
}

/**
 * Raised icon tile. A flat glyph on a flat card reads as a wireframe, so this
 * gives the icon a moulded plate: tinted gradient, inner top-light, and a cast
 * shadow. Pure CSS — no image assets and nothing to load.
 */
export function IconTile({
  icon: Icon,
  tone = 'neutral',
  size = 44,
  float = false,
  className = '',
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'accent';
  size?: number;
  /** Slow hover-independent bob. Respects prefers-reduced-motion. */
  float?: boolean;
  className?: string;
}) {
  const toneVar = {
    neutral: 'var(--ink-dim)',
    good: 'var(--good)',
    warn: 'var(--warn)',
    bad: 'var(--bad)',
    accent: 'var(--accent-y)',
  }[tone];

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center rounded-2xl ${
        float ? 'icon-float' : ''
      } ${className}`}
      style={{
        width: size,
        height: size,
        color: toneVar,
        background: `linear-gradient(150deg, color-mix(in srgb, ${toneVar} 26%, var(--panel)), color-mix(in srgb, ${toneVar} 8%, var(--panel-deep)))`,
        boxShadow: `inset 0 1px 0 color-mix(in srgb, ${toneVar} 45%, transparent), inset 0 -1px 2px rgba(0,0,0,0.35), 0 8px 16px -10px color-mix(in srgb, ${toneVar} 70%, transparent)`,
      }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-2xl"
        style={{
          background:
            'radial-gradient(110% 70% at 32% 0%, rgba(255,255,255,0.20), transparent 62%)',
        }}
      />
      <Icon className="relative h-[46%] w-[46%]" />
    </span>
  );
}

export type RailItem<T extends string> = {
  id: T;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  badge?: number;
};

/**
 * How long the pointer must rest inside the rail before it expands.
 *
 * This delay is what lets the tooltip and the expansion coexist. Without it,
 * hovering any icon would immediately widen the rail and the tooltip would
 * never be readable — so a quick pass gets the tooltip, and only a deliberate
 * dwell commits to the full labelled rail.
 */
const RAIL_EXPAND_DELAY_MS = 350;

/**
 * Vertical icon rail that expands to labels on hover.
 *
 * Haulix carries about six destinations unlabelled; this dashboard carries
 * eleven, which is past the point where a glyph alone is recallable. Two
 * affordances cover that: a tooltip while collapsed, and hover-to-expand for
 * reading the whole set at once.
 *
 * The expansion overlays the page rather than displacing it — the caller keeps
 * a fixed `76px` gutter, so nothing reflows when the rail opens.
 */
export function IconRail<T extends string>({
  brand,
  brandLabel,
  items,
  active,
  onSelect,
  footer,
  className = '',
}: {
  brand?: React.ReactNode;
  brandLabel?: React.ReactNode;
  items: RailItem<T>[];
  active: T;
  onSelect: (id: T) => void;
  footer?: React.ReactNode;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  /**
   * The tooltip is rendered once at the rail root and positioned from the
   * hovered button's rect, rather than as an absolute child of each item.
   * The nav has to scroll (eleven destinations overflow a short viewport), and
   * a scroll container cannot be escaped by an absolutely positioned child —
   * setting `overflow-y: auto` forces the x-axis out of `visible` too, so a
   * tooltip anchored inside it gets clipped at the rail's edge.
   */
  const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null);
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Which edges of the nav have more content past them. Used to fade only the
   * edge that is actually cut — an unconditional mask dims the first and last
   * icon even when the list fits, which reads as a rendering fault.
   */
  const navRef = useRef<HTMLElement | null>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });

  const measureEdges = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    const overflowing = el.scrollHeight > el.clientHeight + 1;
    setEdges({
      top: overflowing && el.scrollTop > 1,
      bottom: overflowing && el.scrollTop + el.clientHeight < el.scrollHeight - 1,
    });
  }, []);

  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    measureEdges();
    const ro = new ResizeObserver(measureEdges);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureEdges, items.length, expanded]);

  const clearDwell = useCallback(() => {
    if (dwell.current) {
      clearTimeout(dwell.current);
      dwell.current = null;
    }
  }, []);

  const scheduleExpand = useCallback(() => {
    clearDwell();
    dwell.current = setTimeout(() => setExpanded(true), RAIL_EXPAND_DELAY_MS);
  }, [clearDwell]);

  const collapse = useCallback(() => {
    clearDwell();
    setExpanded(false);
    setTip(null);
  }, [clearDwell]);

  // Keyboard users never hover, so focus opens the rail immediately — a
  // tab-through must not land on an unlabelled glyph.
  const expandNow = useCallback(() => {
    clearDwell();
    setExpanded(true);
    setTip(null);
  }, [clearDwell]);

  useEffect(() => clearDwell, [clearDwell]);

  return (
    <div
      onMouseEnter={scheduleExpand}
      onMouseLeave={collapse}
      onFocusCapture={expandNow}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) collapse();
      }}
      data-expanded={expanded ? 'true' : 'false'}
      className={`flex h-full flex-col gap-1 px-4 py-5 transition-[width] duration-200 ease-out motion-reduce:transition-none ${
        expanded ? 'w-[244px] shadow-2xl' : 'w-[76px]'
      } ${className}`}
    >
      {brand && (
        <div className="mb-3 flex h-11 shrink-0 items-center">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center">{brand}</span>
          {brandLabel && (
            <span
              className={`ml-1 truncate text-sm font-bold text-ink transition-opacity duration-150 ${
                expanded ? 'opacity-100' : 'w-0 opacity-0'
              }`}
            >
              {brandLabel}
            </span>
          )}
        </div>
      )}
      <div className="mb-3 h-px w-full shrink-0 bg-divider" />

      {/* Eleven destinations can overflow a short laptop viewport, so the list
          scrolls — but the fade is applied per-edge and only when that edge
          actually has content past it, so a list that fits is never dimmed. */}
      <nav
        ref={navRef}
        onScroll={measureEdges}
        /* `-mx-2 px-2` widens the scroll box by 8px each side without moving
           the buttons. Badges overhang their button by 2px, and a scroll
           container clips anything outside its content box — which is what was
           slicing the count badges down the middle. */
        className="-mx-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={
          edges.top || edges.bottom
            ? {
                maskImage: `linear-gradient(to bottom, ${
                  edges.top ? 'transparent 0, #000 20px' : '#000 0'
                }, ${edges.bottom ? '#000 calc(100% - 20px), transparent 100%' : '#000 100%'})`,
                WebkitMaskImage: `linear-gradient(to bottom, ${
                  edges.top ? 'transparent 0, #000 20px' : '#000 0'
                }, ${edges.bottom ? '#000 calc(100% - 20px), transparent 100%' : '#000 100%'})`,
              }
            : undefined
        }
      >
        {items.map((item) => {
          const isActive = item.id === active;
          const Icon = item.icon;
          const badge =
            item.badge != null && item.badge > 0
              ? item.badge > 99
                ? '99+'
                : String(item.badge)
              : null;

          return (
            <div key={item.id} className="relative shrink-0">
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                onMouseEnter={(e) => {
                  if (expanded) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  setTip({ label: item.label, top: r.top + r.height / 2, left: r.right + 12 });
                }}
                onMouseLeave={() => setTip(null)}
                aria-label={item.label}
                aria-current={isActive ? 'page' : undefined}
                className={`relative flex h-11 w-full items-center rounded-xl outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent-y focus-visible:ring-offset-2 focus-visible:ring-offset-panel ${
                  isActive
                    ? 'bg-accent-y text-accent-y-ink'
                    : 'bg-panel-deep text-ink-dim hover:bg-panel-hover hover:text-ink'
                }`}
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center">
                  <Icon className="h-[1.15rem] w-[1.15rem]" />
                </span>
                <span
                  className={`truncate text-left text-sm font-medium transition-opacity duration-150 ${
                    expanded ? 'flex-1 opacity-100' : 'w-0 opacity-0'
                  }`}
                >
                  {item.label}
                </span>
                {badge &&
                  (expanded ? (
                    <span className="mr-3 inline-flex min-w-[1.1rem] shrink-0 justify-center rounded-full bg-bad-bright px-1 text-[10px] font-bold leading-[1.1rem] text-white">
                      {badge}
                    </span>
                  ) : (
                    <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-[1.1rem] justify-center rounded-full bg-bad-bright px-1 text-[10px] font-bold leading-[1.1rem] text-white">
                      {badge}
                    </span>
                  ))}
              </button>

            </div>
          );
        })}
      </nav>

      {/* Suppressed once expanded: the label is already on screen, so a tooltip
          repeating it would only cover the neighbouring item. */}
      {!expanded && tip && (
        <span
          role="tooltip"
          style={{ top: tip.top, left: tip.left }}
          className="pointer-events-none fixed z-50 -translate-y-1/2 whitespace-nowrap rounded-lg bg-ink px-2.5 py-1.5 text-xs font-semibold text-canvas shadow-xl"
        >
          {tip.label}
        </span>
      )}

      {footer && (
        <div
          className={`mt-3 flex shrink-0 gap-1.5 border-t border-divider pt-3 ${
            expanded ? 'flex-row items-center pl-1' : 'flex-col items-center'
          }`}
        >
          {footer}
        </div>
      )}
    </div>
  );
}

/**
 * Card shell. Header is `icon + title + chip` with an optional dim subtitle
 * and a trailing refresh affordance, matching the Haulix panels.
 */
export function Panel({
  icon: Icon,
  title,
  subtitle,
  chip,
  actions,
  onRefresh,
  refreshing = false,
  children,
  bodyClassName = '',
  className = '',
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  chip?: React.ReactNode;
  actions?: React.ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  children: React.ReactNode;
  bodyClassName?: string;
  className?: string;
}) {
  const hasHeader = Boolean(Icon || title || subtitle || chip || actions || onRefresh);
  return (
    <section
      className={`rounded-2xl border border-edge bg-panel ${className}`}
    >
      {hasHeader && (
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 pb-3 pt-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              {Icon && <Icon className="h-[1.05rem] w-[1.05rem] shrink-0 text-ink-mid" />}
              {title && <h2 className="text-base font-bold tracking-tight text-ink">{title}</h2>}
              {chip}
            </div>
            {subtitle && <p className="mt-1 text-xs text-ink-dim">{subtitle}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                title="Refresh"
                aria-label="Refresh"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-edge bg-panel-deep text-ink-dim transition-colors hover:text-ink"
              >
                <RotateCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              </button>
            )}
          </div>
        </div>
      )}
      <div className={hasHeader ? `px-5 pb-5 ${bodyClassName}` : `p-5 ${bodyClassName}`}>
        {children}
      </div>
    </section>
  );
}

/**
 * Diagonally hatched capacity bar. `tone` drives `currentColor`, which the
 * `.hatch-fill` stripe inherits — amber for normal load, red once full.
 */
export function HatchBar({
  value,
  max = 100,
  tone,
  showPercent = true,
  className = '',
}: {
  value: number;
  max?: number;
  tone?: 'amber' | 'bad' | 'good';
  showPercent?: boolean;
  className?: string;
}) {
  const safeMax = max > 0 ? max : 100;
  const pct = Math.max(0, Math.min(100, (value / safeMax) * 100));
  const resolved = tone ?? (pct >= 100 ? 'bad' : 'amber');
  const color =
    resolved === 'bad'
      ? 'text-bad-bright'
      : resolved === 'good'
        ? 'text-good'
        : 'text-fuel-amber';

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {showPercent && (
        <span className="shrink-0 rounded-full bg-panel-deep px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-ink-mid">
          {Math.round(pct)}%
        </span>
      )}
      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-panel-deep">
        <div
          className={`hatch-fill h-full rounded-full transition-[width] duration-700 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
