'use client';

/**
 * The wait before the dashboard has its data.
 *
 * Deliberately restrained. The previous version played a looping cartoon truck
 * driving around a grid, under a stack of three lines of copy — a wordmark, a
 * "COMMAND CENTER" eyebrow, "Loading fleet command center…", and a sentence
 * about satellite fixes. A fleet manager sees this several times a day; it is
 * not a place to advertise, and an animation with personality gets tiring long
 * before the first week is out.
 *
 * It also carried two glows in colours from nowhere in the palette — a blue
 * (rgba(39,110,241)) and the retired mint — which is how a loading screen ends
 * up looking like it belongs to a different product than the one behind it.
 *
 * What is left: the mark, one line of status, and a determinate-looking sweep.
 * No dependency, no Lottie payload, nothing to tire of.
 */
export function FleetCommandLoader({
  label = 'Loading fleet data',
}: {
  label?: string;
}) {
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center bg-canvas px-6"
      role="status"
      aria-live="polite"
    >
      <div className="flex w-full max-w-[280px] flex-col items-center">
        {/* The product mark — a satellite, because nothing here touches the
            tank and every litre is derived from a GNSS fix. */}
        <svg
          viewBox="0 0 64 64"
          className="h-9 w-9"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth={4}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ color: 'var(--brand)' }}
        >
          <rect x="26" y="26" width="12" height="12" rx="2.5" />
          <path d="M26 32H12M12 27v10M38 32h14M52 27v10" />
          <path d="M32 38v8" />
          <path d="M22.5 51.5a13 13 0 0 0 19 0" opacity="0.85" />
        </svg>

        <p className="mt-4 text-sm font-semibold tracking-tight text-ink">FuelSense</p>

        {/* A single hairline sweep. Reads as progress without claiming a
            percentage we do not know. */}
        <div className="mt-6 h-px w-full overflow-hidden bg-edge">
          <div className="fleet-loader-sweep h-full w-1/3 bg-brand" />
        </div>

        <p className="mt-4 text-xs text-ink-dim">{label}</p>
      </div>
    </div>
  );
}
