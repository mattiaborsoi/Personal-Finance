import type { ReactNode } from 'react';
import { cx, fieldNoteId, labelBase } from '../lib/ui';

interface Props {
  id: string;
  label: string;
  /** Helper text under the control. */
  help?: ReactNode;
  /** Replaces the help text while the value cannot be sent: a range problem, or the server's own words. */
  problem?: string;
  /** The current value, shown beside the label. */
  readout?: string;
  /** Shown beside the label, e.g. a badge. */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** Label over a control, with helper text that gives way to the field's problem; `fieldNoteId(id)` names the note. */
export function Field({ id, label, help, problem, readout, aside, className, children }: Props) {
  const note = problem ?? help;
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className={labelBase}>
          {label}
        </label>
        {readout && <span className="text-sm font-semibold tabular text-ink">{readout}</span>}
        {aside}
      </div>
      <div className="mt-1.5">{children}</div>
      {note !== undefined && note !== null && note !== '' && (
        <p id={fieldNoteId(id)} className={cx('mt-1.5 text-xs', problem ? 'text-critical-ink' : 'text-ink-3')}>
          {note}
        </p>
      )}
    </div>
  );
}
