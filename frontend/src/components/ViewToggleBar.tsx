import { VIEWS, type MetricView } from '../lib/views';
import { cx, focusRing } from '../lib/ui';

interface Props {
  view: MetricView;
  onChange: (view: MetricView) => void;
}

/** Household / My share / Cash flow switch for the dashboard: one compact segmented row, the dots carry the identity. */
export function ViewToggleBar({ view, onChange }: Props) {
  return (
    <div
      role="group"
      aria-label="Metric view"
      className="inline-flex w-full rounded-xl border border-hairline bg-surface p-1 shadow-card sm:w-auto"
    >
      {VIEWS.map((v) => {
        const active = v.id === view;
        return (
          <button
            key={v.id}
            type="button"
            aria-pressed={active}
            title={v.hint}
            onClick={() => onChange(v.id)}
            className={cx(
              'flex flex-1 items-center justify-center gap-2 rounded-lg px-2 py-2 text-sm font-medium transition-colors sm:flex-initial sm:px-3.5',
              focusRing,
              active ? 'bg-surface-3 text-ink shadow-sm' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
            )}
          >
            <span aria-hidden="true" className={cx('h-2 w-2 shrink-0 rounded-full', v.accent.bg, !active && 'opacity-60')} />
            <span className="whitespace-nowrap">{v.short}</span>
          </button>
        );
      })}
    </div>
  );
}
