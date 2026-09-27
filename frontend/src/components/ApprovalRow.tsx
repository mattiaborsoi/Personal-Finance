import { Check, CircleAlert, Scissors } from 'lucide-react';
import { useState } from 'react';
import { UNCATEGORIZED, type ClaimType, type TransactionOut, type TransactionPatch } from '../api';
import { useConfig, useNames } from '../config/ConfigContext';
import { formatDate } from '../lib/dates';
import { accountLabel, categoryLabel, categoryOptions, claimTypeLabel } from '../lib/format';
import {
  btnIcon,
  btnPrimary,
  btnSmall,
  checkboxBase,
  chipSoft,
  cx,
  focusRing,
  selectCategory,
  selectCompact,
  trHover,
} from '../lib/ui';
import { MerchantAvatar } from './MerchantAvatar';
import { MoneyText } from './MoneyText';
import { SourceBadge } from './SourceBadge';
import { TransferToggle } from './TransferToggle';

/**
 * The user's unsaved dropdown choices for one row. Held by the queue, not the
 * row, so they survive the row being removed and restored around a failed approve.
 */
export type ApprovalDraft = Pick<TransactionPatch, 'category' | 'claim_type'>;

/** How many cells a row spans, for the error row beneath it. */
export const APPROVAL_COLUMNS = 8;

interface Props {
  transaction: TransactionOut;
  draft: ApprovalDraft;
  onDraftChange: (draft: ApprovalDraft) => void;
  selected: boolean;
  busy: boolean;
  /** The period is closed: nothing here may be approved. */
  disabled?: boolean;
  error?: string;
  onToggle: () => void;
  onApprove: (corrections: TransactionPatch) => void;
  /** Opens the split dialog; splitting approves the transaction as well. */
  onSplit: () => void;
  /** Marks (or unmarks) the line as a transfer; it stays in the queue until approved. */
  onTransferChange: (isInternalTransfer: boolean) => void;
}

export function ApprovalRow({
  transaction: tx,
  draft,
  onDraftChange,
  selected,
  busy,
  disabled = false,
  error,
  onToggle,
  onApprove,
  onSplit,
  onTransferChange,
}: Props) {
  const config = useConfig();
  const names = useNames();
  const [showRaw, setShowRaw] = useState(false);

  const originalCategory = tx.category || UNCATEGORIZED;
  const category = draft.category ?? originalCategory;
  const claimType: ClaimType | '' = draft.claim_type ?? tx.claim_type ?? '';
  const categories = categoryOptions(config.categories, category);

  function approve() {
    const corrections: TransactionPatch = {};
    if (category !== originalCategory) corrections.category = category;
    if (claimType && claimType !== tx.claim_type) corrections.claim_type = claimType;
    onApprove(corrections);
  }

  const id = tx.id;
  const merchant = tx.cleaned_merchant || tx.raw_description;
  const hasRawLine = Boolean(tx.raw_description) && tx.raw_description !== merchant;
  const locked = busy || disabled;
  const closedTitle = disabled ? 'This period is closed' : undefined;

  return (
    <>
      <tr className={cx(trHover, selected && 'bg-brand-soft/30 hover:bg-brand-soft/40', busy && 'opacity-60')}>
        <td className="w-10 px-3 py-3 align-middle">
          {/* The label turns the cell's padding into a 40px hit area for the 16px box. */}
          <label className={cx('-m-3 inline-flex p-3 align-middle', locked ? 'cursor-not-allowed' : 'cursor-pointer')}>
            <input
              type="checkbox"
              className={checkboxBase}
              checked={selected}
              onChange={onToggle}
              aria-label={`Select ${merchant}`}
              disabled={locked}
            />
          </label>
        </td>
        <td className="w-full min-w-[15rem] max-w-0 px-2 py-3 align-middle">
          <div className="flex items-start gap-3">
            <MerchantAvatar name={merchant} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <button
                  type="button"
                  className={cx('min-w-0 max-w-[18rem] truncate rounded text-left font-semibold text-ink hover:underline', focusRing)}
                  title={tx.raw_description}
                  aria-expanded={showRaw}
                  onClick={() => setShowRaw((s) => !s)}
                >
                  {merchant}
                </button>
                <span className="shrink-0 text-xs text-ink-3 tabular">{formatDate(tx.transaction_date)}</span>
              </div>
              {hasRawLine && (
                <p className={cx('mt-0.5 max-w-[18rem] font-mono text-xs text-ink-3', showRaw ? 'break-all' : 'truncate')}>
                  {tx.raw_description}
                </p>
              )}
              <p className="mt-1 text-xs text-ink-3">
                <span className={chipSoft}>{accountLabel(config.accounts, tx.account_id)}</span>
              </p>
            </div>
          </div>
        </td>
        <td className="whitespace-nowrap px-2 py-3 text-right align-middle font-semibold tabular">
          <MoneyText value={tx.amount} tone />
        </td>
        <td className="px-2 py-3 align-middle">
          <label htmlFor={`category-${id}`} className="sr-only">
            Category for {merchant}
          </label>
          <select
            id={`category-${id}`}
            className={cx(selectCompact, selectCategory)}
            value={category}
            title={categoryLabel(category)}
            onChange={(e) => onDraftChange({ ...draft, category: e.target.value })}
            disabled={locked}
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
        </td>
        <td className="px-2 py-3 align-middle">
          <label htmlFor={`claim-${id}`} className="sr-only">
            Claim type for {merchant}
          </label>
          <select
            id={`claim-${id}`}
            className={cx(selectCompact, 'w-56')}
            value={claimType}
            onChange={(e) => onDraftChange({ ...draft, claim_type: e.target.value as ClaimType })}
            disabled={locked}
          >
            {config.claim_types.map((ct) => (
              <option key={ct} value={ct}>
                {claimTypeLabel(ct, names)}
              </option>
            ))}
          </select>
        </td>
        <td className="px-2 py-3 text-center align-middle">
          <TransferToggle transaction={tx} merchant={merchant} disabled={locked} title={closedTitle} onChange={onTransferChange} />
        </td>
        <td className="px-2 py-3 align-middle">
          <SourceBadge source={tx.classification_source} confidence={tx.classification_confidence} />
        </td>
        <td className="whitespace-nowrap px-2 py-3 text-right align-middle">
          <span className="inline-flex items-center justify-end gap-1">
            {/* Icon-only (as on the transactions page) so the row still fits beside Approve at 1440px. */}
            <button
              type="button"
              className={btnIcon}
              onClick={onSplit}
              disabled={locked || tx.is_internal_transfer}
              aria-label={`Split ${merchant}`}
              title={closedTitle ?? (tx.is_internal_transfer ? 'A transfer cannot be split' : 'Split into parts')}
            >
              <Scissors className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={cx(btnPrimary, btnSmall)}
              onClick={approve}
              disabled={locked}
              aria-label={`Approve ${merchant}`}
              title={closedTitle}
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              Approve
            </button>
          </span>
        </td>
      </tr>
      {error && (
        <tr>
          <td colSpan={APPROVAL_COLUMNS} className="px-3 pb-3">
            <p role="alert" className="flex items-center gap-2 rounded-lg bg-critical/10 px-3 py-2 text-xs text-critical-ink">
              <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {error}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}
