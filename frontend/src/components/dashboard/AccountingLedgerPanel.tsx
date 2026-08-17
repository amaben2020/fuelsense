'use client';

import { useEffect, useMemo, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight, LayoutGrid, Table2 } from 'lucide-react';
import { api, formatNgn, FuelPurchase, FuelPurchasesResponse } from '@/lib/api';
import { PurchaseCalendarView } from '@/components/dashboard/PurchaseCalendarView';
import { ReceiptEventModal } from '@/components/dashboard/ReceiptEventModal';

const PAGE_SIZE = 25;
// The on-screen table pages at 25; export pulls the whole history in as few
// round trips as the backend's cap allows, looping pages rather than trusting
// one big fetch to have covered everything.
const EXPORT_PAGE_SIZE = 500;

/** Generic spreadsheet mark in Excel's own green, not a reproduction of
 * Microsoft's trademarked logo asset. */
function ExcelIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" aria-hidden>
      <rect x="1" y="2" width="18" height="16" rx="2" fill="#1D6F42" />
      <rect x="4" y="5" width="12" height="10" rx="1" fill="#0B4A2A" />
      <path
        d="M6.5 7l2.4 3-2.4 3h1.7l1.55-2.1L11.3 13H13l-2.4-3 2.4-3h-1.7l-1.55 2.1L8.2 7z"
        fill="#ffffff"
      />
    </svg>
  );
}

/**
 * Real .xlsx via exceljs, built and downloaded client-side. Only the writer
 * half of the library ever runs here — the parser (`workbook.xlsx.load`)
 * is never called, since nothing this feature does reads a file back in.
 */
async function downloadXlsx(
  filename: string,
  header: string[],
  rows: (string | number)[][],
  totalsRow: (string | number)[]
): Promise<void> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'FuelSense';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Fuel purchases');
  sheet.addRow(header);
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D6F42' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  });

  rows.forEach((row) => sheet.addRow(row));

  const total = sheet.addRow(totalsRow);
  total.font = { bold: true };

  sheet.columns.forEach((col) => {
    let max = 10;
    col.eachCell?.({ includeEmpty: true }, (cell) => {
      max = Math.max(max, String(cell.value ?? '').length + 2);
    });
    col.width = Math.min(max, 40);
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function purchaseRow(p: FuelPurchase): (string | number)[] {
  return [
    new Date(p.purchased_at ?? p.timestamp).toLocaleString('en-NG'),
    p.driver_name ?? 'Unassigned',
    p.license_plate,
    Number(p.liters_declared.toFixed(2)),
    p.cost_per_liter_ngn,
    p.total_cost_ngn,
    p.distance_km != null ? Number(p.distance_km.toFixed(1)) : '',
    p.merchant ?? '',
    p.status,
  ];
}

const LEDGER_HEADER = [
  'Date',
  'Driver',
  'Vehicle',
  'Litres purchased',
  'Price per litre (NGN)',
  'Amount (NGN)',
  'Distance since last fill (km)',
  'Merchant',
  'Status',
];

/** Bars, not a line — spend-over-time is an accounting question, and each
 * day is a discrete transaction total rather than a continuous reading. */
function SpendChart({ points }: { points: [string, number][] }) {
  if (points.length === 0) {
    return <p className="py-12 text-center text-sm text-ink-dim">No purchases yet.</p>;
  }

  const W = 720;
  const H = 260;
  const PAD = { top: 20, right: 16, bottom: 32, left: 12 };
  const max = Math.max(...points.map(([, v]) => v), 1);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const barW = plotW / points.length;
  const showLabelEvery = Math.max(1, Math.ceil(points.length / 10));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Fuel spend per day">
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const y = PAD.top + t * plotH;
        return (
          <line
            key={t}
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y}
            y2={y}
            stroke="var(--edge)"
            strokeWidth={1}
            opacity={0.5}
          />
        );
      })}
      {points.map(([date, value], i) => {
        const h = max > 0 ? (value / max) * plotH : 0;
        const x = PAD.left + i * barW;
        const y = PAD.top + plotH - h;
        return (
          <g key={date}>
            <rect
              x={x + barW * 0.18}
              y={y}
              width={Math.max(barW * 0.64, 1)}
              height={Math.max(h, value > 0 ? 2 : 0)}
              rx={2}
              fill="var(--brand)"
            >
              <title>
                {new Date(date).toLocaleDateString()} · {formatNgn(value)}
              </title>
            </rect>
            {i % showLabelEvery === 0 && (
              <text
                x={x + barW / 2}
                y={H - PAD.bottom + 14}
                textAnchor="middle"
                fontSize={9}
                fill="var(--ink-dim)"
              >
                {new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              </text>
            )}
          </g>
        );
      })}
      <text x={PAD.left} y={PAD.top - 6} fontSize={10} fill="var(--ink-dim)">
        {formatNgn(max)}
      </text>
    </svg>
  );
}

