import { CircleAlert, CircleCheck, Plus, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { api, editErrorMessage, UNCATEGORIZED, type ClaimType, type SplitPartInput, type TransactionOut } from '../api';
import { useConfig, useCurrency, useNames } from '../config/ConfigContext';
import { formatDate } from '../lib/dates';
import { categoryLabel, categoryOptions, claimTypeLabel } from '../lib/format';
import { formatMoney } from '../lib/money';
import { formatPence, magnitude, parseAmountPence, toPence } from '../lib/splits';
import { btnGhost, btnIcon, btnPrimary, btnSecondary, btnSmall, cx, eyebrow, inputBase, selectBase } from '../lib/ui';
import { ErrorMessage } from './ErrorMessage';
import { MoneyText } from './MoneyText';

/** Unsaved dropdown choices to seed the first part with (the approval queue's draft). */
export interface SplitDefaults {
  category?: string;
  claim_type?: ClaimType;
}

interface Props {
  transaction: TransactionOut;
  /** First-part defaults used when the transaction is not yet split. */
  defaults?: SplitDefaults;
  onClose: () => void;
  /** The saved parent (`is_split`, `parts` filled, approved). The caller closes the dialog. */
  onSaved: (parent: TransactionOut) => void;
}

interface Row {
  /** Stable React key; never reused within one dialog. */
  key: number;
  /** The unsigned amount as typed; the sign always comes from the parent. */
  amount: string;
  category: string;
  subcategory: string | null;
  claim_type: ClaimType;
}

const MIN_PARTS = 2;
const MAX_PARTS = 20;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function initialRows(tx: TransactionOut, defaults: SplitDefaults | undefined): Row[] {
  if (tx.is_split && tx.parts.length >= MIN_PARTS) {
    return [...tx.parts]
      .sort((a, b) => a.split_index - b.split_index)
      .map((p, i) => ({
        key: i,
        amount: magnitude(p.amount),
        category: p.category,
        subcategory: p.subcategory,
        claim_type: p.claim_type,
      }));
  }
  const category = defaults?.category || tx.category || UNCATEGORIZED;
  const claimType = defaults?.claim_type ?? tx.claim_type ?? 'personal';
  return [
    {
      key: 0,
      amount: magnitude(tx.amount),
      category,
      // A subcategory only makes sense under the category it was recorded with.
      subcategory: category === tx.category ? tx.subcategory : null,
      claim_type: claimType,
    },
    { key: 1, amount: '', category, subcategory: null, claim_type: 'personal' },
  ];
}

/**
 * Modal for splitting one transaction into parts that each carry their own
 * amount, category and claim type. All maths is in integer pence; the Save
 * button only enables once the parts add up to the total exactly.
 */
export function SplitDialog({ transaction: tx, defaults, onClose, onSaved }: Props) {
  const config = useConfig();
  const names = useNames();
  const symbol = useCurrency();
  const idBase = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstAmountRef = useRef<HTMLInputElement>(null);
  // Initial rows use keys 0..n-1 (n <= MAX_PARTS); added rows count on from here.
  const nextKey = useRef(MAX_PARTS);
  const [rows, setRows] = useState<Row[]>(() => initialRows(tx, defaults));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Initial focus lands on the first amount; focus goes back where it came from on close.
  useEffect(() => {
    const previous = document.activeElement;
    firstAmountRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  // The page behind must not scroll while the dialog is open.
  useEffect(() => {
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  // Escape closes; Tab cycles within the dialog.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!saving) onClose();
        return;
      }
      const root = dialogRef.current;
      if (event.key !== 'Tab' || !root) return;
      const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const outside = !root.contains(active);
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, saving]);

  const merchant = tx.cleaned_merchant || tx.raw_description;
  const signedTotal = toPence(tx.amount);
  const totalPence = Math.abs(signedTotal);
  const pence = rows.map((r) => parseAmountPence(r.amount));
  const allocated = pence.reduce<number>((sum, p) => sum + (p ?? 0), 0);
  const remainder = totalPence - allocated;
  const complete =
    remainder === 0 &&
    rows.length >= MIN_PARTS &&
    rows.length <= MAX_PARTS &&
    pence.every((p) => p !== null) &&
    rows.every((r) => r.category.trim() !== '');
  const canSave = complete && !saving;

  function updateRow(key: number, change: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...change } : r)));
  }

  function addRow() {
    if (rows.length >= MAX_PARTS) return;
    const key = nextKey.current;
    nextKey.current += 1;
    const last = rows[rows.length - 1];
    setRows((prev) => [
      ...prev,
      { key, amount: '', category: last?.category ?? UNCATEGORIZED, subcategory: null, claim_type: 'personal' },
    ]);
  }

  function removeRow(key: number) {
    setRows((prev) => (prev.length <= MIN_PARTS ? prev : prev.filter((r) => r.key !== key)));
  }

  function fillRemainder(key: number, current: number | null) {
    updateRow(key, { amount: formatPence((current ?? 0) + remainder) });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    const sign = signedTotal < 0 ? -1 : 1;
    const parts: SplitPartInput[] = rows.map((r, i) => {
      const input: SplitPartInput = {
        amount: formatPence(sign * (pence[i] ?? 0)),
        category: r.category,
        claim_type: r.claim_type,
      };
      if (r.subcategory) input.subcategory = r.subcategory;
      return input;
    });
    setError(null);
    setSaving(true);
    try {
      const parent = await api.splitTransaction(tx.id, parts);
      onSaved(parent);
    } catch (err) {
      setError(editErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const status: { tone: string; icon: LucideIcon; text: string } =
    remainder === 0
      ? { tone: 'text-good-ink', icon: CircleCheck, text: `${formatMoney(0, symbol)} left to allocate` }
      : remainder > 0
        ? { tone: 'text-warning-ink', icon: TriangleAlert, text: `${formatMoney(remainder / 100, symbol)} still to allocate` }
        : { tone: 'text-critical-ink', icon: CircleAlert, text: `${formatMoney(-remainder / 100, symbol)} over the total` };
  const StatusIcon = status.icon;

  const titleId = `${idBase}-title`;
  const descId = `${idBase}-desc`;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-bg/70 backdrop-blur-sm" aria-hidden="true" onClick={() => !saving && onClose()} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="relative z-10 flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col rounded-2xl border border-hairline bg-surface shadow-pop animate-rise"
      >
        <header className="flex items-start justify-between gap-3 border-b border-hairline px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-base font-semibold tracking-tight text-ink">
              Split {merchant}
            </h2>
            <p id={descId} className="mt-0.5 text-sm text-ink-2">
              {formatDate(tx.transaction_date)} · Total <MoneyText value={tx.amount} tone className="font-semibold" />
            </p>
          </div>
          <button type="button" className={btnIcon} aria-label="Close" title="Close" disabled={saving} onClick={onClose}>
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 sm:px-6">
            <div
              className="hidden grid-cols-[3.5rem_8.5rem_minmax(0,1fr)_minmax(0,1fr)_2rem] gap-2 sm:grid"
              aria-hidden="true"
            >
              <span />
              <span className={eyebrow}>Amount</span>
              <span className={eyebrow}>Category</span>
              <span className={eyebrow}>Claim type</span>
              <span />
            </div>
            <ul className="space-y-2">
              {rows.map((row, i) => {
                const n = i + 1;
                const rowPence = pence[i];
                const invalid = row.amount !== '' && rowPence === null;
                const canFill = remainder !== 0 && (rowPence ?? 0) + remainder > 0;
                return (
                  <li
                    key={row.key}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-xl border border-hairline p-3 sm:grid-cols-[3.5rem_8.5rem_minmax(0,1fr)_minmax(0,1fr)_2rem] sm:items-start sm:border-0 sm:p-0"
                  >
                    <span className="self-center text-xs font-medium text-ink-2 sm:pt-2.5 sm:self-start tabular">Part {n}</span>
                    <button
                      type="button"
                      className={cx(btnIcon, 'justify-self-end sm:order-last')}
                      aria-label={`Remove part ${n}`}
                      title="Remove part"
                      disabled={rows.length <= MIN_PARTS || saving}
                      onClick={() => removeRow(row.key)}
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <div className="col-span-2 sm:col-span-1">
                      <div className="relative">
                        <span
                          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink-3"
                          aria-hidden="true"
                        >
                          {symbol}
                        </span>
                        <input
                          ref={i === 0 ? firstAmountRef : undefined}
                          type="text"
                          inputMode="decimal"
                          className={cx(inputBase, 'pl-7 tabular', invalid && 'border-critical hover:border-critical')}
                          placeholder="0.00"
                          value={row.amount}
                          aria-label={`Amount for part ${n}`}
                          aria-invalid={invalid ? true : undefined}
                          disabled={saving}
                          onChange={(e) => updateRow(row.key, { amount: e.target.value })}
                        />
                      </div>
                      {canFill && (
                        <button
                          type="button"
                          className={cx(btnGhost, btnSmall, 'mt-1 -ml-1.5 h-7 px-1.5')}
                          aria-label={`Use remainder for part ${n}`}
                          disabled={saving}
                          onClick={() => fillRemainder(row.key, rowPence)}
                        >
                          Use remainder
                        </button>
                      )}
                    </div>
                    <select
                      className={cx(selectBase, 'col-span-2 sm:col-span-1')}
                      value={row.category}
                      aria-label={`Category for part ${n}`}
                      disabled={saving}
                      onChange={(e) => updateRow(row.key, { category: e.target.value, subcategory: null })}
                    >
                      {categoryOptions(config.categories, row.category).map((c) => (
                        <option key={c} value={c}>
                          {categoryLabel(c)}
                        </option>
                      ))}
                    </select>
                    <select
                      className={cx(selectBase, 'col-span-2 sm:col-span-1')}
                      value={row.claim_type}
                      aria-label={`Claim type for part ${n}`}
                      disabled={saving}
                      onChange={(e) => updateRow(row.key, { claim_type: e.target.value as ClaimType })}
                    >
                      {config.claim_types.map((ct) => (
                        <option key={ct} value={ct}>
                          {claimTypeLabel(ct, names)}
                        </option>
                      ))}
                    </select>
                  </li>
                );
              })}
            </ul>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <p role="status" aria-live="polite" className={cx('flex items-center gap-2 text-sm font-medium', status.tone)}>
                <StatusIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                {status.text}
              </p>
              <button
                type="button"
                className={cx(btnSecondary, btnSmall)}
                onClick={addRow}
                disabled={rows.length >= MAX_PARTS || saving}
                title={rows.length >= MAX_PARTS ? `A split can have at most ${MAX_PARTS} parts` : undefined}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add part
              </button>
            </div>

            <ErrorMessage message={error} onDismiss={() => setError(null)} />
          </div>

          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-hairline px-5 py-4 sm:px-6">
            <button type="button" className={btnSecondary} onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className={btnPrimary} disabled={!canSave}>
              {saving ? 'Saving…' : 'Save split'}
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}
