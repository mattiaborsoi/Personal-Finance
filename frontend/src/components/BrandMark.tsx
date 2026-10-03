import { cx } from '../lib/ui';

interface Props {
  className?: string;
  /** Pixel size of the mark. */
  size?: number;
}

/**
 * An S drawn as two hooked halves on a brand-blue tile: two people, each holding
 * one end, meeting in the middle. The tile follows the brand token, so it matches
 * the app's blue in both themes; the halves are fixed white and peach. The
 * favicons in `public/` are rendered from the same drawing with the light-mode blue.
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
      data-testid="brand-mark"
    >
      <rect width="32" height="32" rx="8" className="fill-brand" />
      <path d="M21.2 11a5.2 5.2 0 1 0-5.2 5.2" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
      <path d="M16 15.8a5.2 5.2 0 1 1-5.2 5.2" fill="none" stroke="#ffb088" strokeWidth="4" strokeLinecap="round" />
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
      <span className="text-[17px] font-semibold leading-none tracking-[-0.02em] text-ink" translate="no">
        {PRODUCT_NAME}
      </span>
    </span>
  );
}
