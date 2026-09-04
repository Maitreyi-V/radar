/**
 * Attention-budget control.
 *
 * Exposes the one number that decides what reaches the user. Most products bury this or
 * omit it; putting it on screen makes the product's judgment inspectable and lets the
 * user set their own tolerance rather than inheriting ours.
 *
 * Lower threshold = more surfaces. The labels are in plain language because "1.5" means
 * nothing to a user, while "only the big stuff" does.
 */
const LEVELS = [
  { value: 0.8, label: 'Everything', hint: 'surface almost any signal' },
  { value: 1.5, label: 'Balanced', hint: 'the default — genuine events only' },
  { value: 2.5, label: 'Only the big stuff', hint: 'rare, high-conviction moves' },
];

export function SensitivityControl({ value, onChange, disabled }: {
  value: number; onChange: (v: number) => void; disabled?: boolean;
}) {
  const active = LEVELS.reduce((best, l) =>
    Math.abs(l.value - value) < Math.abs(best.value - value) ? l : best, LEVELS[1]!);

  return (
    <div className="flex items-center gap-2.5">
      <span className="text-xs text-slate-500 shrink-0">Show me</span>
      <div className="flex bg-ink-900 border border-ink-700 rounded-lg p-0.5">
        {LEVELS.map((l) => (
          <button
            key={l.value}
            disabled={disabled}
            onClick={() => onChange(l.value)}
            title={l.hint}
            className={`px-2.5 py-1 rounded-md text-xs transition-colors whitespace-nowrap ${
              active.value === l.value ? 'bg-ink-700 text-slate-100' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>
      <span className="text-[11px] text-slate-600 num hidden lg:inline">threshold {active.value}</span>
    </div>
  );
}
