'use client';

export function ViewModeToggle({
  mode,
  onChange,
}: {
  mode: 'list' | 'calendar';
  onChange: (mode: 'list' | 'calendar') => void;
}) {
  return (
    <div className="flex gap-2">
      {(['list', 'calendar'] as const).map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`rounded-full border px-3 py-1 text-xs capitalize ${
            mode === id
              ? 'border-good bg-good/10 text-good'
              : 'border-edge bg-canvas text-ink-mid hover:bg-panel-hover'
          }`}
        >
          {id}
        </button>
      ))}
    </div>
  );
}
