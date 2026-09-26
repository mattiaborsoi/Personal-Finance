import { LoaderCircle } from 'lucide-react';
import { cx } from '../lib/ui';

interface Props {
  label?: string;
  fullPage?: boolean;
  /** Compact inline spinner (e.g. next to a heading while data refreshes). */
  inline?: boolean;
  /** Render a skeleton of this many rows instead of a spinner (holds the space, no layout jump). */
  rows?: number;
  className?: string;
}

export function LoadingState({ label = 'Loading', fullPage = false, inline = false, rows, className = '' }: Props) {
  if (inline) {
    return (
      <span role="status" className={cx('inline-flex items-center gap-1.5 text-xs text-ink-3', className)}>
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        <span>{label}&hellip;</span>
      </span>
    );
  }
  if (rows) {
    return (
      <div role="status" aria-label={`${label}…`} className={cx('space-y-3 py-1', className)}>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <span className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-surface-2" />
            <span className="h-3 flex-1 animate-pulse rounded bg-surface-2" style={{ maxWidth: `${62 - (i % 3) * 12}%` }} />
            <span className="h-3 w-16 animate-pulse rounded bg-surface-2" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div
      role="status"
      className={cx(
        'flex items-center justify-center gap-2.5 text-sm text-ink-3',
        fullPage ? 'min-h-screen' : 'min-h-[7rem] py-6',
        className,
      )}
    >
      <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
      <span>{label}&hellip;</span>
    </div>
  );
}
