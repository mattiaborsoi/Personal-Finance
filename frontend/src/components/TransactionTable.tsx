import { ArrowDown, ArrowUp, SearchX } from 'lucide-react';
import type { TransactionOut, TransactionPart, TransactionPatch, TransactionSort } from '../api';
import { cx, focusRing, thBase } from '../lib/ui';
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
  onApprove?: (tx: TransactionOut) => Promise<void>;
  /** The current order; with `onSort` the Transaction and Amount headings sort the list. */
  sort?: { by: TransactionSort; order: 'asc' | 'desc' };
  onSort?: (by: TransactionSort) => void;
}

/** A column heading that sorts: a button inside the th, with aria-sort on the th. */
function SortHeading({
  label,
  by,
  sort,
  onSort,
  align = 'left',
}: {
  label: string;
  by: TransactionSort;
  sort?: Props['sort'];
  onSort?: Props['onSort'];
  align?: 'left' | 'right';
}) {
  const active = sort?.by === by;
  const ariaSort = active ? (sort?.order === 'asc' ? 'ascending' : 'descending') : 'none';
  const Arrow = sort?.order === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th scope="col" className={cx(thBase, align === 'right' && 'text-right')} aria-sort={onSort ? ariaSort : undefined}>
      {onSort ? (
        <button
          type="button"
          onClick={() => onSort(by)}
          className={cx(
            'inline-flex items-center gap-1 rounded uppercase hover:text-ink',
            active && 'text-ink',
            focusRing,
          )}
          title={`Sort by ${label.toLowerCase()}`}
        >
          {label}
          {active && <Arrow className="h-3 w-3" aria-hidden="true" />}
        </button>
      ) : (
        label
      )}
    </th>
  );
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
  onApprove,
  sort,
  onSort,
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
            <SortHeading label="Transaction" by="merchant" sort={sort} onSort={onSort} />
            <th scope="col" className={thBase}>
              Status
            </th>
            <SortHeading label="Amount" by="amount" sort={sort} onSort={onSort} align="right" />
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
              onApprove={onApprove ? () => onApprove(tx) : undefined}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
