import { initials } from '../lib/format';
import { cx } from '../lib/ui';

interface Props {
  name: string;
  /** Pixel size; 24 for inline table use, 36 beside a headline. */
  size?: 24 | 28 | 36;
  className?: string;
  /** Read the name out for screen readers (default: decorative, the name is written beside it). */
  labelled?: boolean;
}

const SIZES: Record<NonNullable<Props['size']>, string> = {
  24: 'h-6 w-6 text-[10px]',
  28: 'h-7 w-7 text-[11px]',
  36: 'h-9 w-9 text-xs',
};

/** A person's initials in a brand-soft circle, the same mark as the sidebar user chip. */
export function InitialsChip({ name, size = 24, className = '', labelled = false }: Props) {
  return (
    <span
      aria-hidden={labelled ? undefined : 'true'}
      aria-label={labelled ? name : undefined}
      title={name}
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full bg-brand-soft font-semibold text-brand-strong',
        SIZES[size],
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
