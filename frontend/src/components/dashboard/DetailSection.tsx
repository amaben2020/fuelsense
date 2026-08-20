'use client';

import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * One independently collapsible detail section.
 *
 * Independent on purpose: the spec these were built to calls for opening
 * "Alert detail" without also rendering the loss breakdown, and a single
 * accordion around all four would mount every section's data to show one.
 * Children are not rendered at all while collapsed, so a section that fetches
 * or computes stays idle until asked for.
 */
export function DetailSection({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  /** One line visible while collapsed — enough to decide whether to open it. */
  summary?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  return (
    <div className="rounded-xl border border-edge bg-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink">{title}</span>
          {summary && (
            <span className="mt-0.5 block text-xs text-ink-dim">{summary}</span>
          )}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-ink-dim transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      {open && (
        <div id={panelId} className="border-t border-edge px-5 py-4">
          {children}
        </div>
      )}
    </div>
  );
}
