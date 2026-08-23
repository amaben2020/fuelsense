'use client';

import { Bell, Fuel, MapPin, Route } from 'lucide-react';

export type DriverTab = 'fuel' | 'vehicle' | 'trips' | 'alerts';

export function DriverTabBar({
  active,
  onChange,
  pendingCount = 0,
  alertCount = 0,
}: {
  active: DriverTab;
  onChange: (tab: DriverTab) => void;
  pendingCount?: number;
  /** Alerts on this driver's vehicle still waiting for their account. */
  alertCount?: number;
}) {
  const tabs: { id: DriverTab; label: string; icon: typeof Fuel; badge: number }[] = [
    { id: 'fuel', label: 'Fuel', icon: Fuel, badge: pendingCount },
    { id: 'vehicle', label: 'Vehicle', icon: MapPin, badge: 0 },
    { id: 'trips', label: 'Trips', icon: Route, badge: 0 },
    { id: 'alerts', label: 'Alerts', icon: Bell, badge: alertCount },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-edge bg-panel/95 backdrop-blur-md safe-area-pb">
      <div className="mx-auto flex max-w-lg">
        {tabs.map(({ id, label, icon: Icon, badge }) => {
          const isActive = active === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              aria-current={isActive ? 'page' : undefined}
              // min-h-14 keeps every tab a comfortable thumb target on a phone
              // even when the label wraps on a narrow handset.
              className={`relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1 px-1 py-3 text-[11px] font-medium transition ${
                isActive ? 'text-brand' : 'text-ink-dim'
              }`}
            >
              <Icon className={`h-5 w-5 ${isActive ? 'text-brand' : ''}`} />
              {label}
              {badge > 0 && (
                <span className="absolute right-[calc(50%-28px)] top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-warn px-1 text-[9px] font-bold text-canvas">
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
