'use client';

import { RefreshCw, ServerCrash, WifiOff } from 'lucide-react';
import { ApiError, apiErrorMessage } from '@/lib/api';

/**
 * A failed load, stated in one sentence with a way out of it.
 *
 * The icon carries the diagnosis before the sentence is read: a struck-through
 * wifi mark for anything about reaching us, a server mark when we answered and
 * broke. Amber rather than red — the state is recoverable, and colouring every
 * transient blip as destructive teaches people to ignore the colour.
 */
export function LoadErrorBanner({
  error,
  subject,
  onRetry,
  className = '',
}: {
  error: unknown;
  subject?: string;
  onRetry?: () => void;
  className?: string;
}) {
  if (!error) return null;

  const kind = error instanceof ApiError ? error.kind : 'server';
  const Icon = kind === 'server' || kind === 'request' ? ServerCrash : WifiOff;
  const retryable = error instanceof ApiError ? error.retryable : true;

  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center gap-3 rounded-lg border border-warn/40 bg-warn-deep/20 p-4 text-warn ${className}`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1 text-sm">{apiErrorMessage(error, subject)}</p>
      {onRetry && retryable && (
        <button
          type="button"
          onClick={onRetry}
          className="flex items-center gap-1.5 rounded-lg border border-warn/50 px-3 py-1.5 text-sm font-medium text-warn hover:bg-warn/10"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </button>
      )}
    </div>
  );
}
