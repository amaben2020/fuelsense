'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BellOff, CheckCircle2, Info, Send, ShieldAlert } from 'lucide-react';
import {
  DriverAlert,
  DriverAlertsResponse,
  explainDriverAlert,
  fetchDriverAlerts,
} from '@/lib/driver-api';
import { useLatest } from '@/lib/use-latest';

const SEVERITY_ICON = {
  critical: ShieldAlert,
  warning: AlertTriangle,
  info: Info,
} as const;

const SEVERITY_STYLE = {
  critical: 'bg-bad/15 text-bad',
  warning: 'bg-warn/15 text-warn',
  info: 'bg-good/15 text-good',
} as const;

function when(iso: string) {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString('en-NG', {
    timeZone: 'Africa/Lagos',
    day: '2-digit',
    month: 'short',
  });
}

/**
 * What the fleet has flagged, and the driver's chance to answer it.
 *
 * Alerts were manager-only, so a driver could be carrying an unexplained
 * "left the depot zone at 19:40" for a week without knowing it existed. Here
 * they see it and can say why — which for everyday alerts closes the matter
 * before anyone has to ask.
 */
export function DriverAlertsScreen({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const [data, setData] = useState<DriverAlertsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  // Held in a ref so `load` keeps a stable identity. Depending on the callback
  // directly would re-run the fetch on every render for any parent that passes
  // an inline function.
  const notify = useLatest(onCountChange);

  const load = useCallback(async () => {
    try {
      const d = await fetchDriverAlerts();
      setData(d);
      setError(null);
      notify.current?.(d.unanswered);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (alert: DriverAlert) => {
    const text = note.trim();
    if (!text) return;
    setSending(true);
    try {
      const res = await explainDriverAlert(alert.id, text);
      setFlash(res.message);
      setOpenId(null);
      setNote('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  if (error) {
    return (
      <div className="rounded-2xl border border-bad/40 bg-bad/10 p-4 text-sm text-bad">
        {error}
        <button
          type="button"
          onClick={load}
          className="mt-3 block w-full rounded-xl border border-bad/40 py-2.5 text-sm font-semibold"
        >
          Try again
        </button>
      </div>
    );
  }

  const alerts = data?.alerts ?? [];

  return (
    <div className="space-y-3">
      {flash && (
        <p className="rounded-xl border border-good/40 bg-good/10 px-3 py-2.5 text-sm text-good">
          {flash}
        </p>
      )}

      {data == null ? (
        <p className="py-10 text-center text-sm text-ink-dim">Loading…</p>
      ) : alerts.length === 0 ? (
        <div className="rounded-2xl border border-edge bg-panel px-4 py-10 text-center">
          <BellOff className="mx-auto mb-2 h-6 w-6 text-ink-dim" />
          <p className="text-sm text-ink-mid">Nothing flagged</p>
          <p className="mt-1 text-xs text-ink-dim">
            Nothing on your vehicle has needed an explanation in the last{' '}
            {data.period_days} days.
          </p>
        </div>
      ) : (
        alerts.map((a) => {
          const Icon = SEVERITY_ICON[a.severity] ?? Info;
          const isOpen = openId === a.id;
          return (
            <div key={a.id} className="rounded-2xl border border-edge bg-panel p-4">
              <div className="flex items-start gap-3">
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                    SEVERITY_STYLE[a.severity] ?? SEVERITY_STYLE.info
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <p className="font-semibold text-ink">{a.label}</p>
                    <span className="shrink-0 text-[11px] text-ink-dim">
                      {when(a.created_at)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-ink-mid">{a.message}</p>
                </div>
              </div>

              {a.driver_note && (
                <div className="mt-3 rounded-xl bg-canvas px-3 py-2.5">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold text-good">
                    <CheckCircle2 className="h-3 w-3" /> You answered this
                  </p>
                  <p className="mt-1 text-sm text-ink-mid">{a.driver_note}</p>
                </div>
              )}

              {a.can_explain &&
                (isOpen ? (
                  <div className="mt-3">
                    <textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      maxLength={500}
                      rows={3}
                      autoFocus
                      placeholder="What happened? The customer moved the pickup, traffic held me at the gate…"
                      className="w-full resize-none rounded-xl border border-edge bg-canvas px-3 py-2.5 text-base text-ink placeholder-ink-dim"
                    />
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        disabled={sending || !note.trim()}
                        onClick={() => send(a)}
                        className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand py-3 text-sm font-semibold text-canvas disabled:opacity-40"
                      >
                        <Send className="h-4 w-4" />
                        {sending ? 'Sending…' : 'Send to manager'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenId(null);
                          setNote('');
                        }}
                        className="rounded-xl border border-edge px-4 py-3 text-sm font-medium text-ink-mid"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setOpenId(a.id);
                      setNote('');
                      setFlash(null);
                    }}
                    className="mt-3 w-full rounded-xl border border-accent/40 bg-accent/10 py-3 text-sm font-semibold text-brand"
                  >
                    Explain what happened
                  </button>
                ))}
            </div>
          );
        })
      )}
    </div>
  );
}
