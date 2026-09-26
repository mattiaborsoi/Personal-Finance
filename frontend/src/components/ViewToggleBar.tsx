import { VIEWS, type MetricView } from '../lib/views';
import { cx, focusRing } from '../lib/ui';

interface Props {
  view: MetricView;
  onChange: (view: MetricView) => void;
}

/** Global Macro / Micro / Liquidity switch for the dashboard: a segmented control with the view's accent. */
export function ViewToggleBar({ view, onChange }: Props) {
  return (
    <div
      role="group"
      aria-label="Metric view"
      className="inline-flex w-full flex-col gap-1 rounded-xl border border-hairline bg-surface p-1 shadow-card sm:w-auto sm:flex-row"
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
              'flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors',
              focusRing,
              active ? 'bg-surface-3 text-ink shadow-sm' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
            )}
          >
            <span aria-hidden="true" className={cx('h-2 w-2 rounded-full', v.accent.bg, !active && 'opacity-60')} />
            <span className="whitespace-nowrap">
              <span className="hidden lg:inline">{v.label}</span>
              <span className="lg:hidden">{v.short}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
