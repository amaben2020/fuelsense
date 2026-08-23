'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import {
  NotificationAlert,
  fetchNotificationSettings,
  setNotificationPreference,
} from '@/lib/api';
import { Panel } from '@/components/ui/chrome';
import { LoadErrorBanner } from './LoadErrorBanner';

/** "120" is not a unit a person thinks in. */
function waitLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = minutes / 60;
  return h === 1 ? '1 hour' : `${h} hours`;
}

/**
 * Where a manager turns the emails off.
 *
 * The offline-tracker email told them to go to "Settings → Notifications",
 * which did not exist — the only toggles in the product were on the
 * Documentation page, a screen nobody visits to change a setting. So the email
 * gave one instruction and it was a dead end. This is that screen.
 */
export function NotificationSettingsPanel() {
  const [alerts, setAlerts] = useState<NotificationAlert[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  /** Which row is mid-save, so a double-click cannot race itself. */
  const [saving, setSaving] = useState<string | null>(null);

  const runFetch = useCallback(() => {
    fetchNotificationSettings()
      .then((d) => {
        setAlerts(d.alerts.filter((a) => a.emailable));
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

  const save = async (
    alert: NotificationAlert,
    emailEnabled: boolean,
    thresholdMinutes?: number | null
  ) => {
    setSaving(alert.type);
    // Optimistic, reverted by the refetch below if the server disagrees.
    setAlerts((prev) =>
      prev
        ? prev.map((a) =>
            a.type === alert.type
              ? {
                  ...a,
                  email_enabled: emailEnabled,
                  threshold_minutes:
                    thresholdMinutes === undefined ? a.threshold_minutes : thresholdMinutes,
                }
              : a
          )
        : prev
    );
    try {
      await setNotificationPreference(alert.type, emailEnabled, thresholdMinutes);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(null);
      runFetch();
    }
  };

  if (error) {
    return <LoadErrorBanner error={error} subject="notification settings" onRetry={load} />;
  }

  const onCount = alerts?.filter((a) => a.email_enabled).length ?? 0;

  return (
    <Panel
      icon={Bell}
      title="Notifications"
      subtitle={
        alerts == null
          ? 'Which alerts reach your inbox'
          : `${onCount} of ${alerts.length} alerts are emailed to you`
      }
      onRefresh={load}
      refreshing={loading}
    >
      {alerts == null ? (
        <p className="rounded-xl bg-panel-deep px-4 py-6 text-center text-sm text-ink-dim">
          Loading notification settings…
        </p>
      ) : (
        <ul className="divide-y divide-divider">
          {alerts.map((a) => {
            const busy = saving === a.type;
            return (
              <li key={a.type} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink">{a.label}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-ink-dim">{a.meaning}</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={a.email_enabled}
                    disabled={busy}
                    onClick={() => save(a, !a.email_enabled)}
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50 ${
                      a.email_enabled
                        ? 'border-brand bg-brand/10 text-brand'
                        : 'border-edge text-ink-dim hover:text-ink'
                    }`}
                  >
                    {a.email_enabled ? (
                      <Bell className="h-3 w-3" />
                    ) : (
                      <BellOff className="h-3 w-3" />
                    )}
                    Email {a.email_enabled ? 'on' : 'off'}
                  </button>
                </div>

                {/* Only some alerts wait before firing. For those, how long is
                    the difference between a useful warning and a phone that
                    buzzes every time a van parks underground. */}
                {a.threshold_choices && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-xl bg-panel-deep px-3 py-2.5">
                    <span className="text-xs text-ink-dim">Tell me after it has been quiet for</span>
                    <select
                      value={String(a.threshold_minutes ?? a.threshold_default ?? '')}
                      disabled={busy}
                      onChange={(e) => save(a, a.email_enabled, Number(e.target.value))}
                      className="rounded-lg border border-edge bg-panel px-2 py-1 text-sm text-ink disabled:opacity-50"
                    >
                      {a.threshold_choices.map((m) => (
                        <option key={m} value={m}>
                          {waitLabel(m)}
                          {m === a.threshold_default ? ' (default)' : ''}
                        </option>
                      ))}
                    </select>
                    {!a.email_enabled && (
                      <span className="text-[11px] text-ink-dim">
                        Email is off, but this still decides when the alert appears on the
                        dashboard.
                      </span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-ink-dim">
        Emails go to your account address. Nothing is on by default — every alert here was
        switched on deliberately, and switching it off stops the mail immediately.
      </p>
    </Panel>
  );
}
