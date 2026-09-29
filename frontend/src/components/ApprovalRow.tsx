import { Check, CircleAlert, Scissors } from 'lucide-react';
import { useState } from 'react';
import { UNCATEGORIZED, type ClaimType, type TransactionOut, type TransactionPatch } from '../api';
import { useConfig } from '../config/ConfigContext';
import { formatDate } from '../lib/dates';
import { accountLabel, claimContextForAccount } from '../lib/format';
import { useInlineEdit } from '../hooks/useInlineEdit';
import { btnIcon, btnPrimary, btnSmall, checkboxBase, chipSoft, cx, trHover } from '../lib/ui';
import { CategoryPicker } from './CategoryPicker';
import { ClaimTypeControl } from './ClaimTypeControl';
import { MerchantAvatar } from './MerchantAvatar';
import { MerchantName } from './MerchantName';
import { MoneyText } from './MoneyText';
import { SourceBadge } from './SourceBadge';
import { NoteButton, NoteLine } from './TransactionNote';
import { TransferToggle } from './TransferToggle';

/**
 * The user's unsaved dropdown choices for one row. Held by the queue, not the
 * row, so they survive the row being removed and restored around a failed approve.
 */
export type ApprovalDraft = Pick<TransactionPatch, 'category' | 'claim_type'>;

/** How many cells a row spans, for the error row beneath it. */
export const APPROVAL_COLUMNS = 7;

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
  /**
   * Saves a rename or a note straight away with PATCH (not part of the approve
   * draft); the line stays in the queue with what the server returns.
   */
  onPatch: (patch: TransactionPatch) => void;
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
  onPatch,
}: Props) {
  const config = useConfig();
  const [showRaw, setShowRaw] = useState(false);

  const originalCategory = tx.category || UNCATEGORIZED;
  const category = draft.category ?? originalCategory;
  const claimType: ClaimType | '' = draft.claim_type ?? tx.claim_type ?? '';

  function approve() {
    const corrections: TransactionPatch = {};
    if (category !== originalCategory) corrections.category = category;
    if (claimType && claimType !== tx.claim_type) corrections.claim_type = claimType;
    onApprove(corrections);
  }

  const merchant = tx.cleaned_merchant || tx.raw_description;
  const hasRawLine = Boolean(tx.raw_description) && tx.raw_description !== merchant;
  const locked = busy || disabled;
  const closedTitle = disabled ? 'This period is closed' : undefined;
  const noteEdit = useInlineEdit({ value: tx.note ?? '', onSave: (note) => onPatch({ note }), blocked: busy });

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
        {/* w-full + max-w-0: this column takes the leftover width and never pushes the table wider. */}
        <td className="w-full min-w-[13rem] max-w-0 px-2 py-3 align-middle">
          <div className="flex items-start gap-3">
            <MerchantAvatar name={merchant} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-start gap-x-1.5">
                <MerchantName
                  merchant={merchant}
                  nameTitle={tx.raw_description}
                  expanded={showRaw}
                  onToggle={() => setShowRaw((s) => !s)}
                  closedTitle={closedTitle}
                  busy={busy}
                  onRename={(name) => onPatch({ cleaned_merchant: name })}
                >
                  <NoteButton edit={noteEdit} hasNote={Boolean(tx.note)} subject={merchant} closedTitle={closedTitle} />
                </MerchantName>
                <span className="ml-0.5 mt-0.5 shrink-0 text-xs text-ink-3 tabular">{formatDate(tx.transaction_date)}</span>
              </div>
              {hasRawLine && (
                <p className={cx('mt-0.5 w-0 min-w-full max-w-[22rem] font-mono text-xs text-ink-3', showRaw ? 'break-all' : 'truncate')}>
                  {tx.raw_description}
                </p>
              )}
              <NoteLine edit={noteEdit} note={tx.note} subject={merchant} />
              <p className="mt-1 text-xs text-ink-3">
                <span className={chipSoft}>{accountLabel(config.accounts, tx.account_id)}</span>
              </p>
            </div>
          </div>
        </td>
        <td className="whitespace-nowrap px-2 py-3 text-right align-middle font-semibold tabular">
          <MoneyText value={tx.amount} tone />
        </td>
        {/* Category and claim type share a cell: stacked below 2xl, side by side on a wide screen, so the row fits. */}
        <td className="px-2 py-3 align-middle">
          <div className="flex flex-col gap-1.5 2xl:flex-row 2xl:items-center 2xl:gap-2">
            <CategoryPicker
              label={`Category for ${merchant}`}
              merchant={merchant}
              className="w-44 2xl:w-auto 2xl:min-w-[11rem] 2xl:max-w-[16rem]"
              value={category}
              onChange={(next) => onDraftChange({ ...draft, category: next })}
              disabled={locked}
            />
            <ClaimTypeControl
              label={`Claim type for ${merchant}`}
              context={claimContextForAccount(config.accounts.find((a) => a.id === tx.account_id), config.users)}
              className="w-44 2xl:w-auto"
              value={claimType}
              onChange={(next) => onDraftChange({ ...draft, claim_type: next })}
              disabled={locked}
            />
          </div>
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
              {/* The label is the button's name either way; the word only shows where the row has room. */}
              <span className="hidden 2xl:inline">Approve</span>
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
