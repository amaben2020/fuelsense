'use client';

import { useState } from 'react';
import { AlertTriangle, Receipt, Shield } from 'lucide-react';
import { FleetVehicle, FuelPurchase, FuelPurchasesResponse, formatNgn, api } from '@/lib/api';

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

export function FuelPurchaseTable({
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
  const [showForm, setShowForm] = useState(false);
  const [vehicleId, setVehicleId] = useState(fleet[0]?.id ?? '');
  const [declared, setDeclared] = useState('60');
  const [merchant, setMerchant] = useState('TotalEnergies Ikeja');
  const [receiptRef, setReceiptRef] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

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
    <div className="overflow-hidden rounded-lg border border-[#434656] bg-[#171f33]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#434656] px-6 py-4">
        <div>
          <h2 className="flex items-center gap-2 font-semibold text-[#dae2fd]">
            <Receipt className="h-4 w-4" /> Fuel purchase reconciliation
          </h2>
          <p className="mt-1 text-xs text-[#8e90a2]">
            Receipt liters (manual) vs actual liters from FMC150 OBD fuel sensor at refuel time
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="rounded-lg bg-[#2e5bff] px-3 py-2 text-xs text-white"
        >
          Log receipt
        </button>
      </div>

      {showForm && (
        <div className="border-b border-[#434656] bg-[#0b1326] px-6 py-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs text-[#8e90a2]">
              Vehicle
              <select
                value={vehicleId}
                onChange={(e) => setVehicleId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-[#434656] bg-[#171f33] px-2 py-2 text-sm"
              >
                {fleet.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.license_plate}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-[#8e90a2]">
              Receipt liters
              <input
                type="number"
                value={declared}
                onChange={(e) => setDeclared(e.target.value)}
                className="mt-1 w-full rounded-lg border border-[#434656] bg-[#171f33] px-2 py-2 text-sm"
              />
            </label>
            <label className="text-xs text-[#8e90a2]">
              Merchant
              <input
                value={merchant}
                onChange={(e) => setMerchant(e.target.value)}
                className="mt-1 w-full rounded-lg border border-[#434656] bg-[#171f33] px-2 py-2 text-sm"
              />
            </label>
            <label className="text-xs text-[#8e90a2]">
              Receipt #
              <input
                value={receiptRef}
                onChange={(e) => setReceiptRef(e.target.value)}
                className="mt-1 w-full rounded-lg border border-[#434656] bg-[#171f33] px-2 py-2 text-sm"
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
          No fuel purchases yet. Run{' '}
          <code className="text-[#b8c3ff]">npm run seed-fuel-purchases</code> or log a receipt
          above.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px] text-left text-sm">
            <thead className="bg-[#0b1326] text-xs uppercase tracking-wider text-[#8e90a2]">
              <tr>
                <th className="px-6 py-3">Date</th>
                <th className="px-6 py-3">Vehicle</th>
                <th className="px-6 py-3">Merchant</th>
                <th className="px-6 py-3">Receipt (L)</th>
                <th className="px-6 py-3">OBD actual (L)</th>
                <th className="px-6 py-3">Difference</th>
                <th className="px-6 py-3">Cost</th>
                <th className="px-6 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2d3449] text-[#c4c5d9]">
              {purchases.map((purchase) => (
                <PurchaseRow key={purchase.id} purchase={purchase} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total_pages > 0 && (
        <Pagination page={page} totalPages={data.total_pages} onPage={onPageChange} />
      )}
    </div>
  );
}

function PurchaseRow({ purchase }: { purchase: FuelPurchase }) {
  const isTheft = purchase.status === 'flagged_theft';
  return (
    <tr className={isTheft ? 'bg-[#93000a]/5' : undefined}>
      <td className="px-6 py-3">{new Date(purchase.timestamp).toLocaleDateString()}</td>
      <td className="px-6 py-3 font-medium text-[#dae2fd]">{purchase.license_plate}</td>
      <td className="px-6 py-3">{purchase.merchant}</td>
      <td className="px-6 py-3 font-mono">{purchase.liters_declared} L</td>
      <td className="px-6 py-3 font-mono text-[#4edea3]">
        {purchase.liters_actual != null ? `${purchase.liters_actual} L` : 'Pending OBD'}
      </td>
      <td
        className={`px-6 py-3 font-mono ${isTheft ? 'font-bold text-[#ffb4ab]' : 'text-[#4edea3]'}`}
      >
        {purchase.difference_liters > 0 ? `−${purchase.difference_liters} L` : '0 L'}
      </td>
      <td className="px-6 py-3 font-mono">{formatNgn(purchase.total_cost_ngn)}</td>
      <td className="px-6 py-3">
        {isTheft ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-[#93000a]/20 px-2 py-1 text-xs text-[#ffb4ab]">
            <AlertTriangle className="h-3 w-3" /> Theft
          </span>
        ) : purchase.status === 'pending_receipt' ? (
          <span className="text-xs text-[#ffb95f]">Pending</span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-[#4edea3]/20 px-2 py-1 text-xs text-[#4edea3]">
            <Shield className="h-3 w-3" /> Verified
          </span>
        )}
      </td>
    </tr>
  );
}
