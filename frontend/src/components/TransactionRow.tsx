import { CircleAlert, CornerDownRight, Scissors, Trash2, Ungroup } from 'lucide-react';
import { useState } from 'react';
import { UNCATEGORIZED, type ClaimType, type TransactionOut, type TransactionPart, type TransactionPatch } from '../api';
import { useConfig, useNames } from '../config/ConfigContext';
import { formatDate } from '../lib/dates';
import { accountLabel, categoryLabel, categoryOptions, claimTypeLabel, plural, reviewStatusLabel } from '../lib/format';
import { btnIcon, chipSoft, cx, focusRing, selectCategory, selectCompact, tdBase, trHover } from '../lib/ui';
import { Badge, type BadgeTone } from './Badge';
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

function ErrorRow({ message }: { message: string }) {
  return (
    <tr>
      <td colSpan={7} className="px-3 pb-3">
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
  const names = useNames();
  const [saving, setSaving] = useState(false);
  const [savingPart, setSavingPart] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

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

  const id = tx.id;
  const merchant = tx.cleaned_merchant || tx.raw_description;
  const hasRawLine = Boolean(tx.raw_description) && tx.raw_description !== merchant;
  const categories = categoryOptions(config.categories, tx.category);
  const locked = saving || readOnly;
  const parts = tx.is_split ? [...tx.parts].sort((a, b) => a.split_index - b.split_index) : [];

  return (
    <>
      <tr className={cx(trHover, saving && 'opacity-60')}>
        <td className={cx(tdBase, 'w-full min-w-[15rem] max-w-0 px-2 align-middle')}>
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
        <td className={cx(tdBase, 'px-2 align-middle')}>
          <div className="flex flex-col items-start gap-1">
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
        <td className={cx(tdBase, 'whitespace-nowrap px-2 text-right align-middle font-semibold tabular')}>
          <MoneyText value={tx.amount} tone />
        </td>
        {tx.is_split ? (
          <td colSpan={2} className={cx(tdBase, 'px-2 align-middle')}>
            <Badge tone="blue" title="Each part carries its own category and claim type">
              <Scissors className="h-3 w-3" aria-hidden="true" />
              Split into {plural(parts.length, 'part')}
            </Badge>
          </td>
        ) : (
          <>
            <td className={cx(tdBase, 'px-2 align-middle')}>
              <label htmlFor={`t-category-${id}`} className="sr-only">
                Category for {merchant}
              </label>
              <select
                id={`t-category-${id}`}
                className={cx(selectCompact, selectCategory)}
                value={tx.category || UNCATEGORIZED}
                title={categoryLabel(tx.category || UNCATEGORIZED)}
                disabled={locked}
                onChange={(e) => patch({ category: e.target.value })}
              >
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {categoryLabel(c)}
                  </option>
                ))}
              </select>
            </td>
            <td className={cx(tdBase, 'px-2 align-middle')}>
              <label htmlFor={`t-claim-${id}`} className="sr-only">
                Claim type for {merchant}
              </label>
              <select
                id={`t-claim-${id}`}
                className={cx(selectCompact, 'w-56')}
                value={tx.claim_type ?? ''}
                disabled={locked}
                onChange={(e) => patch({ claim_type: e.target.value as ClaimType })}
              >
                {config.claim_types.map((ct) => (
                  <option key={ct} value={ct}>
                    {claimTypeLabel(ct, names)}
                  </option>
                ))}
              </select>
            </td>
          </>
        )}
        <td className={cx(tdBase, 'px-2 text-center align-middle')}>
          <TransferToggle
            transaction={tx}
            merchant={merchant}
            disabled={locked}
            title={readOnly ? 'This period is closed' : undefined}
            onChange={(on) => patch({ is_internal_transfer: on })}
          />
        </td>
        <td className={cx(tdBase, 'whitespace-nowrap px-2 text-right align-middle')}>
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
  const config = useConfig();
  const names = useNames();
  return (
    <>
      <tr className={cx('bg-surface-2/40', saving && 'opacity-60')}>
        <td className={cx(tdBase, 'px-2 py-2 align-middle')}>
          <div className="flex items-center gap-2 pl-11 text-xs text-ink-2">
            <CornerDownRight className="h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
            <span>Part {n}</span>
          </div>
        </td>
        <td className={cx(tdBase, 'px-2 py-2')} />
        <td className={cx(tdBase, 'whitespace-nowrap px-2 py-2 text-right align-middle tabular')}>
          <MoneyText value={part.amount} tone />
        </td>
        <td className={cx(tdBase, 'px-2 py-2 align-middle')}>
          <select
            className={cx(selectCompact, selectCategory)}
            value={part.category || UNCATEGORIZED}
            title={categoryLabel(part.category || UNCATEGORIZED)}
            disabled={locked}
            aria-label={`Category for ${merchant} part ${n}`}
            onChange={(e) => onPatch({ category: e.target.value })}
          >
            {categoryOptions(config.categories, part.category).map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
        </td>
        <td className={cx(tdBase, 'px-2 py-2 align-middle')}>
          <select
            className={cx(selectCompact, 'w-56')}
            value={part.claim_type}
            disabled={locked}
            aria-label={`Claim type for ${merchant} part ${n}`}
            onChange={(e) => onPatch({ claim_type: e.target.value as ClaimType })}
          >
            {config.claim_types.map((ct) => (
              <option key={ct} value={ct}>
                {claimTypeLabel(ct, names)}
              </option>
            ))}
          </select>
        </td>
        <td className={cx(tdBase, 'px-2 py-2')} />
        <td className={cx(tdBase, 'px-2 py-2')} />
      </tr>
      {error && <ErrorRow message={error} />}
    </>
  );
}
