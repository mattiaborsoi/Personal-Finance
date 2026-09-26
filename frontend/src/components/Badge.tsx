import type { ReactNode } from 'react';
import { cx } from '../lib/ui';

export type BadgeTone = 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'violet';

/** Tones map to tokens so they hold up in both themes; the dot carries the colour, the text stays ink. */
const TONES: Record<BadgeTone, { wrap: string; dot: string }> = {
  neutral: { wrap: 'bg-surface-2 text-ink-2 ring-hairline', dot: 'bg-ink-3' },
  blue: { wrap: 'bg-brand/10 text-ink-2 ring-brand/20', dot: 'bg-brand' },
  green: { wrap: 'bg-good/10 text-good-ink ring-good/20', dot: 'bg-good' },
  amber: { wrap: 'bg-warning/15 text-warning-ink ring-warning/30', dot: 'bg-warning' },
  red: { wrap: 'bg-critical/10 text-critical-ink ring-critical/20', dot: 'bg-critical' },
  violet: { wrap: 'bg-accent-micro/10 text-ink-2 ring-accent-micro/25', dot: 'bg-accent-micro' },
};

interface Props {
  tone?: BadgeTone;
  children: ReactNode;
  title?: string;
  className?: string;
  /** Show a small colour dot before the label. */
  dot?: boolean;
}

export function Badge({ tone = 'neutral', children, title, className = '', dot = false }: Props) {
  const t = TONES[tone];
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        t.wrap,
        className,
      )}
    >
      {dot && <span aria-hidden="true" className={cx('h-1.5 w-1.5 rounded-full', t.dot)} />}
      {children}
    </span>
  );
}
