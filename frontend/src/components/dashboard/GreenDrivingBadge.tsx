'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Leaf, X } from 'lucide-react';
import { getGreenDrivingStatus, getToken, type GreenDrivingStatus } from '@/lib/api';

/**
 * Tells a manager that their trackers are scoring harsh driving themselves.
 *
 * The FMC150's Eco Driving scenario is switched on for this fleet, so the
 * device reports harsh acceleration, braking and cornering from its own motion
 * sensor — and FuelSense independently derives the same three from GPS. Both
 * feed the safety score, which is why a fleet can grade worse than its driving
 * alone would suggest. That is defensible, but only if it is visible: a score
 * nobody can account for is a score nobody trusts.
 *
 * Shown on every page rather than only the driving-behaviour panel, because
 * the score it qualifies is surfaced across the dashboard.
 */
export function GreenDrivingBadge() {
  const [status, setStatus] = useState<GreenDrivingStatus | null>(null);
  const [open, setOpen] = useState(false);
  // This component lives in the root layout, which does not remount when the
  // app navigates between routes. Without re-running on the path, someone who
  // signed in would see nothing until they happened to reload the page: the
  // effect would have run once on /login, found no token, and never looked
  // again.
  const pathname = usePathname();

  useEffect(() => {
    // Signed-out visitors have no fleet, and the landing pages have no score
    // to qualify. Read in an effect because localStorage does not exist during
    // the static export's prerender.
    const token = getToken();
    if (!token) {
      // Also covers signing out: the badge should go with the session.
      setStatus(null);
      return;
    }
    // Already answered — the tracker's configuration does not change between
    // one page and the next.
    if (status) return;

    let cancelled = false;
    getGreenDrivingStatus(7)
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      // A badge is an aside. If it cannot load, it says nothing rather than
      // pushing an error in front of whatever the manager came here to do.
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [pathname, status]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Nothing to disclose when the trackers are not reporting it.
  if (!status?.active) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label="Eco Driving is on. See how it affects your fleet scores."
        // The dashboard's icon rail is 77px wide and full height, but only
        // exists from `lg` up (it is `hidden lg:block`), so the badge clears it
        // at that breakpoint and sits at the edge below it. z-40 matches the
        // rail rather than exceeding it, so an open nav is never covered.
        className="fixed bottom-4 left-4 z-40 flex items-center gap-2 rounded-full border border-good/40 bg-good/10 px-3 py-2 text-xs font-medium text-good shadow-lg backdrop-blur transition hover:bg-good/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-good focus-visible:ring-offset-2 focus-visible:ring-offset-canvas lg:left-24"
      >
        <Leaf className="h-4 w-4 shrink-0" aria-hidden="true" />
        {/* Narrow screens get the leaf alone; the aria-label above carries the
            meaning for assistive tech either way, so no second copy of the
            text is needed here. */}
        <span className="hidden sm:inline">Eco Driving on</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="eco-driving-title"
        >
          <button
            type="button"
            className="absolute inset-0 bg-black/70"
            aria-label="Close"
            onClick={() => setOpen(false)}
          />
          <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-edge bg-panel p-6 shadow-xl">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="absolute right-4 top-4 rounded p-1 text-ink-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-good"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>

            <div className="flex items-center gap-2 text-good">
              <Leaf className="h-5 w-5" aria-hidden="true" />
              <h3 id="eco-driving-title" className="text-lg font-bold">
                Eco Driving is on
              </h3>
            </div>

            <p className="mt-3 text-sm text-ink-mid">
              Your {status.devices_reporting === 1 ? 'tracker judges' : 'trackers judge'} harsh
              driving using their own motion sensor, and send those events to FuelSense directly.
            </p>

            <div className="mt-4 rounded-lg border border-edge bg-panel-deep/40 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-dim">
                Harsh events in the last {status.period_days} days
              </p>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-ink-mid">From your tracker&rsquo;s motion sensor</dt>
                  <dd className="font-mono tabular-nums text-ink">{status.device_events}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-ink-mid">Worked out by FuelSense from GPS</dt>
                  <dd className="font-mono tabular-nums text-ink">{status.derived_events}</dd>
                </div>
              </dl>
            </div>

            <h4 className="mt-5 text-sm font-semibold text-ink">
              Why this matters for your score
            </h4>
            <p className="mt-2 text-sm text-ink-mid">
              FuelSense works out harsh acceleration, braking and cornering from GPS on its own,
              because many trackers have Eco Driving switched off. Yours does not, so both
              measurements are running — and <strong className="text-ink">both count toward your
              safety score</strong>. Your fleet is therefore being marked more strictly than
              either measurement alone would mark it.
            </p>
            <p className="mt-2 text-sm text-ink-mid">
              A low score here does not necessarily mean the driving is twice as bad. It means
              the same driving is being counted from two directions.
            </p>

            <h4 className="mt-5 text-sm font-semibold text-ink">What you can do</h4>
            <ul className="mt-2 space-y-2 text-sm text-ink-mid">
              <li>
                <strong className="text-ink">Read the score as a ranking, not a grade.</strong>{' '}
                It is still valid for comparing drivers and weeks against each other, because
                every vehicle is measured the same way.
              </li>
              <li>
                <strong className="text-ink">Trust the tracker over the estimate.</strong> A
                motion sensor measures a manoeuvre directly. GPS figures are worked out from
                changes in speed and heading, so they carry more noise.
              </li>
            </ul>

            {status.last_device_event_at && (
              <p className="mt-5 border-t border-edge pt-3 text-xs text-ink-dim">
                Last event from your tracker:{' '}
                {new Date(status.last_device_event_at).toLocaleString('en-NG', {
                  timeZone: 'Africa/Lagos',
                })}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
