import { Brain, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { MemoryOut } from '../api';
import { useConfig } from '../config/ConfigContext';
import { categoryEmojiLabel } from '../lib/categories';
import { formatDateTime } from '../lib/dates';
import { plural } from '../lib/format';
import { cx, linkBase, tableBase, tableFlush, tdBase, thBase, trHover } from '../lib/ui';
import { Badge } from './Badge';
import { ConfirmButton } from './ConfirmButton';
import { EmptyState } from './EmptyState';
import { MerchantAvatar } from './MerchantAvatar';
import { MoneyText } from './MoneyText';

/** The Transactions page searching for this merchant, over every period. */
function merchantTransactionsHref(merchant: string): string {
  return `/transactions?q=${encodeURIComponent(merchant)}`;
}

/** The delete question: what is forgotten and what stays. */
function forgetQuestion(merchant: string): string {
  return `Forget ${merchant}? Its transactions stay as they are; the next ${merchant} line gets a fresh suggestion.`;
}

interface Props {
  entries: MemoryOut[];
  errors: Record<string, string>;
  onDelete: (entry: MemoryOut) => Promise<void>;
}

/** Learnt merchant classifications; designed to sit inside `<Card flush>`. */
export function MemoryTable({ entries, errors, onDelete }: Props) {
  const emojis = useConfig().category_emojis;
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
            <th scope="col" className={cx(thBase, 'text-right')}>
              Total spent
            </th>
            <th scope="col" className={cx(thBase, 'text-right')}>
              Reviews
            </th>
            <th scope="col" className={cx(thBase, 'hidden md:table-cell')}>
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
            const merchant = entry.normalized_merchant;
            const lines = entry.transaction_count ?? 0;
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
                  <Badge tone="neutral">{categoryEmojiLabel(entry.category, emojis)}</Badge>
                </td>
                <td className={cx(tdBase, 'whitespace-nowrap text-right')}>
                  <MoneyText value={entry.total_spent ?? '0.00'} />
                  <p className="mt-0.5 text-xs text-ink-3">{plural(lines, 'line')}</p>
                </td>
                <td className={cx(tdBase, 'text-right tabular')}>
                  <Link
                    to={merchantTransactionsHref(merchant)}
                    className={linkBase}
                    aria-label={`${plural(entry.review_count, 'review')}: show ${merchant}'s transactions`}
                    title={`Show ${merchant}'s transactions`}
                  >
                    {entry.review_count}
                  </Link>
                </td>
                <td className={cx(tdBase, 'hidden whitespace-nowrap text-ink-3 md:table-cell')}>
                  {formatDateTime(entry.last_updated)}
                </td>
                <td className={cx(tdBase, 'text-right')}>
                  <ConfirmButton
                    confirmLabel={forgetQuestion(merchant)}
                    onConfirm={() => onDelete(entry)}
                    tone="danger"
                    icon={Trash2}
                    iconOnly
                    showQuestion
                    className="max-w-[13rem] justify-end text-left"
                    ariaLabel={`Delete ${merchant}`}
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
