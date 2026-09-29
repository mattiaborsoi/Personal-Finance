import { CircleAlert, CornerDownRight, Pencil, Scissors, Trash2, Ungroup } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { UNCATEGORIZED, type TransactionOut, type TransactionPart, type TransactionPatch } from '../api';
import { useConfig } from '../config/ConfigContext';
import { formatDate } from '../lib/dates';
import { accountLabel, plural, reviewStatusLabel } from '../lib/format';
import {
  btnIcon,
  btnIconSmall,
  chipSoft,
  cx,
  focusRing,
  inputCompact,
  trHover,
} from '../lib/ui';
import { Badge, type BadgeTone } from './Badge';
import { CategoryPicker } from './CategoryPicker';
import { ClaimTypeControl } from './ClaimTypeControl';
import { ConfirmButton } from './ConfirmButton';
import { MerchantAvatar } from './MerchantAvatar';
import { MoneyText } from './MoneyText';
import { SourceBadge } from './SourceBadge';
import { TransferToggle } from './TransferToggle';

interface Props {
  transaction: TransactionOut;
  onPatch: (patch: TransactionPatch) => Promise<void>;
  onDelete: () => Promise<void>;
  /** Opens the split dialog for this transaction (new split or editing the existing one). */
  onSplit: () => void;
  onUnsplit: () => Promise<void>;
  onPatchPart: (part: TransactionPart, patch: TransactionPatch) => Promise<void>;
  error?: string;
  /** Errors keyed by part id, for the sub-rows of a split transaction. */
  partErrors?: Record<string, string>;
  /** The transaction's period is closed: show the row, allow no edits. */
  readOnly?: boolean;
}

const STATUS_TONES: Record<string, BadgeTone> = {
  pending_review: 'amber',
  auto_approved: 'green',
  manual_approved: 'green',
};

const NO_ERRORS: Record<string, string> = {};

/*
 * One component tree for both widths. From `sm` up each row is an ordinary
 * table row; below it the row becomes a two-column grid card (name and amount
 * on top, then the badges, the selects full width and the row's actions), so
 * a phone never has to scroll the table sideways. The cells place themselves
 * with the grid classes, which a table cell ignores.
 */
/** A row: a grid card on a phone, a table row from `sm`. */
const rowLayout = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5 px-5 sm:table-row sm:p-0';
/** A cell: a grid item on a phone, a padded table cell from `sm`. */
const cellBase = 'block min-w-0 text-ink sm:table-cell sm:px-2 sm:align-middle';
const cell = `${cellBase} sm:py-3`;
/** A cell of a split part's sub-row, a little tighter than the row above it. */
const partCell = `${cellBase} sm:py-2`;
/** A cell that only exists to keep the table's columns; nothing to show on a phone. */
const spacerCell = 'hidden sm:table-cell sm:px-2 sm:py-2';
/** Full width on a phone; fixed on a laptop so the row fits; from `2xl` as wide as the category's label, capped (the button's `title` has it all). */
const categoryWidth = 'w-full sm:w-40 2xl:w-auto 2xl:min-w-[11rem] 2xl:max-w-[18rem]';
/** Full width on a phone; icons only on a laptop; from `2xl` the chosen segment also shows its word. */
const claimWidth = 'w-full sm:w-36 2xl:w-auto';

function ErrorRow({ message }: { message: string }) {
  return (
    <tr className="block px-5 pb-3 sm:table-row sm:p-0">
      <td colSpan={7} className="block sm:table-cell sm:px-3 sm:pb-3">
        <p role="alert" className="flex items-center gap-2 rounded-lg bg-critical/10 px-3 py-2 text-xs text-critical-ink">
          <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {message}
        </p>
      </td>
    </tr>
  );
}

