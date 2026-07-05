'use client';

import Lottie from 'lottie-react';
import fleetCommandLoader from '@/assets/animations/fleet-command-loader.json';

export function FleetCommandLoader() {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-canvas px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(39,110,241,0.22),transparent_55%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-1/2 h-64 w-[32rem] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(78,222,163,0.12),transparent_70%)]"
      />

      <div className="relative w-full max-w-[420px]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-8 top-1/2 h-40 -translate-y-1/2 rounded-full bg-accent/20 blur-3xl"
        />
        <Lottie
          animationData={fleetCommandLoader}
          loop
          autoplay
          className="relative h-[300px] w-full drop-shadow-[0_24px_48px_rgba(0,0,0,0.45)]"
          aria-hidden
        />
      </div>

      <div className="relative mt-2 text-center">
        <p className="neon-text text-2xl font-bold tracking-tight">FuelSense</p>
        <p className="mt-1 text-[10px] uppercase tracking-[0.22em] text-good">Command center</p>
        <p className="mt-5 text-sm font-medium text-ink-mid">
          Loading fleet command center
          <span className="fleet-loader-dots" aria-hidden>
            ...
          </span>
        </p>
        <p className="mt-2 text-xs text-ink-dim">Syncing vehicles, routes, and live telemetry</p>
      </div>
    </div>
  );
}
