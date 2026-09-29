import { SearchX } from 'lucide-react';
import type { TransactionOut, TransactionPart, TransactionPatch } from '../api';
import { cx, thBase } from '../lib/ui';
import { EmptyState } from './EmptyState';
import { TransactionRow } from './TransactionRow';

interface Props {
  items: TransactionOut[];
  /** Row errors keyed by transaction id, or by part id for the parts of a split. */
  errors: Record<string, string>;
  /** Period keys that are closed; rows in them are shown read-only. */
  closedPeriods?: ReadonlySet<string>;
  onPatch: (tx: TransactionOut, patch: TransactionPatch) => Promise<void>;
  onDelete: (tx: TransactionOut) => Promise<void>;
  onSplit: (tx: TransactionOut) => void;
  onUnsplit: (tx: TransactionOut) => Promise<void>;
  onPatchPart: (tx: TransactionOut, part: TransactionPart, patch: TransactionPatch) => Promise<void>;
}

const NONE: ReadonlySet<string> = new Set();

/*
 * Below `sm` the table is not a table: each row reflows into a stacked card
 * (see TransactionRow), so a phone never scrolls sideways. From `sm` it is the
 * usual flush table, the first and last cells picking up the card's padding.
 */
const tableLayout =
  'block w-full text-sm sm:table sm:min-w-full sm:divide-y sm:divide-hairline sm:[&_td:first-child]:pl-6 sm:[&_th:first-child]:pl-6 sm:[&_td:last-child]:pr-6 sm:[&_th:last-child]:pr-6';

/** The transactions list; designed to sit inside `<Card flush>`. */
export function TransactionTable({
  items,
  errors,
  closedPeriods = NONE,
  onPatch,
  onDelete,
  onSplit,
  onUnsplit,
  onPatchPart,
}: Props) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={SearchX}
        title="No transactions match these filters"
        hint="Try a wider period, another account, or clear the search."
      />
    );
  }
  return (
    <div className="sm:overflow-x-auto">
      <table className={tableLayout}>
        <thead className="hidden sm:table-header-group">
          <tr>
            <th scope="col" className={thBase}>
              Transaction
            </th>
            <th scope="col" className={thBase}>
              Status
            </th>
            <th scope="col" className={cx(thBase, 'text-right')}>
              Amount
            </th>
            <th scope="col" className={thBase}>
              Category
            </th>
            <th scope="col" className={thBase}>
              Claim type
            </th>
            <th scope="col" className={cx(thBase, 'text-center')} title="Internal transfer: money moving between your own accounts">
              Transfer
            </th>
            <th scope="col" className={thBase}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="block divide-y divide-hairline sm:table-row-group">
          {items.map((tx) => (
            <TransactionRow
              key={tx.id}
              transaction={tx}
              error={errors[tx.id]}
              partErrors={errors}
              readOnly={closedPeriods.has(tx.period_key)}
              onPatch={(patch) => onPatch(tx, patch)}
              onDelete={() => onDelete(tx)}
              onSplit={() => onSplit(tx)}
              onUnsplit={() => onUnsplit(tx)}
              onPatchPart={(part, patch) => onPatchPart(tx, part, patch)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
