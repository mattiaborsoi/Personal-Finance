import { Calendar } from 'lucide-react';
import type { PeriodOut } from '../api';
import { periodLabel } from '../lib/dates';
import { cx, selectBase } from '../lib/ui';

interface Props {
  periods: PeriodOut[];
  value: string | null;
  onChange: (periodKey: string) => void;
}

/** The period control: a dropdown of the months on record (a month off the list still shows when it is the current one). */
export function PeriodSelector({ periods, value, onChange }: Props) {
  const known = periods.some((p) => p.period_key === value);

  return (
    <div className="relative w-fit" role="group" aria-label="Period">
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
  );
}
