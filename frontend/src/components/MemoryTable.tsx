import { Brain, Trash2 } from 'lucide-react';
import type { MemoryOut } from '../api';
import { useNames } from '../config/ConfigContext';
import { formatDateTime } from '../lib/dates';
import { claimTypeLabel } from '../lib/format';
import { cx, tableBase, tableFlush, tdBase, thBase, trHover } from '../lib/ui';
import { Badge } from './Badge';
import { ConfirmButton } from './ConfirmButton';
import { EmptyState } from './EmptyState';
import { MerchantAvatar } from './MerchantAvatar';

interface Props {
  entries: MemoryOut[];
  errors: Record<string, string>;
  onDelete: (entry: MemoryOut) => Promise<void>;
}

/** Learnt merchant classifications; designed to sit inside `<Card flush>`. */
export function MemoryTable({ entries, errors, onDelete }: Props) {
  const names = useNames();
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={Brain}
        title="Nothing learnt yet"
        hint="Approve a line in the queue and its merchant is remembered here, so the next one is filed the same way."
      />
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className={cx(tableBase, tableFlush)}>
        <thead>
          <tr>
            <th scope="col" className={thBase}>
              Merchant
            </th>
            <th scope="col" className={thBase}>
              Category
            </th>
            <th scope="col" className={thBase}>
              Claim type
            </th>
            <th scope="col" className={cx(thBase, 'text-right')}>
              Reviews
            </th>
            <th scope="col" className={thBase}>
              Updated
            </th>
            <th scope="col" className={thBase}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {entries.map((entry) => {
            const key = String(entry.id);
            return (
              <tr key={key} className={trHover}>
                <td className={tdBase}>
                  <div className="flex items-start gap-3">
                    <MerchantAvatar name={entry.normalized_merchant} />
                    <div className="min-w-0">
                      <p className="font-semibold text-ink">{entry.normalized_merchant}</p>
                      <p translate="no" className="mt-0.5 max-w-xs break-all font-mono text-xs text-ink-3">{entry.raw_pattern}</p>
                      {errors[key] && (
                        <p role="alert" className="mt-1 text-xs text-critical-ink">
                          {errors[key]}
                        </p>
                      )}
                    </div>
                  </div>
                </td>
                <td className={tdBase}>
                  <Badge tone="neutral">{entry.category}</Badge>
                </td>
                <td className={cx(tdBase, 'whitespace-nowrap text-ink-2')}>
                  {claimTypeLabel(entry.default_claim_type, names)}
                </td>
                <td className={cx(tdBase, 'text-right tabular')}>{entry.review_count}</td>
                <td className={cx(tdBase, 'whitespace-nowrap text-ink-3')}>{formatDateTime(entry.last_updated)}</td>
                <td className={cx(tdBase, 'text-right')}>
                  <ConfirmButton
                    confirmLabel="Forget this merchant?"
                    onConfirm={() => onDelete(entry)}
                    tone="danger"
                    icon={Trash2}
                    iconOnly
                    ariaLabel={`Delete ${entry.normalized_merchant}`}
                  >
                    Delete
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
