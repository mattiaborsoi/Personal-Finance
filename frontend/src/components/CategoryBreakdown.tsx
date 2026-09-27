import { useConfig } from '../config/ConfigContext';
import { accountLabel } from '../lib/format';
import { toNumber } from '../lib/money';
import { cx, tableBase, tdBase, thBase } from '../lib/ui';
import type { Breakdown } from '../lib/views';
import { EmptyState } from './EmptyState';
import { MoneyText } from './MoneyText';

interface Props {
  breakdown: Breakdown;
  /** Fill class for the proportional bars (the active view's accent). */
  accentClass?: string;
}

/** Category (or account) list for the active metric view, with a thin proportional bar. */
export function CategoryBreakdown({ breakdown, accentClass = 'bg-brand' }: Props) {
  const config = useConfig();

  if (breakdown.kind === 'account') {
    if (breakdown.rows.length === 0) return <EmptyState title="No account activity this period" />;
    return (
      // Scrolls inside the one-third-width card rather than pushing the money columns past its edge.
      <div className="overflow-x-auto">
        <table className={cx(tableBase, 'tabular')}>
          <thead>
            <tr>
              <th scope="col" className={cx(thBase, 'pl-0')}>
                Account
              </th>
              <th scope="col" className={cx(thBase, 'text-right')}>
                In
              </th>
              <th scope="col" className={cx(thBase, 'text-right')}>
                Out
              </th>
              <th scope="col" className={cx(thBase, 'pr-0 text-right')}>
                Net
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {breakdown.rows.map((row) => (
              <tr key={row.account_id}>
                <td className={cx(tdBase, 'pl-0 text-ink-2')}>{accountLabel(config.accounts, row.account_id)}</td>
                <td className={cx(tdBase, 'whitespace-nowrap text-right')}>
                  <MoneyText value={row.credits} />
                </td>
                <td className={cx(tdBase, 'whitespace-nowrap text-right')}>
                  <MoneyText value={row.debits} />
                </td>
                <td className={cx(tdBase, 'whitespace-nowrap pr-0 text-right font-semibold')}>
                  <MoneyText value={row.net} tone signed />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const rows = [...breakdown.rows].sort((a, b) => Math.abs(toNumber(b.amount)) - Math.abs(toNumber(a.amount)));
  const max = Math.max(...rows.map((r) => Math.abs(toNumber(r.amount))), 0.01);
  // The headline is gross spend; refunds are worth knowing about but are deliberately not netted off it.
  const refunds = Math.abs(toNumber(breakdown.refunds));
  const hasRefunds = Number.isFinite(refunds) && refunds >= 0.005;

  return (
    <>
      {rows.length === 0 ? (
        <EmptyState title="No categorised spend this period" />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const width = Math.max(2, Math.round((Math.abs(toNumber(row.amount)) / max) * 100));
            return (
              <li key={row.category}>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate text-ink">{row.category || 'Uncategorised'}</span>
                  <MoneyText value={row.amount} className="shrink-0 font-semibold" />
                </div>
                {/* Thin bar with a 4px rounded data-end, on a track one step off the surface. */}
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
                  <div className={cx('h-1.5 rounded-r-full', accentClass)} style={{ width: `${width}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {hasRefunds && (
        <p className="mt-4 text-xs text-ink-3" data-testid="refunds-note">
          Refunds received <MoneyText value={refunds} />, not deducted from the headline
        </p>
      )}
    </>
  );
}