export function AccountingLedgerPanel() {
  const [view, setView] = useState<'table' | 'graph' | 'calendar'>('table');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<FuelPurchasesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [selectedPurchase, setSelectedPurchase] = useState<FuelPurchase | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<FuelPurchasesResponse>(
      `/telemetry/fuel-purchases?page=${page}&limit=${PAGE_SIZE}&include_summary=true`
    )
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page]);

  const spendByDate = useMemo(() => {
    const totals = data?.summary?.daily_totals ?? [];
    // daily_totals is one row per (date, driver) pair, since the driver
    // breakdown belongs elsewhere — the chart wants one point per day.
    const byDate = new Map<string, number>();
    for (const row of totals) {
      byDate.set(row.activity_date, (byDate.get(row.activity_date) ?? 0) + row.total_cost_ngn);
    }
    return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data]);

  const exportToExcel = async () => {
    setExporting(true);
    setError(null);
    try {
      const all: FuelPurchase[] = [];
      let p = 1;
      let totalPages = 1;
      do {
        const res = await api<FuelPurchasesResponse>(
          `/telemetry/fuel-purchases?page=${p}&limit=${EXPORT_PAGE_SIZE}`
        );
        all.push(...res.purchases);
        totalPages = res.total_pages || 1;
        p += 1;
      } while (p <= totalPages);

      const totalAmount = all.reduce((sum, row) => sum + row.total_cost_ngn, 0);
      const totalLiters = all.reduce((sum, row) => sum + row.liters_declared, 0);

      await downloadXlsx(
        `fuel-purchase-ledger-${new Date().toISOString().slice(0, 10)}.xlsx`,
        LEDGER_HEADER,
        all.map(purchaseRow),
        ['', '', '', Number(totalLiters.toFixed(2)), '', totalAmount, '', '', 'TOTAL']
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const totalPages = data?.total_pages ?? 1;
  const grandTotal = data?.summary?.grand_total;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-edge bg-panel p-5">
        <div>
          <h2 className="font-semibold text-ink">Fuel purchase ledger</h2>
          <p className="mt-1 text-xs text-ink-dim">
            Every logged fill-up, one row per purchase — the same record a fleet manager would
            otherwise keep in a separate spreadsheet.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center gap-1 rounded-full border border-edge bg-panel-deep p-1">
            <button
              type="button"
              onClick={() => setView('table')}
              aria-pressed={view === 'table'}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                view === 'table' ? 'bg-brand text-canvas' : 'text-ink-dim hover:text-ink'
              }`}
            >
              <Table2 className="h-3.5 w-3.5" /> Table
            </button>
            <button
              type="button"
              onClick={() => setView('graph')}
              aria-pressed={view === 'graph'}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                view === 'graph' ? 'bg-brand text-canvas' : 'text-ink-dim hover:text-ink'
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" /> Graph
            </button>
            <button
              type="button"
              onClick={() => setView('calendar')}
              aria-pressed={view === 'calendar'}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                view === 'calendar' ? 'bg-brand text-canvas' : 'text-ink-dim hover:text-ink'
              }`}
            >
              <Calendar className="h-3.5 w-3.5" /> Calendar
            </button>
          </div>
          <button
            type="button"
            onClick={exportToExcel}
            disabled={exporting}
            className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-panel-deep px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:border-brand/40 hover:text-brand disabled:opacity-50"
          >
            <ExcelIcon className="h-3.5 w-3.5" /> {exporting ? 'Exporting…' : 'Export to Excel'}
          </button>
        </div>
      </div>

      {grandTotal && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryTile label="Purchases" value={String(grandTotal.receipt_count)} />
          <SummaryTile label="Total spend" value={formatNgn(grandTotal.total_cost_ngn)} />
          <SummaryTile label="Litres bought" value={`${grandTotal.total_receipt_liters.toFixed(1)} L`} />
          <SummaryTile
            label="Avg. price / L"
            value={
              grandTotal.total_receipt_liters > 0
                ? formatNgn(Math.round(grandTotal.total_cost_ngn / grandTotal.total_receipt_liters))
                : '—'
            }
          />
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-bad/40 bg-bad-deep/20 p-3 text-sm text-bad">{error}</div>
      )}

      {selectedPurchase && (
        <ReceiptEventModal purchase={selectedPurchase} onClose={() => setSelectedPurchase(null)} />
      )}

      <div className="rounded-lg border border-edge bg-panel p-5">
        {loading && !data ? (
          <p className="py-12 text-center text-sm text-ink-dim">Loading ledger…</p>
        ) : view === 'graph' ? (
          <SpendChart points={spendByDate} />
        ) : view === 'calendar' ? (
          <PurchaseCalendarView
            purchases={data?.purchases ?? []}
            onViewEvent={setSelectedPurchase}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-edge text-xs uppercase tracking-wider text-ink-dim">
                    <th className="py-2 pr-4 font-medium">Date</th>
                    <th className="py-2 pr-4 font-medium">Driver</th>
                    <th className="py-2 pr-4 font-medium">Vehicle</th>
                    <th className="py-2 pr-4 text-right font-medium">Litres</th>
                    <th className="py-2 pr-4 text-right font-medium">₦ / L</th>
                    <th className="py-2 pr-4 text-right font-medium">Amount</th>
                    <th className="py-2 pr-4 text-right font-medium">Distance</th>
                    <th className="py-2 pr-4 font-medium">Merchant</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.purchases ?? []).map((p) => (
                    <tr key={p.id} className="border-b border-edge/60 last:border-0">
                      <td className="py-2.5 pr-4 text-ink-mid">
                        {new Date(p.purchased_at ?? p.timestamp).toLocaleDateString()}
                      </td>
                      <td className="py-2.5 pr-4 text-ink">{p.driver_name ?? 'Unassigned'}</td>
                      <td className="py-2.5 pr-4 font-mono text-ink-mid">{p.license_plate}</td>
                      <td className="py-2.5 pr-4 text-right font-mono tabular-nums text-ink">
                        {p.liters_declared.toFixed(1)} L
                      </td>
                      <td className="py-2.5 pr-4 text-right font-mono tabular-nums text-ink-mid">
                        {formatNgn(p.cost_per_liter_ngn)}
                      </td>
                      <td className="py-2.5 pr-4 text-right font-mono tabular-nums text-ink">
                        {formatNgn(p.total_cost_ngn)}
                      </td>
                      <td className="py-2.5 pr-4 text-right font-mono tabular-nums text-ink-mid">
                        {p.distance_km != null ? `${p.distance_km.toFixed(1)} km` : '—'}
                      </td>
                      <td className="py-2.5 pr-4 text-ink-mid">{p.merchant || '—'}</td>
                      <td className="py-2.5 capitalize text-ink-mid">{p.status.replace(/_/g, ' ')}</td>
                    </tr>
                  ))}
                  {data?.purchases.length === 0 && (
                    <tr>
                      <td colSpan={9} className="py-8 text-center text-ink-dim">
                        No purchases logged yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between text-xs text-ink-dim">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="inline-flex items-center gap-1 rounded-lg border border-edge px-2.5 py-1.5 disabled:opacity-40"
                >
                  <ChevronLeft className="h-3.5 w-3.5" /> Prev
                </button>
                <span>
                  Page {page} of {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="inline-flex items-center gap-1 rounded-lg border border-edge px-2.5 py-1.5 disabled:opacity-40"
                >
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-edge bg-panel p-4">
      <p className="text-[11px] uppercase tracking-wider text-ink-dim">{label}</p>
      <p className="mt-1 font-mono text-lg font-bold text-ink">{value}</p>
    </div>
  );
}
