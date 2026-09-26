import { Inbox, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../lib/ui';

interface Props {
  title: string;
  /** Short explanation or next step under the title. */
  hint?: ReactNode;
  icon?: LucideIcon;
  /** A button or link shown under the hint. */
  action?: ReactNode;
  /** Legacy hint slot; prefer `hint`. */
  children?: ReactNode;
  className?: string;
}

/** Friendly "nothing here" block: soft icon circle, title, hint and an optional action. */
export function EmptyState({ title, hint, icon: Icon = Inbox, action, children, className = '' }: Props) {
  const body = hint ?? children;
  return (
    <div className={cx('flex flex-col items-center px-6 py-10 text-center', className)}>
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-ink-3" aria-hidden="true">
        <Icon className="h-5 w-5" />
      </span>
      <p className="mt-4 text-sm font-semibold text-ink">{title}</p>
      {body && <div className="mt-1 max-w-sm text-sm text-ink-2">{body}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
