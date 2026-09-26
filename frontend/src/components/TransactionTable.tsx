import { ArrowLeftRight, SearchX } from 'lucide-react';
import type { TransactionOut, TransactionPart, TransactionPatch } from '../api';
import { cx, tableBase, tableFlush, thBase } from '../lib/ui';
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
    <div className="overflow-x-auto">
      <table className={cx(tableBase, tableFlush)}>
        <thead>
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
            <th scope="col" className={cx(thBase, 'text-center')} title="Internal transfer">
              <ArrowLeftRight className="mx-auto h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">Transfer</span>
            </th>
            <th scope="col" className={thBase}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
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
