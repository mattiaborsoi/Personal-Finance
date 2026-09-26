import { stableHash } from '../lib/format';
import { cx } from '../lib/ui';

/** Six soft washes; a merchant always lands on the same one so lists stay scannable. */
const WASHES = [
  'bg-brand/10 text-brand-strong',
  'bg-accent-macro/10 text-accent-macro',
  'bg-accent-micro/10 text-accent-micro',
  'bg-accent-liquidity/10 text-accent-liquidity',
  'bg-good/10 text-good-ink',
  'bg-warning/15 text-warning-ink',
];

function merchantWash(name: string): string {
  return WASHES[stableHash(name.trim().toLowerCase()) % WASHES.length];
}

function firstGlyph(name: string): string {
  const match = /[\p{L}\p{N}]/u.exec(name);
  return match ? match[0].toUpperCase() : '#';
}

interface Props {
  name: string;
  className?: string;
}

/** 32px circle with the merchant's first letter; decorative, the name sits beside it. */
export function MerchantAvatar({ name, className = '' }: Props) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-full text-sm font-semibold',
        merchantWash(name),
        className,
      )}
    >
      {firstGlyph(name)}
    </span>
  );
}
