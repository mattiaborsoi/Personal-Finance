import type { ReactNode } from 'react';
import { cx, radioBase } from '../lib/ui';

interface Props<T extends string> {
  id: string;
  /** Shared by every radio in the group. */
  name: string;
  value: T;
  checked: boolean;
  disabled?: boolean;
  label: string;
  /** Describes the choice rather than naming it; read out as the radio's description. */
  hint: ReactNode;
  onChange: (value: T) => void;
}

/** A radio with a bold label and a one-line hint, for a small set of exclusive choices. */
export function RadioOption<T extends string>({ id, name, value, checked, disabled = false, label, hint, onChange }: Props<T>) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        className={cx(radioBase, 'mt-0.5')}
        aria-describedby={`${id}-hint`}
        onChange={() => onChange(value)}
      />
      <div className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-sm font-semibold text-ink">
          {label}
        </label>
        <p id={`${id}-hint`} className="mt-0.5 text-xs text-ink-3">
          {hint}
        </p>
      </div>
    </div>
  );
}
