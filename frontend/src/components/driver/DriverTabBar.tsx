'use client';

import { Fuel, MapPin, Route } from 'lucide-react';

export type DriverTab = 'fuel' | 'vehicle' | 'trips';

export function DriverTabBar({
  active,
  onChange,
  pendingCount = 0,
}: {
  active: DriverTab;
  onChange: (tab: DriverTab) => void;
  pendingCount?: number;
}) {
  const tabs: { id: DriverTab; label: string; icon: typeof Fuel }[] = [
    { id: 'fuel', label: 'Fuel', icon: Fuel },
    { id: 'vehicle', label: 'Vehicle', icon: MapPin },
    { id: 'trips', label: 'Trips', icon: Route },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-edge bg-panel/95 backdrop-blur-md safe-area-pb">
      <div className="mx-auto flex max-w-lg">
        {tabs.map(({ id, label, icon: Icon }) => {
          const isActive = active === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              className={`relative flex flex-1 flex-col items-center gap-1 py-3 text-[11px] font-medium transition ${
                isActive ? 'text-brand' : 'text-ink-dim'
              }`}
            >
              <Icon className={`h-5 w-5 ${isActive ? 'text-brand' : ''}`} />
              {label}
              {id === 'fuel' && pendingCount > 0 && (
                <span className="absolute right-[calc(50%-28px)] top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-warn px-1 text-[9px] font-bold text-canvas">
                  {pendingCount}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