/** One row of the transactions list with inline PATCH edits, a confirmed delete and split parts. */
export function TransactionRow({
  transaction: tx,
  onPatch,
  onDelete,
  onSplit,
  onUnsplit,
  onPatchPart,
  error,
  partErrors = NO_ERRORS,
  readOnly = false,
}: Props) {
  const config = useConfig();
  const [saving, setSaving] = useState(false);
  const [savingPart, setSavingPart] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  /** The name being typed while the merchant is renamed inline; null when not renaming. */
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  /** Set once Enter, Escape or blur has ended a rename, so the blur that follows the swap does not save twice. */
  const renameEnded = useRef(false);
  /** Focus goes back to the rename button when the rename ended from the keyboard. */
  const refocusRename = useRef(false);

  async function patch(change: TransactionPatch) {
    setSaving(true);
    try {
      await onPatch(change);
    } finally {
      setSaving(false);
    }
  }

  async function patchPart(part: TransactionPart, change: TransactionPatch) {
    setSavingPart(part.id);
    try {
      await onPatchPart(part, change);
    } finally {
      setSavingPart(null);
    }
  }

  const merchant = tx.cleaned_merchant || tx.raw_description;
  // A split part never names itself: its parent carries the merchant (the server refuses the rename with 409).
  const canRename = !tx.split_parent_id;

  function startRename() {
    if (saving) return;
    renameEnded.current = false;
    setRenameDraft(merchant);
  }

  /** Saves a changed, non-blank name through the row's PATCH (its errors show under the row); anything else just closes. */
  function endRename(save: boolean) {
    if (renameEnded.current || renameDraft === null) return;
    renameEnded.current = true;
    const name = renameDraft.trim();
    setRenameDraft(null);
    if (save && name && name !== merchant) void patch({ cleaned_merchant: name });
  }

  function renameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    refocusRename.current = true;
    endRename(event.key === 'Enter');
  }

  const hasRawLine = Boolean(tx.raw_description) && tx.raw_description !== merchant;
  const locked = saving || readOnly;
  const parts = tx.is_split ? [...tx.parts].sort((a, b) => a.split_index - b.split_index) : [];
  // On a phone the actions line sits under the selects, or under the split badge that replaces them.
  const actionsRow = tx.is_split ? 'row-start-4' : 'row-start-5';

  return (
    <>
      <tr className={cx(rowLayout, 'py-4', trHover, saving && 'opacity-60')}>
        <td className={cx(cell, 'col-start-1 row-start-1 sm:w-full sm:min-w-[12rem] sm:max-w-0 2xl:min-w-[18rem]')}>
          <div className="flex items-start gap-3">
            <MerchantAvatar name={merchant} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-1.5">
                {renameDraft !== null ? (
                  <input
                    name="merchant_name"
                    autoComplete="off"
                    spellCheck={false}
                    className={cx(inputCompact, 'w-full max-w-[18rem] font-semibold')}
                    aria-label={`New name for ${merchant}`}
                    value={renameDraft}
                    maxLength={255}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={renameKeyDown}
                    onBlur={() => endRename(true)}
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      className={cx(
                        'line-clamp-2 min-w-0 break-words rounded text-left font-semibold leading-snug text-ink hover:underline',
                        focusRing,
                      )}
                      title={merchant}
                      aria-expanded={showRaw}
                      onClick={() => setShowRaw((s) => !s)}
                    >
                      {merchant}
                    </button>
                    {canRename && (
                      <button
                        type="button"
                        ref={(el) => {
                          if (el && refocusRename.current) {
                            refocusRename.current = false;
                            el.focus();
                          }
                        }}
                        className={cx(btnIconSmall, '-my-0.5')}
                        aria-label={`Rename ${merchant}`}
                        title={readOnly ? 'This period is closed' : 'Rename the merchant'}
                        // Not locked while saving, so focus can come back here after Enter; a click then is ignored.
                        disabled={readOnly}
                        onClick={startRename}
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </>
                )}
              </div>
              <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
                <span className="shrink-0 tabular">{formatDate(tx.transaction_date)}</span>
                <span aria-hidden="true">·</span>
                <span className={cx(chipSoft, 'min-w-0')}>{accountLabel(config.accounts, tx.account_id)}</span>
              </p>
              {hasRawLine && (
                <p
                  className={cx('mt-0.5 w-0 min-w-full max-w-[22rem] font-mono text-xs text-ink-3', showRaw ? 'break-all' : 'truncate')}
                  title={showRaw ? undefined : tx.raw_description}
                >
                  {tx.raw_description}
                </p>
              )}
            </div>
          </div>
        </td>
        <td className={cx(cell, 'col-span-2 row-start-2')}>
          <div className="flex flex-wrap items-center gap-1 sm:flex-col sm:flex-nowrap sm:items-start">
            <Badge tone={STATUS_TONES[tx.review_status] ?? 'neutral'} dot>
              {reviewStatusLabel(tx.review_status)}
            </Badge>
            <SourceBadge source={tx.classification_source} confidence={tx.classification_confidence} />
            {tx.is_internal_transfer && <Badge tone="neutral">Transfer</Badge>}
            {readOnly && (
              <Badge tone="neutral" title="This period is closed; reopen it to make changes">
                Period closed
              </Badge>
            )}
          </div>
        </td>
        <td
          className={cx(cell, 'col-start-2 row-start-1 self-start whitespace-nowrap text-right font-semibold tabular')}
        >
          <MoneyText value={tx.amount} tone />
        </td>
        {tx.is_split ? (
          <td colSpan={2} className={cx(cell, 'col-span-2 row-start-3')}>
            <Badge tone="blue" title="Each part carries its own category and claim type">
              <Scissors className="h-3 w-3" aria-hidden="true" />
              Split into {plural(parts.length, 'part')}
            </Badge>
          </td>
        ) : (
          <>
            <td className={cx(cell, 'col-span-2 row-start-3')}>
              <CategoryPicker
                label={`Category for ${merchant}`}
                merchant={merchant}
                className={categoryWidth}
                value={tx.category || UNCATEGORIZED}
                disabled={locked}
                onChange={(next) => void patch({ category: next })}
              />
            </td>
            <td className={cx(cell, 'col-span-2 row-start-4')}>
              <ClaimTypeControl
                label={`Claim type for ${merchant}`}
                className={claimWidth}
                value={tx.claim_type}
                disabled={locked}
                onChange={(next) => void patch({ claim_type: next })}
              />
            </td>
          </>
        )}
        <td className={cx(cell, 'col-start-1 pl-2 sm:text-center', actionsRow)}>
          <TransferToggle
            transaction={tx}
            merchant={merchant}
            disabled={locked}
            title={readOnly ? 'This period is closed' : undefined}
            onChange={(on) => patch({ is_internal_transfer: on })}
          />
          {/* A phone has no column header, so the checkbox is named on screen too (its accessible name is its own). */}
          <span className="ml-1 align-middle text-xs text-ink-2 sm:hidden" aria-hidden="true">
            Transfer
          </span>
        </td>
        <td className={cx(cell, 'col-start-2 whitespace-nowrap text-right', actionsRow)}>
          <span className="inline-flex items-center justify-end gap-1">
            {tx.is_split ? (
              <>
                <button
                  type="button"
                  className={btnIcon}
                  aria-label={`Edit split for ${merchant}`}
                  title="Edit split"
                  disabled={locked}
                  onClick={onSplit}
                >
                  <Scissors className="h-4 w-4" aria-hidden="true" />
                </button>
                <ConfirmButton
                  confirmLabel="Remove this split?"
                  onConfirm={onUnsplit}
                  small
                  disabled={locked}
                  icon={Ungroup}
                  iconOnly
                  ariaLabel={`Unsplit ${merchant}`}
                >
                  Unsplit
                </ConfirmButton>
              </>
            ) : (
              <button
                type="button"
                className={btnIcon}
                aria-label={`Split ${merchant}`}
                title={tx.is_internal_transfer ? 'A transfer cannot be split' : 'Split into parts'}
                disabled={locked || tx.is_internal_transfer}
                onClick={onSplit}
              >
                <Scissors className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
            <ConfirmButton
              confirmLabel="Delete this transaction?"
              onConfirm={onDelete}
              tone="danger"
              small
              disabled={readOnly}
              icon={Trash2}
              iconOnly
              ariaLabel={`Delete ${merchant}`}
            >
              Delete
            </ConfirmButton>
          </span>
        </td>
      </tr>
      {error && <ErrorRow message={error} />}
      {parts.map((part, i) => {
        const n = i + 1;
        const partLocked = readOnly || savingPart === part.id;
        const partError = partErrors[part.id];
        return (
          <PartRows
            key={part.id}
            part={part}
            n={n}
            merchant={merchant}
            locked={partLocked}
            saving={savingPart === part.id}
            error={partError}
            onPatch={(change) => patchPart(part, change)}
          />
        );
      })}
    </>
  );
}

interface PartRowsProps {
  part: TransactionPart;
  n: number;
  merchant: string;
  locked: boolean;
  saving: boolean;
  error?: string;
  onPatch: (patch: TransactionPatch) => void;
}

/** One indented sub-row per part of a split transaction, editable in place. */
function PartRows({ part, n, merchant, locked, saving, error, onPatch }: PartRowsProps) {
  return (
    <>
      <tr className={cx(rowLayout, 'bg-surface-2/40 py-3', saving && 'opacity-60')}>
        <td className={cx(partCell, 'col-start-1 row-start-1')}>
          <div className="flex items-center gap-2 pl-6 text-xs text-ink-2 sm:pl-11">
            <CornerDownRight className="h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
            <span>Part {n}</span>
          </div>
        </td>
        <td className={spacerCell} />
        <td className={cx(partCell, 'col-start-2 row-start-1 whitespace-nowrap text-right tabular')}>
          <MoneyText value={part.amount} tone />
        </td>
        <td className={cx(partCell, 'col-span-2 row-start-2')}>
          <CategoryPicker
            label={`Category for ${merchant} part ${n}`}
            merchant={merchant}
            className={categoryWidth}
            value={part.category || UNCATEGORIZED}
            disabled={locked}
            onChange={(next) => onPatch({ category: next })}
          />
        </td>
        <td className={cx(partCell, 'col-span-2 row-start-3')}>
          <ClaimTypeControl
            label={`Claim type for ${merchant} part ${n}`}
            className={claimWidth}
            value={part.claim_type}
            disabled={locked}
            onChange={(next) => onPatch({ claim_type: next })}
          />
        </td>
        <td className={spacerCell} />
        <td className={spacerCell} />
      </tr>
      {error && <ErrorRow message={error} />}
    </>
  );
}
