import { ArrowLeftRight, Ban } from 'lucide-react';
import type { TransferBufferOut } from '../api';
import { useConfig } from '../config/ConfigContext';
import { formatDate } from '../lib/dates';
import { accountLabel } from '../lib/format';
import { checkboxBase, chipSoft, cx, tableBase, tableFlush, tdBase, thBase, trHover } from '../lib/ui';
import { ConfirmButton } from './ConfirmButton';
import { EmptyState } from './EmptyState';
import { MoneyText } from './MoneyText';

interface Props {
  rows: TransferBufferOut[];
  selected: string[];
  busy: Set<string>;
  errors: Record<string, string>;
  onToggle: (id: string) => void;
  /** Ignoring cannot be undone (there is no un-ignore), so it runs only after an inline confirmation. */
  onIgnore: (row: TransferBufferOut) => Promise<void> | void;
}

/** Unmatched transfer legs; designed to sit inside `<Card flush>`. */
export function TransferTable({ rows, selected, busy, errors, onToggle, onIgnore }: Props) {
  const config = useConfig();
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={ArrowLeftRight}
        title="No unmatched transfers"
        hint="Everything is reconciled."
      />
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className={cx(tableBase, tableFlush)}>
        <thead>
          <tr>
            <th scope="col" className={cx(thBase, 'w-10')}>
              <span className="sr-only">Select</span>
            </th>
            <th scope="col" className={thBase}>
              Date
            </th>
            <th scope="col" className={thBase}>
              Account
            </th>
            <th scope="col" className={thBase}>
              Description
            </th>
            <th scope="col" className={cx(thBase, 'text-right')}>
              Amount
            </th>
            <th scope="col" className={thBase}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {rows.map((row) => {
            const isSelected = selected.includes(row.id);
            const isBusy = busy.has(row.id);
            return (
              <tr
                key={row.id}
                className={cx(trHover, isSelected && 'bg-brand-soft/40 hover:bg-brand-soft/50', isBusy && 'opacity-60')}
              >
                <td className={cx(tdBase, 'align-middle')}>
                  <input
                    type="checkbox"
                    className={checkboxBase}
                    checked={isSelected}
                    disabled={isBusy || (!isSelected && selected.length >= 2)}
                    onChange={() => onToggle(row.id)}
                    aria-label={`Select transfer ${row.description ?? row.id} for manual match`}
                  />
                </td>
                <td className={cx(tdBase, 'whitespace-nowrap align-middle text-ink-3')}>
                  {formatDate(row.transaction_date)}
                </td>
                <td className={cx(tdBase, 'align-middle')}>
                  <span className={chipSoft}>{accountLabel(config.accounts, row.account_id)}</span>
                </td>
                <td className={cx(tdBase, 'align-middle')}>
                  <span className="font-medium text-ink">{row.description || '—'}</span>
                  {errors[row.id] && (
                    <p role="alert" className="mt-1 text-xs text-critical-ink">
                      {errors[row.id]}
                    </p>
                  )}
                </td>
                <td className={cx(tdBase, 'whitespace-nowrap text-right align-middle font-semibold')}>
                  <MoneyText value={row.amount} tone />
                </td>
                <td className={cx(tdBase, 'text-right align-middle')}>
                  <ConfirmButton
                    tone="secondary"
                    small
                    icon={Ban}
                    disabled={isBusy}
                    ariaLabel={`Ignore ${row.description || 'transfer'}`}
                    confirmLabel="Ignore this transfer? It won’t come back to this list."
                    onConfirm={() => onIgnore(row)}
                  >
                    Ignore
                  </ConfirmButton>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
