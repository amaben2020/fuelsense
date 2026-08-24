'use client';

/**
 * The vehicle-and-driver card that rides above a marker on the live map.
 *
 * A pill reading "LAG-001-FS —" identified the vehicle and nothing else. A
 * manager watching the map is usually asking who is in it, and the answer was
 * absent. This is the licence-card shape that question expects: the face on
 * the left, the plate and name set like a card, and the running numbers
 * underneath.
 *
 * The frost is layered rather than a single blur — a tinted pane, a soft
 * highlight running off the top-left corner, and a hairline that catches light
 * on two edges only. One flat `backdrop-blur` over a panel colour reads as a
 * grey box; the offset highlight is what makes it read as glass sitting above
 * the map.
 */

/** Initials, for a driver with no photo on file. */
function initialsOf(name: string | null | undefined): string {
  if (!name?.trim()) return '—';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : ''))
    .toUpperCase();
}

export function DriverAvatar({
  name,
  photoUrl,
  size = 44,
}: {
  name: string | null | undefined;
  photoUrl?: string | null;
  size?: number;
}) {
  const label = name?.trim() || 'Unassigned driver';
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl"
      style={{
        width: size,
        height: size,
        // The photo sits on the same tinted plate the initials use, so a card
        // with a photo and one without have the same silhouette.
        background:
          'linear-gradient(150deg, color-mix(in srgb, var(--accent-y) 26%, var(--panel)), color-mix(in srgb, var(--accent-y) 8%, var(--panel-deep)))',
        boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--accent-y) 40%, transparent)',
      }}
      title={label}
    >
      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a data URL from
        // our own upload path; next/image cannot optimise it and would only add
        // a loader in front of bytes we already hold.
        <img src={photoUrl} alt={label} className="h-full w-full object-cover" />
      ) : (
        <span
          className="font-semibold text-accent-y"
          style={{ fontSize: Math.round(size * 0.36) }}
          aria-hidden
        >
          {initialsOf(name)}
        </span>
      )}
    </span>
  );
}

export function DriverLicenceCard({
  plate,
  driverName,
  photoUrl,
  status,
  stats,
  footer,
  accentColor,
}: {
  plate: string;
  driverName: string | null | undefined;
  photoUrl?: string | null;
  status: 'online' | 'offline' | string;
  /** Optional. On the map these are omitted — the right-hand panel already
   *  carries speed, fuel and odometer, and repeating them puts the same
   *  numbers on screen twice. */
  stats?: { label: string; value: string }[];
  footer?: React.ReactNode;
  /** The vehicle's route colour, so the card and its marker read as one thing. */
  accentColor?: string;
}) {
  const accent = accentColor ?? 'var(--accent-y)';
  return (
    <div
      className={`glass relative overflow-hidden rounded-2xl p-3.5 ${
        stats?.length ? 'w-72' : 'w-auto min-w-[15rem]'
      }`}
      style={{
        // The sweep takes the vehicle's own colour here, so the card and its
        // marker read as one thing. Elsewhere .glass supplies the accent.
        ['--accent-y' as string]: accent,
      }}
    >
      <div className="relative flex items-start gap-3">
        <DriverAvatar name={driverName} photoUrl={photoUrl} size={46} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-2 font-mono text-sm font-bold tracking-tight text-ink">
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: accent }}
              />
              <span className="truncate">{plate}</span>
            </p>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${
                status === 'online' ? 'bg-good/15 text-good' : 'bg-bad/15 text-bad'
              }`}
            >
              {status}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-ink-dim">
            {driverName?.trim() || 'Unassigned driver'}
          </p>
        </div>
      </div>

      {stats && stats.length > 0 && (
      <div className="relative mt-3 grid grid-cols-2 gap-2">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-lg px-2.5 py-1.5"
            style={{
              background: 'color-mix(in srgb, var(--canvas) 55%, transparent)',
              border: '1px solid color-mix(in srgb, var(--ink) 6%, transparent)',
            }}
          >
            <p className="text-[10px] uppercase tracking-wider text-ink-dim">{stat.label}</p>
            <p className="text-sm font-semibold tabular-nums text-ink">{stat.value}</p>
          </div>
        ))}
      </div>
      )}

      {footer && <div className="relative mt-2.5 text-[10px] text-ink-dim">{footer}</div>}
    </div>
  );
}
