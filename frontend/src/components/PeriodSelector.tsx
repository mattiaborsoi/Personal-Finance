import { Calendar } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { PeriodOut } from '../api';
import { isPeriodKey, periodLabel } from '../lib/dates';
import { btnSecondary, cx, inputBase, selectBase } from '../lib/ui';

interface Props {
  periods: PeriodOut[];
  value: string | null;
  onChange: (periodKey: string) => void;
  /** Hide the free-text field (e.g. on compact pages). */
  allowCustom?: boolean;
}

/** Compact period control: a dropdown of known periods plus a free-text YYYY-MM field on the same line. */
export function PeriodSelector({ periods, value, onChange, allowCustom = true }: Props) {
  const [custom, setCustom] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  const known = periods.some((p) => p.period_key === value);

  function submitCustom(event: FormEvent) {
    event.preventDefault();
    const trimmed = custom.trim();
    if (!isPeriodKey(trimmed)) {
      setCustomError('Use the format YYYY-MM, e.g. 2026-03.');
      return;
    }
    setCustomError(null);
    onChange(trimmed);
    setCustom('');
  }

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Period">
      <div className="relative">
        <label htmlFor="period-select" className="sr-only">
          Period
        </label>
        <Calendar
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
          aria-hidden="true"
        />
        <select
          id="period-select"
          className={cx(selectBase, 'min-w-[13rem] pl-9 font-medium shadow-card')}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
        >
          {!known && value && <option value={value}>{periodLabel(value)} (not on record)</option>}
          {periods.length === 0 && !value && <option value="">No periods yet</option>}
          {periods.map((p) => (
            <option key={p.period_key} value={p.period_key}>
              {periodLabel(p.period_key)}
              {p.is_closed ? ' · closed' : ''}
              {p.pending_review_count > 0 ? ` · ${p.pending_review_count} to review` : ''}
            </option>
          ))}
        </select>
      </div>
      {allowCustom && (
        <form onSubmit={submitCustom} className="flex flex-wrap items-center gap-2" noValidate>
          <div className="flex items-stretch">
            <label htmlFor="period-custom" className="sr-only">
              Or type a period
            </label>
            <input
              id="period-custom"
              className={cx(inputBase, 'w-40 rounded-r-none shadow-card')}
              name="period"
              autoComplete="off"
              spellCheck={false}
              placeholder="or type 2026-03…"
              inputMode="numeric"
              pattern="\d{4}-\d{2}"
              value={custom}
              aria-invalid={customError ? true : undefined}
              aria-describedby={customError ? 'period-custom-error' : undefined}
              onChange={(e) => {
                setCustom(e.target.value);
                if (customError) setCustomError(null);
              }}
            />
            <button type="submit" className={cx(btnSecondary, '-ml-px rounded-l-none px-3')}>
              Go
            </button>
          </div>
          {customError && (
            <p id="period-custom-error" role="alert" className="basis-full text-xs text-critical-ink">
              {customError}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
