import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../lib/ui';

export type NoticeTone = 'neutral' | 'good' | 'warning' | 'critical';

/** Wash + ink pairs from the status tokens; the icon carries the meaning alongside the colour. */
const TONES: Record<NoticeTone, { wrap: string; icon: LucideIcon }> = {
  neutral: { wrap: 'bg-surface-2 text-ink-2', icon: Info },
  good: { wrap: 'bg-good/10 text-good-ink', icon: CircleCheck },
  warning: { wrap: 'bg-warning/15 text-warning-ink', icon: TriangleAlert },
  critical: { wrap: 'bg-critical/10 text-critical-ink', icon: CircleAlert },
};

interface Props {
  tone?: NoticeTone;
  children: ReactNode;
  /** Buttons shown after the message (wrap below on narrow screens). */
  actions?: ReactNode;
  icon?: LucideIcon;
  role?: string;
  'aria-label'?: string;
  /** Points at the message (pair with `messageId`), e.g. so an alertdialog reads its text. */
  'aria-describedby'?: string;
  /** id for the message element, so a `role="alertdialog"` can describe itself by it. */
  messageId?: string;
  className?: string;
}

/** One-line inline message: closed-period notes, success confirmations, cautions. */
export function Notice({ tone = 'neutral', children, actions, icon, role, messageId, className = '', ...rest }: Props) {
  const t = TONES[tone];
  const Icon = icon ?? t.icon;
  return (
    <div
      role={role}
      aria-label={rest['aria-label']}
      aria-describedby={rest['aria-describedby']}
      className={cx('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-4 py-3 text-sm', t.wrap, className)}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <div id={messageId} className="min-w-0 flex-1 basis-48">
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
