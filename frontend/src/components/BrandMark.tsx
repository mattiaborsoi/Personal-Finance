import { cx } from '../lib/ui';

interface Props {
  className?: string;
  /** Pixel size of the mark. */
  size?: number;
}

/**
 * Two overlapping circles: two people, and the part of their money they share.
 * Uses the view accents so it always sits on-palette in both themes.
 */
export function BrandMark({ className = '', size = 28 }: Props) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={cx('shrink-0', className)}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="16" r="9.5" className="fill-accent-macro" />
      <circle cx="20" cy="16" r="9.5" className="fill-accent-micro" fillOpacity="0.92" />
      <path
        d="M16 8.6a9.5 9.5 0 0 1 0 14.8 9.5 9.5 0 0 1 0-14.8z"
        className="fill-accent-liquidity"
        fillOpacity="0.95"
      />
    </svg>
  );
}

/** The product name, used wherever the wordmark or the page title needs it. */
export const PRODUCT_NAME = 'Settl';
/** Startup-style strapline shown on the login page and in the document metadata. */
export const PRODUCT_SLOGAN = 'Shared money, settled by AI.';

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={cx('flex items-center gap-2.5', className)}>
      <BrandMark />
      <span className="text-[15px] font-semibold tracking-tight text-ink" translate="no">
        {PRODUCT_NAME}
      </span>
    </span>
  );
}
