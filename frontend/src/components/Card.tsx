import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cardBase, cx } from '../lib/ui';

interface Props {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Sets the landmark label for screen readers. */
  as?: 'section' | 'div';
  /** Optional accent stripe colour class (e.g. `bg-accent-macro`) shown at the top of the card. */
  accentClass?: string;
  /** Remove the inner padding (for edge-to-edge tables). */
  flush?: boolean;
  /** Optional Lucide icon shown in a soft square before the title. */
  icon?: LucideIcon;
}

export function Card({
  title,
  description,
  actions,
  children,
  className = '',
  as = 'section',
  accentClass,
  flush = false,
  icon: Icon,
}: Props) {
  const Tag = as;
  return (
    <Tag className={cx(cardBase, 'relative overflow-hidden', flush && 'p-0 sm:p-0', className)} aria-label={title}>
      {accentClass && <span aria-hidden="true" className={cx('absolute inset-x-0 top-0 h-1', accentClass)} />}
      {(title || actions) && (
        <header
          className={cx(
            'mb-4 flex flex-wrap items-start justify-between gap-3',
            flush && 'mb-0 border-b border-hairline px-5 py-4 sm:px-6',
          )}
        >
          <div className="flex min-w-0 items-center gap-3">
            {Icon && (
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-2"
              >
                <Icon className="h-4 w-4" />
              </span>
            )}
            <div className="min-w-0">
              {title && <h2 className="text-balance text-base font-semibold tracking-tight text-ink">{title}</h2>}
              {description && <p className="mt-0.5 text-xs text-ink-3">{description}</p>}
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </Tag>
  );
}
