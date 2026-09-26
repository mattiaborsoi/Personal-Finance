import { Check, X, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { btnDanger, btnIcon, btnPrimary, btnSecondary, btnSmall, cx } from '../lib/ui';

interface Props {
  /** Label of the initial button (its accessible name when `iconOnly`). */
  children: ReactNode;
  /** Question shown before the action runs. */
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
  tone?: 'primary' | 'danger' | 'secondary';
  small?: boolean;
  disabled?: boolean;
  className?: string;
  /** Icon shown before the label; with `iconOnly` it is the whole 32px button. */
  icon?: LucideIcon;
  /** Render the initial button as a 32px icon button (needs a string label in `children`). */
  iconOnly?: boolean;
}

/**
 * Two-step inline confirmation: the first click reveals "confirm / cancel"
 * instead of a browser dialog, which keeps it keyboard friendly and testable.
 */
export function ConfirmButton({
  children,
  confirmLabel,
  onConfirm,
  tone = 'primary',
  small = false,
  disabled = false,
  className = '',
  icon: Icon,
  iconOnly = false,
}: Props) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const toneClass = tone === 'danger' ? btnDanger : tone === 'secondary' ? btnSecondary : btnPrimary;
  const size = small || iconOnly ? btnSmall : '';
  const label = typeof children === 'string' ? children : undefined;

  async function run() {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      setArmed(false);
    }
  }

  if (!armed) {
    if (iconOnly && Icon) {
      return (
        <button
          type="button"
          className={cx(btnIcon, tone === 'danger' && 'hover:bg-critical/10 hover:text-critical-ink', className)}
          disabled={disabled}
          onClick={() => setArmed(true)}
          aria-label={label}
          title={label}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </button>
      );
    }
    return (
      <button type="button" className={cx(toneClass, size, className)} disabled={disabled} onClick={() => setArmed(true)}>
        {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
        {children}
      </button>
    );
  }

  return (
    <span
      className={cx('inline-flex flex-wrap items-center gap-1.5 animate-rise', className)}
      role="group"
      aria-label={confirmLabel}
    >
      {!iconOnly && <span className="text-xs text-ink-2">{confirmLabel}</span>}
      <button type="button" className={cx(toneClass, size)} disabled={busy} onClick={run} title={confirmLabel}>
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
        {busy ? 'Working…' : 'Confirm'}
      </button>
      {iconOnly ? (
        <button type="button" className={btnIcon} disabled={busy} onClick={() => setArmed(false)} aria-label="Cancel" title="Cancel">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : (
        <button type="button" className={cx(btnSecondary, size)} disabled={busy} onClick={() => setArmed(false)}>
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          Cancel
        </button>
      )}
    </span>
  );
}
