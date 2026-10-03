import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import type { PersonSpend } from '../api';
import { useConfig, useCurrency, useNames } from '../config/ConfigContext';
import { formatMoney } from '../lib/money';
import { cardInset, cx, eyebrow, focusRing } from '../lib/ui';
import type { HeadlineChange, RefundsMode, ViewFigures } from '../lib/views';
import { MoneyText } from './MoneyText';

interface Props {
  figures: ViewFigures;
  hint: string;
  /** Sign and colour the headline (cash flow view). Sub-figures are always plain magnitudes. */
  signed?: boolean;
  /** Accent text class for the small marker beside the label. */
  accentClass?: string;
  /** How the headline moved against the month before, from the trend already loaded. */
  change?: HeadlineChange | null;
  /** Household view: the net-of-refunds / gross switch. */
  refunds?: { mode: RefundsMode; onChange: (mode: RefundsMode) => void };
  /** Household view: what each person paid and bears. */
  people?: PersonSpend[];
}

/** "up £120.00 (12%) on August 2026", or "no change on August 2026". */
export function changeText(change: HeadlineChange, symbol: string): string {
  if (Math.abs(change.delta) < 0.005) return `no change on ${change.previousLabel}`;
  const direction = change.delta > 0 ? 'up' : 'down';
  const pct = change.fraction === null ? '' : ` (${Math.round(Math.abs(change.fraction) * 100)}%)`;
  return `${direction} ${formatMoney(Math.abs(change.delta), symbol)}${pct} on ${change.previousLabel}`;
}

const segment = `rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${focusRing}`;

/** The view's hero figure (one per view, proportional figures), how it moved, and its supporting stat tiles. */
export function MetricsHeadline({ figures, hint, signed = false, accentClass = 'bg-brand', change = null, refunds, people }: Props) {
  const symbol = useCurrency();
  const names = useNames();
  const users = useConfig().users;
  const ChangeIcon = change && change.delta > 0.004 ? ArrowUpRight : change && change.delta < -0.004 ? ArrowDownRight : Minus;
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={cx(eyebrow, 'flex items-center gap-2')}>
          <span aria-hidden="true" className={cx('h-2 w-2 rounded-full', accentClass)} />
          {figures.headlineLabel}
        </p>
        {refunds && (
          <div role="group" aria-label="Refunds" className="inline-flex rounded-lg bg-surface-2 p-0.5">
            {(['net', 'gross'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={refunds.mode === mode}
                className={cx(segment, refunds.mode === mode ? 'bg-surface text-ink shadow-sm' : 'text-ink-3 hover:text-ink')}
                onClick={() => refunds.onChange(mode)}
              >
                {mode === 'net' ? 'Net' : 'Gross'}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="mt-2 text-[2.75rem] font-semibold leading-none tracking-tight text-ink sm:text-5xl">
        {/* The hero figure reads in proportional numerals (DESIGN.md); MoneyText's `.tabular` is for columns. */}
        <MoneyText value={figures.headline} tone={signed} signed={signed} className="!normal-nums" />
      </p>
      {change && (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-ink-2" data-testid="headline-change">
          <ChangeIcon className="h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
          <span className="first-letter:uppercase">{changeText(change, symbol)}</span>
        </p>
      )}
      <p className="mt-3 max-w-xs text-sm text-ink-2">{hint}</p>
      <dl className={cx('mt-5 grid gap-3', figures.subFigures.length > 2 ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2')}>
        {figures.subFigures.map((sub) => (
          <div key={sub.label} className={cardInset}>
            <dt className="text-xs text-ink-3">{sub.label}</dt>
            <dd className="mt-0.5 text-lg font-semibold text-ink">
              <MoneyText value={sub.value} />
            </dd>
            {sub.note && <dd className="mt-0.5 text-xs text-ink-3">{sub.note}</dd>}
            {sub.noteMoney && (
              <dd className="mt-0.5 text-xs text-ink-3">
                {sub.noteMoney.label} <MoneyText value={sub.noteMoney.value} />
              </dd>
            )}
          </div>
        ))}
      </dl>
      {people && people.length > 0 && (
        <dl className="mt-4 space-y-1 text-sm" aria-label="Per person" data-testid="per-person">
          {people.map((person) => {
            const name =
              person.user_id === users.primary.id ? names.primary : person.user_id === users.secondary.id ? names.secondary : person.user_id;
            return (
              <div key={person.user_id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <dt className="font-medium text-ink">{name}</dt>
                <dd className="text-ink-2">
                  paid <MoneyText value={person.paid} className="font-medium text-ink" />, bears{' '}
                  <MoneyText value={person.bears} className="font-medium text-ink" />
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
}
