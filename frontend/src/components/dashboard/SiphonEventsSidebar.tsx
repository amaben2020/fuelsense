'use client';

import { X } from 'lucide-react';
import { FuelAnomaliesPanel } from '@/components/dashboard/FuelAnomaliesPanel';

export function SiphonEventsSidebar({
  isOpen,
  onClose,
  onViewOnMap,
}: {
  isOpen: boolean;
  onClose: () => void;
  onViewOnMap?: (lat: number, lng: number, vehicleId: string) => void;
}) {
  if (!isOpen) return null;

  return (
    <>
      <button type="button" className="fixed inset-0 z-40 bg-black/50" aria-label="Close" onClick={onClose} />
      <div className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col overflow-hidden border-l border-[#434656] bg-[#171f33] shadow-2xl">
        <div className="flex shrink-0 items-center justify-end border-b border-[#434656] px-4 py-3">
          <button type="button" onClick={onClose} className="rounded p-1 text-[#c4c5d9] hover:bg-[#2d3449]">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <FuelAnomaliesPanel active={isOpen} onViewOnMap={onViewOnMap} />
        </div>
      </div>
    </>
  );
}
