'use client';

import { useEffect, useState } from 'react';
import { Fuel, History, Undo2 } from 'lucide-react';
import {
  BenchmarkPrice,
  FuelPriceResponse,
  SetFuelPriceResult,
  formatNgn,
  getFuelPrice,
  setFuelPrice,
  undoFuelPrice,
} from '@/lib/api';

// How long the undo offer stays up. Long enough to notice, short enough that
// undoing doesn't feel available forever — matches the backend's own
// UNDO_WINDOW_MS-style reasoning, just tuned for "did I just fat-finger this".
const UNDO_BANNER_MS = 15_000;

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

function HistoryRow({ entry, endedAt }: { entry: BenchmarkPrice; endedAt: string | null }) {
  return (
    <li className="flex items-baseline justify-between gap-3 border-t border-edge/50 py-1.5 text-xs">
      <span className="font-mono text-ink">{formatNgn(entry.ngn_per_liter)}/L</span>
      <span className="text-ink-dim">
        {formatDate(entry.effective_from)}
        {endedAt ? ` – ${formatDate(endedAt)}` : ' – now'}
        {entry.note ? ` · ${entry.note}` : ''}
      </span>
    </li>
  );
}

// Pump prices move often enough that no inferred figure stays right for long,
// so the manager owns this number. Saving never edits an existing period —
// it opens a new one, leaving past spend valued at the price of its own time.
export function FuelPricePanel() {
  const [data, setData] = useState<FuelPriceResponse | null>(null);
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastChange, setLastChange] = useState<SetFuelPriceResult | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  const load = () => {
    getFuelPrice()
      .then(setData)
      .catch(() => setData(null));
  };

  useEffect(load, []);

  // The undo offer expires on its own — a stale "undo" button that silently
  // fails once the backend's own window closes would be worse than none.
  useEffect(() => {
    if (!lastChange) return;
    const timer = setTimeout(() => setLastChange(null), UNDO_BANNER_MS);
    return () => clearTimeout(timer);
  }, [lastChange]);

  const save = async () => {
    const value = Number(price);
    if (!Number.isFinite(value) || value <= 0) {
      setError('Enter a price per litre');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const result = await setFuelPrice({ ngnPerLiter: value, note: note.trim() || undefined });
      setPrice('');
      setNote('');
      setUndoError(null);
      setLastChange(result);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the price');
    } finally {
      setSaving(false);
    }
  };

  const undo = async () => {
    if (!lastChange) return;
    setUndoing(true);
    setUndoError(null);
    try {
      await undoFuelPrice(lastChange.id);
      setLastChange(null);
      load();
    } catch (err) {
      setUndoError(err instanceof Error ? err.message : 'Could not undo this change');
    } finally {
      setUndoing(false);
    }
  };

  const current = data?.current ?? null;
  const receipt = data?.latest_receipt ?? null;

  return (
    <div className="rounded-lg border border-edge bg-panel p-6">
      <div className="flex items-center gap-2">
        <Fuel className="h-4 w-4 text-ink-dim" />
        <h2 className="font-semibold text-ink">Fuel price benchmark</h2>
      </div>
      <p className="mt-1 text-xs text-ink-dim">
        Sets expected cost and cost per km. Changing it applies from today onward, so periods
        already reported keep the price that applied when the fuel was burned.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-edge bg-canvas p-3">
          <p className="text-xs text-ink-dim">Current benchmark</p>
          <p className="mt-1 font-mono text-xl text-ink">
            {current ? `${formatNgn(current.ngn_per_liter)}/L` : 'Not set'}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-dim">
            {current
              ? `In force since ${formatDate(current.effective_from)}`
              : 'Costs fall back to the latest receipt, then to an assumed rate'}
          </p>
        </div>
        <div className="rounded-lg border border-edge bg-canvas p-3">
          <p className="text-xs text-ink-dim">Latest receipt price</p>
          <p className="mt-1 font-mono text-xl text-ink">
            {receipt ? `${formatNgn(receipt.ngn_per_liter)}/L` : '—'}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-dim">
            {receipt
              ? `What a driver actually paid on ${formatDate(receipt.as_of)}`
              : 'No fuel receipt logged yet'}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex-1 min-w-[140px]">
          <span className="text-xs text-ink-dim">New price per litre (₦)</span>
          <input
            type="number"
            inputMode="decimal"
            min={50}
            step={10}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="1300"
            className="mt-1 w-full rounded-md border border-edge bg-canvas px-3 py-2 font-mono text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="flex-[2] min-w-[180px]">
          <span className="text-xs text-ink-dim">Note (optional)</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="NNPC price change"
            className="mt-1 w-full rounded-md border border-edge bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-accent-y-ink disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Set price'}
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-bad">{error}</p>}

      {lastChange && !error && (
        <div
          className={`mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border-l-4 p-3 ${
            lastChange.notable_change
              ? 'border-l-warn bg-warn-deep/15'
              : 'border-l-good bg-good/10'
          }`}
        >
          <div>
            <p className={`text-sm font-semibold ${lastChange.notable_change ? 'text-warn' : 'text-good'}`}>
              Price set to {formatNgn(lastChange.ngn_per_liter)}/L
              {lastChange.previous && (
                <span className="ml-1 font-mono text-xs font-normal text-ink-mid">
                  (was {formatNgn(lastChange.previous.ngn_per_liter)}/L
                  {lastChange.change_fraction != null &&
                    `, ${lastChange.change_fraction >= 0 ? '+' : ''}${Math.round(
                      lastChange.change_fraction * 100
                    )}%`}
                  )
                </span>
              )}
            </p>
            <p className="mt-0.5 text-[11px] text-ink-dim">
              {lastChange.notable_change
                ? "That's a large jump — worth a second look before it flows into cost figures."
                : 'New figures use this price; earlier periods are unchanged.'}
            </p>
            {undoError && <p className="mt-1 text-[11px] text-bad">{undoError}</p>}
          </div>
          <button
            type="button"
            onClick={undo}
            disabled={undoing}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-edge bg-canvas px-3 py-1.5 text-xs font-medium text-ink hover:border-brand disabled:opacity-50"
          >
            <Undo2 className="h-3 w-3" />
            {undoing ? 'Undoing…' : 'Undo'}
          </button>
        </div>
      )}

      {data && data.history.length > 0 && (
        <div className="mt-5">
          <p className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-ink-dim">
            <History className="h-3 w-3" />
            Price history
          </p>
          <ul className="mt-2">
            {data.history.map((entry, i) => (
              <HistoryRow
                key={`${entry.effective_from}-${i}`}
                entry={entry}
                // History is newest first, so the previous item is what
                // replaced this price.
                endedAt={i > 0 ? data.history[i - 1].effective_from : null}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
