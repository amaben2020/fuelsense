'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Fuel, Receipt, Shield } from 'lucide-react';
import {
  FleetVehicle,
  FuelPurchase,
  FuelPurchasesResponse,
  formatNgn,
  api,
} from '@/lib/api';
import { ReceiptEventModal } from '@/components/dashboard/ReceiptEventModal';

type ReceiptsTab = 'station' | 'reconciled';

function formatReceiptDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Africa/Lagos',
  });
}

function formatReceiptTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-NG', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: 'Africa/Lagos',
  });
}

function toDatetimeLocalValue(iso?: string) {
  const date = iso ? new Date(iso) : new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dateKey(iso: string) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}

function Pagination({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-[#434656] bg-[#0b1326] px-6 py-3">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className="rounded-lg border border-[#434656] px-3 py-1 text-xs disabled:opacity-40"
      >
        Previous
      </button>
      <span className="text-xs text-[#8e90a2]">
        Page {page} of {totalPages}
      </span>
      <button
        type="button"
        disabled={page >= totalPages}
        onClick={() => onPage(page + 1)}
        className="rounded-lg border border-[#434656] px-3 py-1 text-xs disabled:opacity-40"
      >
        Next
      </button>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 py-3 text-xs font-medium transition-colors sm:text-sm ${
        active
          ? 'border-[#b8c3ff] text-[#b8c3ff]'
          : 'border-transparent text-[#8e90a2] hover:text-[#c4c5d9]'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

export function ReceiptsPanel({
  data,
  fleet,
  page,
  onPageChange,
  onRefresh,
}: {
  data: FuelPurchasesResponse | null;
  fleet: FleetVehicle[];
  page: number;
  onPageChange: (p: number) => void;
  onRefresh: () => void;
}) {
  const purchases = data?.purchases ?? [];
  const summary = data?.summary;
  const [activeTab, setActiveTab] = useState<ReceiptsTab>('station');
  const [showForm, setShowForm] = useState(false);
  const [vehicleId, setVehicleId] = useState(fleet[0]?.id ?? '');
  const [declared, setDeclared] = useState('60');
  const [merchant, setMerchant] = useState('TotalEnergies Ikeja');
  const [receiptRef, setReceiptRef] = useState('');
  const [purchasedAtLocal, setPurchasedAtLocal] = useState(() => toDatetimeLocalValue());
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedPurchase, setSelectedPurchase] = useState<FuelPurchase | null>(null);

  const groupedByDate = useMemo(() => {
    const groups = new Map<string, FuelPurchase[]>();
    for (const purchase of purchases) {
      const key = dateKey(purchase.timestamp);
      const list = groups.get(key) ?? [];
      list.push(purchase);
      groups.set(key, list);
    }
    return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [purchases]);

  const dailyTotalsByDate = useMemo(() => {
    const map = new Map<
      string,
      NonNullable<FuelPurchasesResponse['summary']>['daily_totals']
    >();
    if (!summary?.daily_totals) return map;
    for (const row of summary.daily_totals) {
      const key = String(row.activity_date).slice(0, 10);
      const list = map.get(key) ?? [];
      list.push(row);
      map.set(key, list);
    }
    return map;
  }, [summary]);

  const theftCount = purchases.filter((p) => p.status === 'flagged_theft').length;

  const submitReceipt = async () => {
    setSubmitting(true);
    setMessage(null);
    try {
      const result = await api<{
        message: string;
        liters_actual: number | null;
        actual_from: string;
      }>('/telemetry/fuel-purchases/receipt', {
        method: 'POST',
        body: JSON.stringify({
          vehicle_id: vehicleId,
          liters_declared: Number(declared),
          merchant,
          receipt_reference: receiptRef || undefined,
          purchased_at: new Date(purchasedAtLocal).toISOString(),
        }),
      });
      setMessage(result.message);
      setShowForm(false);
      onRefresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {selectedPurchase && (
        <ReceiptEventModal purchase={selectedPurchase} onClose={() => setSelectedPurchase(null)} />
      )}
      {summary && activeTab === 'reconciled' && (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-[#434656] bg-[#171f33] p-4">
            <p className="text-xs text-[#8e90a2]">Grand total (receipt cost)</p>
            <p className="mt-1 text-2xl font-bold text-[#dae2fd]">
              {formatNgn(summary.grand_total.total_cost_ngn)}
            </p>
            <p className="mt-1 text-xs text-[#8e90a2]">
              {summary.grand_total.receipt_count} receipts logged
            </p>
          </div>
          <div className="rounded-lg border border-[#434656] bg-[#171f33] p-4">
            <p className="text-xs text-[#8e90a2]">Receipt liters (manual)</p>
            <p className="mt-1 font-mono text-2xl font-bold text-[#b8c3ff]">
              {summary.grand_total.total_receipt_liters.toFixed(1)} L
            </p>
            <p className="mt-1 text-xs text-[#8e90a2]">Driver-entered at fuel station</p>
          </div>
          <div className="rounded-lg border border-[#434656] bg-[#171f33] p-4">
            <p className="text-xs text-[#8e90a2]">OBD actual (FMC150)</p>
            <p className="mt-1 font-mono text-2xl font-bold text-[#4edea3]">
              {summary.grand_total.total_obd_liters.toFixed(1)} L
            </p>
            <p className="mt-1 text-xs text-[#ffb4ab]">
              {theftCount} flagged as theft on this page
            </p>
          </div>
        </div>
      )}

      {summary && activeTab === 'station' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-[#434656] bg-[#171f33] p-4">
            <p className="text-xs text-[#8e90a2]">Total logged at fuel stations</p>
            <p className="mt-1 text-2xl font-bold text-[#dae2fd]">
              {formatNgn(summary.grand_total.total_cost_ngn)}
            </p>
            <p className="mt-1 text-xs text-[#8e90a2]">
              {summary.grand_total.receipt_count} receipts · as entered by drivers
            </p>
          </div>
          <div className="rounded-lg border border-[#434656] bg-[#171f33] p-4">
            <p className="text-xs text-[#8e90a2]">Receipt liters (manual)</p>
            <p className="mt-1 font-mono text-2xl font-bold text-[#b8c3ff]">
              {summary.grand_total.total_receipt_liters.toFixed(1)} L
            </p>
            <p className="mt-1 text-xs text-[#8e90a2]">
              Switch to Reconciled to compare against FMC150 OBD
            </p>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-[#434656] bg-[#171f33]">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#434656] px-6 py-4">
          <div>
            <h2 className="flex items-center gap-2 font-semibold text-[#dae2fd]">
              <Receipt className="h-4 w-4" /> Receipts
            </h2>
            <p className="mt-1 text-xs text-[#8e90a2]">
              {activeTab === 'station'
                ? 'Exact pump purchase times — when the driver paid and logged liters at the station'
                : 'Timestamp reconciliation — use View event for pump, OBD, and ignition timeline'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="rounded-lg bg-[#2e5bff] px-3 py-2 text-xs font-medium text-white"
          >
            Log receipt
          </button>
        </div>

        <div className="flex border-b border-[#434656] px-2 sm:px-4">
          <TabButton
            active={activeTab === 'station'}
            onClick={() => setActiveTab('station')}
            label="Fuel station"
            icon={Fuel}
          />
          <TabButton
            active={activeTab === 'reconciled'}
            onClick={() => setActiveTab('reconciled')}
            label="Reconciled"
            icon={Shield}
          />
        </div>

        {showForm && (
          <div className="border-b border-[#434656] bg-[#0b1326] px-6 py-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <label className="text-xs text-[#8e90a2]">
                Vehicle
                <select
                  value={vehicleId}
                  onChange={(e) => setVehicleId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-[#434656] bg-[#171f33] px-2 py-2 text-sm text-[#dae2fd]"
                >
                  {fleet.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.license_plate}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-[#8e90a2]">
                Purchase time (exact)
                <input
                  type="datetime-local"
                  value={purchasedAtLocal}
                  onChange={(e) => setPurchasedAtLocal(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-[#434656] bg-[#171f33] px-2 py-2 text-sm text-[#dae2fd]"
                />
              </label>
              <label className="text-xs text-[#8e90a2]">
                Receipt liters
                <input
                  type="number"
                  value={declared}
                  onChange={(e) => setDeclared(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-[#434656] bg-[#171f33] px-2 py-2 text-sm text-[#dae2fd]"
                />
              </label>
              <label className="text-xs text-[#8e90a2]">
                Merchant
                <input
                  value={merchant}
                  onChange={(e) => setMerchant(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-[#434656] bg-[#171f33] px-2 py-2 text-sm text-[#dae2fd]"
                />
              </label>
              <label className="text-xs text-[#8e90a2]">
                Receipt #
                <input
                  value={receiptRef}
                  onChange={(e) => setReceiptRef(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-[#434656] bg-[#171f33] px-2 py-2 text-sm text-[#dae2fd]"
                />
              </label>
            </div>
            <button
              type="button"
              disabled={submitting}
              onClick={submitReceipt}
              className="mt-3 rounded-lg bg-[#4edea3] px-4 py-2 text-xs font-medium text-[#0b1326]"
            >
              {submitting ? 'Saving…' : 'Save receipt — match OBD actual'}
            </button>
          </div>
        )}

        {message && <p className="px-6 py-2 text-xs text-[#b8c3ff]">{message}</p>}

        {purchases.length === 0 ? (
          <p className="p-6 text-sm text-[#8e90a2]">
            No receipts yet. Run{' '}
            <code className="text-[#b8c3ff]">npm run seed-fuel-purchases</code> or log a receipt
            above.
          </p>
        ) : activeTab === 'station' ? (
          <StationReceiptsTable
            groupedByDate={groupedByDate}
            dailyTotalsByDate={dailyTotalsByDate}
            summary={summary}
            onViewEvent={setSelectedPurchase}
          />
        ) : (
          <ReconciledReceiptsTable
            groupedByDate={groupedByDate}
            dailyTotalsByDate={dailyTotalsByDate}
            summary={summary}
            onViewEvent={setSelectedPurchase}
          />
        )}

        {data && data.total_pages > 0 && (
          <Pagination page={page} totalPages={data.total_pages} onPage={onPageChange} />
        )}
      </div>
    </div>
  );
}

function StationReceiptsTable({
  groupedByDate,
  dailyTotalsByDate,
  summary,
  onViewEvent,
}: {
  groupedByDate: [string, FuelPurchase[]][];
  dailyTotalsByDate: Map<
    string,
    NonNullable<FuelPurchasesResponse['summary']>['daily_totals']
  >;
  summary?: FuelPurchasesResponse['summary'];
  onViewEvent: (purchase: FuelPurchase) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="bg-[#0b1326] text-xs uppercase tracking-wider text-[#8e90a2]">
          <tr>
            <th className="px-6 py-3">Date</th>
            <th className="px-6 py-3">Purchase time</th>
            <th className="px-6 py-3">Vehicle</th>
            <th className="px-6 py-3">Driver</th>
            <th className="px-6 py-3">Merchant</th>
            <th className="px-6 py-3">Receipt (L)</th>
            <th className="px-6 py-3">Cost</th>
            <th className="px-6 py-3">Receipt #</th>
            <th className="px-6 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-[#2d3449] text-[#c4c5d9]">
          {groupedByDate.map(([dayKey, dayPurchases]) => {
            const dayLabel = formatReceiptDate(dayPurchases[0].timestamp);
            const dayTotals = dailyTotalsByDate.get(dayKey) ?? [];
            const dayCost = dayTotals.reduce((sum, row) => sum + row.total_cost_ngn, 0);

            return (
              <StationDateGroup
                key={dayKey}
                dayLabel={dayLabel}
                purchases={dayPurchases}
                dayTotals={dayTotals}
                dayCost={dayCost}
                onViewEvent={onViewEvent}
              />
            );
          })}
        </tbody>
        {summary && (
          <tfoot className="border-t-2 border-[#434656] bg-[#0b1326] text-sm">
            <tr>
              <td colSpan={4} className="px-6 py-4 font-semibold text-[#dae2fd]">
                Grand total (fuel station)
              </td>
              <td className="px-6 py-4 font-mono font-semibold text-[#b8c3ff]">
                {summary.grand_total.total_receipt_liters.toFixed(1)} L
              </td>
              <td className="px-6 py-4 font-mono font-bold text-[#dae2fd]">
                {formatNgn(summary.grand_total.total_cost_ngn)}
              </td>
              <td colSpan={3} className="px-6 py-4 text-xs text-[#8e90a2]">
                {summary.grand_total.receipt_count} receipts
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function ReconciledReceiptsTable({
  groupedByDate,
  dailyTotalsByDate,
  summary,
  onViewEvent,
}: {
  groupedByDate: [string, FuelPurchase[]][];
  dailyTotalsByDate: Map<
    string,
    NonNullable<FuelPurchasesResponse['summary']>['daily_totals']
  >;
  summary?: FuelPurchasesResponse['summary'];
  onViewEvent: (purchase: FuelPurchase) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[920px] text-left text-sm">
        <thead className="bg-[#0b1326] text-xs uppercase tracking-wider text-[#8e90a2]">
          <tr>
            <th className="px-6 py-3">Date</th>
            <th className="px-6 py-3">Purchase time</th>
            <th className="px-6 py-3">Vehicle</th>
            <th className="px-6 py-3">Driver</th>
            <th className="px-6 py-3">Merchant</th>
            <th className="px-6 py-3">Receipt (L)</th>
            <th className="px-6 py-3">OBD actual (L)</th>
            <th className="px-6 py-3">Difference</th>
            <th className="px-6 py-3">Cost</th>
            <th className="px-6 py-3">Status</th>
            <th className="px-6 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-[#2d3449] text-[#c4c5d9]">
          {groupedByDate.map(([dayKey, dayPurchases]) => {
            const dayLabel = formatReceiptDate(dayPurchases[0].timestamp);
            const dayTotals = dailyTotalsByDate.get(dayKey) ?? [];

            return (
              <ReconciledDateGroup
                key={dayKey}
                dayLabel={dayLabel}
                purchases={dayPurchases}
                dayTotals={dayTotals}
                onViewEvent={onViewEvent}
              />
            );
          })}
        </tbody>
        {summary && (
          <tfoot className="border-t-2 border-[#434656] bg-[#0b1326] text-sm">
            <tr>
              <td colSpan={5} className="px-6 py-4 font-semibold text-[#dae2fd]">
                Grand total (reconciled)
              </td>
              <td className="px-6 py-4 font-mono font-semibold text-[#b8c3ff]">
                {summary.grand_total.total_receipt_liters.toFixed(1)} L
              </td>
              <td className="px-6 py-4 font-mono font-semibold text-[#4edea3]">
                {summary.grand_total.total_obd_liters.toFixed(1)} L
              </td>
              <td className="px-6 py-4 font-mono text-[#ffb4ab]">
                −
                {Math.max(
                  0,
                  Math.round(
                    (summary.grand_total.total_receipt_liters -
                      summary.grand_total.total_obd_liters) *
                      10
                  ) / 10
                )}{' '}
                L
              </td>
              <td className="px-6 py-4 font-mono font-bold text-[#dae2fd]">
                {formatNgn(summary.grand_total.total_cost_ngn)}
              </td>
              <td colSpan={2} className="px-6 py-4 text-xs text-[#8e90a2]">
                {summary.grand_total.receipt_count} receipts
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function ViewEventButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="whitespace-nowrap rounded-lg border border-[#2e5bff]/40 bg-[#2e5bff]/15 px-2.5 py-1.5 text-xs font-medium text-[#b8c3ff] hover:bg-[#2e5bff]/25"
    >
      View event
    </button>
  );
}

function StationDateGroup({
  dayLabel,
  purchases,
  dayTotals,
  dayCost,
  onViewEvent,
}: {
  dayLabel: string;
  purchases: FuelPurchase[];
  dayTotals: Array<{
    driver_name: string;
    total_cost_ngn: number;
    total_receipt_liters: number;
    receipt_count: number;
  }>;
  dayCost: number;
  onViewEvent: (purchase: FuelPurchase) => void;
}) {
  return (
    <>
      <tr className="bg-[#222a3d]/60">
        <td colSpan={9} className="px-6 py-2 text-xs font-semibold uppercase tracking-wider text-[#b8c3ff]">
          {dayLabel}
          {dayCost > 0 && (
            <span className="ml-3 font-mono normal-case text-[#8e90a2]">
              Day total {formatNgn(dayCost)}
            </span>
          )}
        </td>
      </tr>
      {purchases.map((purchase) => (
        <StationReceiptRow key={purchase.id} purchase={purchase} onViewEvent={onViewEvent} />
      ))}
      {dayTotals.map((row) => (
        <tr key={`${dayLabel}-${row.driver_name}-station`} className="bg-[#0b1326]/80">
          <td colSpan={4} className="px-6 py-2 text-xs text-[#8e90a2]">
            Daily total · {row.driver_name}
          </td>
          <td className="px-6 py-2 text-xs text-[#8e90a2]">
            {row.receipt_count} receipt{row.receipt_count === 1 ? '' : 's'}
          </td>
          <td className="px-6 py-2 font-mono text-xs text-[#b8c3ff]">
            {row.total_receipt_liters.toFixed(1)} L
          </td>
          <td className="px-6 py-2 font-mono text-xs font-semibold text-[#dae2fd]">
            {formatNgn(row.total_cost_ngn)}
          </td>
          <td colSpan={2} />
        </tr>
      ))}
    </>
  );
}

function ReconciledDateGroup({
  dayLabel,
  purchases,
  dayTotals,
  onViewEvent,
}: {
  dayLabel: string;
  purchases: FuelPurchase[];
  dayTotals: Array<{
    driver_name: string;
    total_cost_ngn: number;
    total_receipt_liters: number;
    total_obd_liters: number;
    receipt_count: number;
  }>;
  onViewEvent: (purchase: FuelPurchase) => void;
}) {
  const dayCost = dayTotals.reduce((sum, row) => sum + row.total_cost_ngn, 0);

  return (
    <>
      <tr className="bg-[#222a3d]/60">
        <td colSpan={11} className="px-6 py-2 text-xs font-semibold uppercase tracking-wider text-[#b8c3ff]">
          {dayLabel}
          {dayCost > 0 && (
            <span className="ml-3 font-mono normal-case text-[#8e90a2]">
              Day total {formatNgn(dayCost)}
            </span>
          )}
        </td>
      </tr>
      {purchases.map((purchase) => (
        <ReconciledReceiptRow key={purchase.id} purchase={purchase} onViewEvent={onViewEvent} />
      ))}
      {dayTotals.map((row) => (
        <tr key={`${dayLabel}-${row.driver_name}-reconciled`} className="bg-[#0b1326]/80">
          <td colSpan={5} className="px-6 py-2 text-xs text-[#8e90a2]">
            Daily total · {row.driver_name}
          </td>
          <td className="px-6 py-2 font-mono text-xs text-[#b8c3ff]">
            {row.total_receipt_liters.toFixed(1)} L
          </td>
          <td className="px-6 py-2 font-mono text-xs text-[#4edea3]">
            {row.total_obd_liters.toFixed(1)} L
          </td>
          <td className="px-6 py-2 font-mono text-xs text-[#ffb4ab]">
            −{Math.max(0, Math.round((row.total_receipt_liters - row.total_obd_liters) * 10) / 10)} L
          </td>
          <td className="px-6 py-2 font-mono text-xs font-semibold text-[#dae2fd]">
            {formatNgn(row.total_cost_ngn)}
          </td>
          <td colSpan={2} />
        </tr>
      ))}
    </>
  );
}

function StationReceiptRow({
  purchase,
  onViewEvent,
}: {
  purchase: FuelPurchase;
  onViewEvent: (purchase: FuelPurchase) => void;
}) {
  const purchaseTime = purchase.purchased_at ?? purchase.timestamp;
  return (
    <tr>
      <td className="px-6 py-3">{formatReceiptDate(purchaseTime)}</td>
      <td className="px-6 py-3 font-mono text-xs text-[#b8c3ff]">{formatReceiptTime(purchaseTime)}</td>
      <td className="px-6 py-3 font-medium text-[#dae2fd]">{purchase.license_plate}</td>
      <td className="px-6 py-3 text-[#8e90a2]">{purchase.driver_name ?? '—'}</td>
      <td className="px-6 py-3">{purchase.merchant}</td>
      <td className="px-6 py-3 font-mono text-[#b8c3ff]">{purchase.liters_declared} L</td>
      <td className="px-6 py-3 font-mono">{formatNgn(purchase.total_cost_ngn)}</td>
      <td className="px-6 py-3 font-mono text-xs text-[#8e90a2]">
        {purchase.receipt_reference ?? '—'}
      </td>
      <td className="px-6 py-3">
        <ViewEventButton onClick={() => onViewEvent(purchase)} />
      </td>
    </tr>
  );
}

function ReconciledReceiptRow({
  purchase,
  onViewEvent,
  compact = false,
}: {
  purchase: FuelPurchase;
  onViewEvent: (purchase: FuelPurchase) => void;
  compact?: boolean;
}) {
  const isTheft = purchase.status === 'flagged_theft';
  const isPending = purchase.status === 'pending_receipt';
  const purchaseTime = purchase.purchased_at ?? purchase.timestamp;
  const obdDisplay =
    purchase.liters_actual != null
      ? `${purchase.liters_actual} L`
      : isPending
        ? '0 L'
        : 'Pending OBD';

  if (compact) {
    return (
      <tr className={isTheft ? 'bg-[#93000a]/5' : undefined}>
        <td className="px-6 py-3">{formatReceiptDate(purchaseTime)}</td>
        <td className="px-6 py-3 font-medium text-[#dae2fd]">{purchase.license_plate}</td>
        <td className="px-6 py-3 font-mono">{purchase.liters_declared} L</td>
        <td className={`px-6 py-3 font-mono ${isPending ? 'text-[#ffb95f]' : 'text-[#4edea3]'}`}>
          {obdDisplay}
        </td>
        <td
          className={`px-6 py-3 font-mono ${isTheft ? 'font-bold text-[#ffb4ab]' : purchase.difference_liters > 0 ? 'text-[#ffb4ab]' : 'text-[#4edea3]'}`}
        >
          {purchase.difference_liters > 0 ? `−${purchase.difference_liters} L` : '0 L'}
        </td>
        <td className="px-6 py-3 font-mono">{formatNgn(purchase.total_cost_ngn)}</td>
        <td className="px-6 py-3">
          {isTheft ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#93000a]/20 px-2 py-1 text-xs text-[#ffb4ab]">
              <AlertTriangle className="h-3 w-3" /> Theft
            </span>
          ) : isPending ? (
            <span className="text-xs text-[#ffb95f]">Pending</span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#4edea3]/20 px-2 py-1 text-xs text-[#4edea3]">
              <Shield className="h-3 w-3" /> Verified
            </span>
          )}
        </td>
        <td className="px-6 py-3">
          <ViewEventButton onClick={() => onViewEvent(purchase)} />
        </td>
      </tr>
    );
  }

  return (
    <tr className={isTheft ? 'bg-[#93000a]/5' : undefined}>
      <td className="px-6 py-3">{formatReceiptDate(purchaseTime)}</td>
      <td className="px-6 py-3 font-mono text-xs text-[#b8c3ff]">{formatReceiptTime(purchaseTime)}</td>
      <td className="px-6 py-3 font-medium text-[#dae2fd]">{purchase.license_plate}</td>
      <td className="px-6 py-3 text-[#8e90a2]">{purchase.driver_name ?? '—'}</td>
      <td className="px-6 py-3">{purchase.merchant}</td>
      <td className="px-6 py-3 font-mono">{purchase.liters_declared} L</td>
      <td className={`px-6 py-3 font-mono ${isPending ? 'text-[#ffb95f]' : 'text-[#4edea3]'}`}>
        {obdDisplay}
      </td>
      <td
        className={`px-6 py-3 font-mono ${isTheft ? 'font-bold text-[#ffb4ab]' : purchase.difference_liters > 0 ? 'text-[#ffb4ab]' : 'text-[#4edea3]'}`}
      >
        {purchase.difference_liters > 0 ? `−${purchase.difference_liters} L` : '0 L'}
      </td>
      <td className="px-6 py-3 font-mono">{formatNgn(purchase.total_cost_ngn)}</td>
      <td className="px-6 py-3">
        {isTheft ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-[#93000a]/20 px-2 py-1 text-xs text-[#ffb4ab]">
            <AlertTriangle className="h-3 w-3" /> Theft
          </span>
        ) : isPending ? (
          <span className="text-xs text-[#ffb95f]">Pending</span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-[#4edea3]/20 px-2 py-1 text-xs text-[#4edea3]">
            <Shield className="h-3 w-3" /> Verified
          </span>
        )}
      </td>
      <td className="px-6 py-3">
        <ViewEventButton onClick={() => onViewEvent(purchase)} />
      </td>
    </tr>
  );
}

/** Compact reconciliation table for Fuel analytics view */
export function FuelPurchaseTable({
  data,
  onOpenReceipts,
}: {
  data: FuelPurchasesResponse | null;
  fleet: FleetVehicle[];
  page: number;
  onPageChange: (p: number) => void;
  onRefresh: () => void;
  onOpenReceipts?: () => void;
}) {
  const purchases = data?.purchases ?? [];
  const [selectedPurchase, setSelectedPurchase] = useState<FuelPurchase | null>(null);

  return (
    <div className="overflow-hidden rounded-lg border border-[#434656] bg-[#171f33]">
      {selectedPurchase && (
        <ReceiptEventModal purchase={selectedPurchase} onClose={() => setSelectedPurchase(null)} />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#434656] px-6 py-4">
        <div>
          <h2 className="flex items-center gap-2 font-semibold text-[#dae2fd]">
            <Receipt className="h-4 w-4" /> Fuel purchase reconciliation
          </h2>
          <p className="mt-1 text-xs text-[#8e90a2]">
            Receipt liters (manual) vs actual liters from FMC150 OBD fuel sensor at refuel time
          </p>
        </div>
        {onOpenReceipts && (
          <button
            type="button"
            onClick={onOpenReceipts}
            className="rounded-lg border border-[#2e5bff]/40 bg-[#2e5bff]/15 px-3 py-2 text-xs font-medium text-[#b8c3ff]"
          >
            Open Receipts →
          </button>
        )}
      </div>
      {purchases.length === 0 ? (
        <p className="p-6 text-sm text-[#8e90a2]">No fuel purchases yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-left text-sm">
            <thead className="bg-[#0b1326] text-xs uppercase tracking-wider text-[#8e90a2]">
              <tr>
                <th className="px-6 py-3">Date</th>
                <th className="px-6 py-3">Vehicle</th>
                <th className="px-6 py-3">Receipt (L)</th>
                <th className="px-6 py-3">OBD actual (L)</th>
                <th className="px-6 py-3">Difference</th>
                <th className="px-6 py-3">Cost</th>
                <th className="px-6 py-3">Status</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2d3449] text-[#c4c5d9]">
              {purchases.slice(0, 5).map((purchase) => (
                <ReconciledReceiptRow
                  key={purchase.id}
                  purchase={purchase}
                  onViewEvent={setSelectedPurchase}
                  compact
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {onOpenReceipts && purchases.length > 0 && (
        <div className="border-t border-[#434656] px-6 py-3">
          <button
            type="button"
            onClick={onOpenReceipts}
            className="text-xs text-[#b8c3ff] hover:underline"
          >
            View all {data?.total ?? purchases.length} receipts with daily totals →
          </button>
        </div>
      )}
    </div>
  );
}
