'use client';

import { useCallback, useEffect, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { FleetVehicle, MaintenanceResponse, fetchMaintenance } from '@/lib/api';
import { Panel } from '@/components/ui/chrome';
import { MaintenanceSchedules } from './MaintenanceSchedules';
import { LoadErrorBanner } from './LoadErrorBanner';

/**
 * The things you keep on a vehicle that the tracker cannot work out for you.
 *
 * Service schedules used to sit under Fleet intelligence, which claimed more
 * than they deliver: what to service and how often is a decision somebody
 * types, not a signal the FMC150 sends. Only the countdown is measured — AVL
 * 16 supplies the distance. Keeping the two apart means everything left in
 * Fleet intelligence is genuinely derived, and everything here is honestly
 * record-keeping the tracker happens to help with.
 */
export function VehicleRecordsPanel({ fleet = [] }: { fleet?: FleetVehicle[] }) {
  const [maintenance, setMaintenance] = useState<MaintenanceResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const runFetch = useCallback(() => {
    fetchMaintenance()
      .then((m) => {
        setMaintenance(m);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    runFetch();
  }, [runFetch]);

  useEffect(() => {
    runFetch();
  }, [runFetch]);

  if (error) {
    return <LoadErrorBanner error={error} subject="vehicle records" onRetry={load} />;
  }

  return (
    <div className="space-y-4">
      <Panel
        icon={ClipboardList}
        title="Servicing"
        subtitle="What each vehicle is due for. You set the interval; the tracker counts it down."
        onRefresh={load}
        refreshing={loading}
      >
        <MaintenanceSchedules data={maintenance} fleet={fleet} onChanged={runFetch} />
      </Panel>
    </div>
  );
}
