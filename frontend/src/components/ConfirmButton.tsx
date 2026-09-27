import { Check, X, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { btnDanger, btnIcon, btnPrimary, btnSecondary, btnSmall, cx } from '../lib/ui';

type Tone = 'primary' | 'danger' | 'secondary';

function toneClass(tone: Tone): string {
  return tone === 'danger' ? btnDanger : tone === 'secondary' ? btnSecondary : btnPrimary;
}

interface PromptProps {
  /** The question, e.g. "Delete this transaction?"; also the group's accessible name. */
  label: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** The action is running: both buttons lock and Confirm reads "Working…". */
  busy?: boolean;
  tone?: Tone;
  small?: boolean;
  /** Icon-button layout: no visible question, an X for Cancel. */
  iconOnly?: boolean;
  className?: string;
}

/**
 * The "question · Confirm · Cancel" step on its own, for a form whose first
 * step is its own submit button (`ConfirmButton` uses it after the first click).
 */
export function ConfirmPrompt({
  label,
  onConfirm,
  onCancel,
  busy = false,
  tone = 'primary',
  small = false,
  iconOnly = false,
  className = '',
}: PromptProps) {
  const size = small || iconOnly ? btnSmall : '';
  return (
    <span
      className={cx('inline-flex flex-wrap items-center gap-1.5 animate-rise', className)}
      role="group"
      aria-label={label}
    >
      {!iconOnly && <span className="text-xs text-ink-2">{label}</span>}
      <button type="button" className={cx(toneClass(tone), size)} disabled={busy} onClick={onConfirm} title={label}>
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
        {busy ? 'Working…' : 'Confirm'}
      </button>
      {iconOnly ? (
        <button type="button" className={btnIcon} disabled={busy} onClick={onCancel} aria-label="Cancel" title="Cancel">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : (
        <button type="button" className={cx(btnSecondary, size)} disabled={busy} onClick={onCancel}>
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          Cancel
        </button>
      )}
    </span>
  );
}

interface Props {
  /** Label of the initial button (its accessible name when `iconOnly`, unless `ariaLabel` is set). */
  children: ReactNode;
  /** Question shown before the action runs. */
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
  tone?: Tone;
  small?: boolean;
  disabled?: boolean;
  className?: string;
  /** Icon shown before the label; with `iconOnly` it is the whole 32px button. */
  icon?: LucideIcon;
  /** Render the initial button as a 32px icon button (needs a string label in `children`). */
  iconOnly?: boolean;
  /** Tooltip on the initial button, e.g. why it is disabled; defaults to the label when `iconOnly`. */
  title?: string;
  /** Accessible name for the initial button when the visible label is too short on its own ("Delete Waitrose"). */
  ariaLabel?: string;
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
  title,
  ariaLabel,
}: Props) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
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
          aria-label={ariaLabel ?? label}
          title={title ?? label}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </button>
      );
    }
    return (
      <button
        type="button"
        className={cx(toneClass(tone), size, className)}
        disabled={disabled}
        onClick={() => setArmed(true)}
        title={title}
        aria-label={ariaLabel}
      >
        {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
        {children}
      </button>
    );
  }

  return (
    <ConfirmPrompt
      label={confirmLabel}
      onConfirm={run}
      onCancel={() => setArmed(false)}
      busy={busy}
      tone={tone}
      small={small}
      iconOnly={iconOnly}
      className={className}
    />
  );
}
