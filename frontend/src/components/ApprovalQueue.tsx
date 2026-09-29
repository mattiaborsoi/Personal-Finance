import { ListChecks, Lock } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, editErrorMessage, type TransactionOut, type TransactionPatch } from '../api';
import { useConfig } from '../config/ConfigContext';
import { useAsync } from '../hooks/useAsync';
import { accountLabel, plural } from '../lib/format';
import { btnPrimary, btnSecondary, btnSmall, cardBase, checkboxBase, cx, selectCompact, tableBase, tableFlush } from '../lib/ui';
import { ApprovalRow, type ApprovalDraft } from './ApprovalRow';
import { EmptyState } from './EmptyState';
import { ErrorMessage } from './ErrorMessage';
import { LoadingState } from './LoadingState';
import { Notice } from './Notice';
import { SplitDialog } from './SplitDialog';

interface Props {
  period: string;
  /** The period is closed: list the queue but allow no approvals. */
  closed?: boolean;
  /** Called after any approval succeeds so the page can count the periods again. */
  onChanged?: () => void;
  /** Show only this account's lines ('' or undefined: every account). */
  account?: string;
  /** Called when the user picks another account in the queue's filter. */
  onAccountChange?: (accountId: string) => void;
}

const NO_DRAFT: ApprovalDraft = {};

export function ApprovalQueue({ period, closed = false, onChanged, account = '', onAccountChange }: Props) {
  const config = useConfig();
  const queue = useAsync(
    () => api.listTransactions({ period, status: 'pending_review', limit: 200, offset: 0 }),
    `approval-queue:${period}`,
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [drafts, setDrafts] = useState<Record<string, ApprovalDraft>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [batchError, setBatchError] = useState<string | null>(null);
  /** The transaction whose split dialog is open. */
  const [splitting, setSplitting] = useState<TransactionOut | null>(null);
  /** Read out by the always-mounted status region after an approval succeeds. */
  const [announcement, setAnnouncement] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** Set when a saved split closes the dialog: the row (and the button focus would return to) is gone. */
  const focusHeadingAfterSplit = useRef(false);

  useEffect(() => {
    if (splitting || !focusHeadingAfterSplit.current) return;
    focusHeadingAfterSplit.current = false;
    headingRef.current?.focus();
  }, [splitting]);

  const allItems = useMemo(() => queue.data?.items ?? [], [queue.data]);
  // The filter works on the month's lines already loaded, so each account can show its count.
  const items = useMemo(() => (account ? allItems.filter((t) => t.account_id === account) : allItems), [allItems, account]);
  const total = account ? items.length : (queue.data?.total ?? items.length);
  const accountCounts = useMemo(() => {
    const counts = new Map<string, number>();
    allItems.forEach((t) => counts.set(t.account_id, (counts.get(t.account_id) ?? 0) + 1));
    // A chosen account stays in the list at 0 once its last line is approved.
    if (account && !counts.has(account)) counts.set(account, 0);
    return [...counts.entries()]
      .map(([id, count]) => ({ id, count, label: accountLabel(config.accounts, id) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [allItems, account, config.accounts]);
  const showFilter = Boolean(onAccountChange) && (accountCounts.length > 1 || Boolean(account));
  const accountName = account ? accountLabel(config.accounts, account) : '';

  function removeOptimistically(ids: string[]) {
    const remove = new Set(ids);
    queue.setData((prev) =>
      prev ? { items: prev.items.filter((t) => !remove.has(t.id)), total: prev.total - ids.length } : prev,
    );
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
  }

  function restore(rows: TransactionOut[]) {
    queue.setData((prev) => {
      if (!prev) return prev;
      const existing = new Set(prev.items.map((t) => t.id));
      const merged = [...prev.items, ...rows.filter((r) => !existing.has(r.id))].sort((a, b) =>
        a.transaction_date < b.transaction_date ? 1 : a.transaction_date > b.transaction_date ? -1 : 0,
      );
      return { items: merged, total: prev.total + rows.length };
    });
  }

  function setBusyFor(ids: string[], on: boolean) {
    setBusy((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });
  }

  function setDraft(id: string, draft: ApprovalDraft) {
    setDrafts((prev) => ({ ...prev, [id]: draft }));
  }

  function clearDrafts(ids: string[]) {
    setDrafts((prev) => {
      const next = { ...prev };
      ids.forEach((id) => delete next[id]);
      return next;
    });
  }

  async function approveOne(tx: TransactionOut, corrections: TransactionPatch) {
    setAnnouncement('');
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[tx.id];
      return next;
    });
    setBusyFor([tx.id], true);
    removeOptimistically([tx.id]);
    // The row's Approve button had focus and has just gone; keep the keyboard user in the queue.
    headingRef.current?.focus();
    try {
      await api.approveTransaction(tx.id, { ...corrections, remember: true });
      clearDrafts([tx.id]);
      setAnnouncement(`Approved ${tx.cleaned_merchant || tx.raw_description}`);
      onChanged?.();
    } catch (err) {
      // The draft stays in `drafts`, so the restored row shows the user's edits.
      restore([tx]);
      setRowErrors((prev) => ({ ...prev, [tx.id]: editErrorMessage(err) }));
    } finally {
      setBusyFor([tx.id], false);
    }
  }

  async function approveSelected() {
    const rows = items.filter((t) => selected.has(t.id));
    const ids = rows.map((t) => t.id);
    if (ids.length === 0) return;
    setAnnouncement('');
    setBatchError(null);
    setBusyFor(ids, true);
    removeOptimistically(ids);
    try {
      await api.approveBatch({ ids, remember: true });
      clearDrafts(ids);
      setAnnouncement(`${plural(ids.length, 'transaction')} approved`);
      onChanged?.();
    } catch (err) {
      restore(rows);
      setBatchError(editErrorMessage(err));
    } finally {
      setBusyFor(ids, false);
    }
  }

  /**
   * Marking a line as a transfer is the same PATCH the transactions page sends.
   * It does not approve the line, so the row stays in the queue with what the
   * server now says about it (a transfer's claim type becomes personal).
   */
  async function markTransfer(tx: TransactionOut, isInternalTransfer: boolean) {
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[tx.id];
      return next;
    });
    setBusyFor([tx.id], true);
    try {
      const updated = await api.patchTransaction(tx.id, { is_internal_transfer: isInternalTransfer });
      queue.setData((prev) =>
        prev ? { ...prev, items: prev.items.map((t) => (t.id === tx.id ? updated : t)) } : prev,
      );
      // The claim type the server chose replaces any unsaved choice; a category draft still stands.
      setDrafts((prev) => (prev[tx.id] ? { ...prev, [tx.id]: { ...prev[tx.id], claim_type: undefined } } : prev));
      onChanged?.();
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [tx.id]: editErrorMessage(err) }));
    } finally {
      setBusyFor([tx.id], false);
    }
  }

  /** Splitting counts as approval, so the row leaves the queue just like an approved one. */
  function splitSaved(parent: TransactionOut) {
    setAnnouncement('');
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[parent.id];
      return next;
    });
    removeOptimistically([parent.id]);
    clearDrafts([parent.id]);
    focusHeadingAfterSplit.current = true;
    setSplitting(null);
    setAnnouncement('Split saved and approved');
    onChanged?.();
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelected = items.length > 0 && items.every((t) => selected.has(t.id));
  const selectedCount = items.filter((t) => selected.has(t.id)).length;

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(items.map((t) => t.id)));
  }

  const hasNotices = Boolean(queue.error) || Boolean(batchError) || (closed && items.length > 0);

  return (
    // min-w-0: the table scrolls inside the card; it must never widen the page on a phone.
    <section id="approval-queue" aria-label="Approval queue" className={cx(cardBase, 'min-w-0 scroll-mt-20 p-0 sm:p-0')}>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
      {/* The batch bar stays in view while a long queue scrolls; the offset clears the mobile top bar. */}
      <header className="sticky top-[61px] z-10 rounded-t-2xl border-b border-hairline bg-surface/95 px-5 py-4 backdrop-blur sm:px-6 md:top-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-2"
            >
              <ListChecks className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold tracking-tight text-ink focus:outline-none">
                Approval queue
              </h2>
              {queue.data && (
                <p className="mt-0.5 text-xs text-ink-3">
                  {account
                    ? `${plural(total, 'transaction')} pending review on ${accountName}, of ${allItems.length} this month`
                    : `${plural(total, 'transaction')} pending review`}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {queue.loading && <LoadingState inline />}
            {showFilter && (
              <>
                <label htmlFor={`review-account-${period}`} className="sr-only">
                  Show lines from
                </label>
                <select
                  id={`review-account-${period}`}
                  className={cx(selectCompact, 'w-auto max-w-[16rem]')}
                  value={account}
                  onChange={(e) => onAccountChange?.(e.target.value)}
                >
                  <option value="">All accounts ({allItems.length})</option>
                  {accountCounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label} ({a.count})
                    </option>
                  ))}
                </select>
              </>
            )}
            {items.length > 0 && (
              <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-2">
                <input
                  type="checkbox"
                  className={checkboxBase}
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={closed}
                  aria-label="Select all pending transactions"
                />
                Select all
              </label>
            )}
            {selectedCount > 0 && <span className="text-xs text-ink-3 tabular">{selectedCount} selected</span>}
            <button
              type="button"
              className={cx(btnPrimary, btnSmall)}
              onClick={approveSelected}
              disabled={closed || selectedCount === 0}
              title={closed ? 'This period is closed' : undefined}
            >
              Approve selected{selectedCount > 0 ? ` (${selectedCount})` : ''}
            </button>
          </div>
        </div>
      </header>

      {hasNotices && (
        <div className="space-y-3 px-5 pt-4 sm:px-6">
          {queue.error && <ErrorMessage message={queue.error.message} onRetry={queue.reload} />}
          <ErrorMessage message={batchError} onDismiss={() => setBatchError(null)} />
          {closed && items.length > 0 && (
            <Notice tone="neutral" role="status" icon={Lock}>
              This period is closed, so nothing here can be approved. Reopen the period to review these transactions.
            </Notice>
          )}
        </div>
      )}
      {!queue.data && !queue.error && (
        <div className="px-5 py-5 sm:px-6">
          <LoadingState label="Loading queue" rows={4} />
        </div>
      )}
      {queue.data && items.length === 0 && account && allItems.length > 0 && (
        <EmptyState
          icon={ListChecks}
          title={`Nothing waiting on ${accountName}.`}
          hint={`${plural(allItems.length, 'line')} from other accounts still ${allItems.length === 1 ? 'waits' : 'wait'} this month.`}
          action={
            <button type="button" className={btnSecondary} onClick={() => onAccountChange?.('')}>
              Show all accounts
            </button>
          }
        />
      )}
      {queue.data && items.length === 0 && !(account && allItems.length > 0) && (
        <EmptyState icon={ListChecks} title="Nothing to review. All caught up." hint="New statement lines land here for a quick check." />
      )}
      {items.length > 0 && (
        // relative: the rows' screen-reader-only labels are absolutely positioned, so without a
        // positioned scroller they escape its clip at their static position and widen the page on a phone.
        <div className="relative overflow-x-auto pt-1">
          {/* Scroll margin on the row controls so the sticky batch bar (and the mobile top bar) never covers a focused one. */}
          <table
            className={cx(
              tableBase,
              tableFlush,
              '[&_:is(input,select,button,a)]:scroll-mt-44 md:[&_:is(input,select,button,a)]:scroll-mt-24',
            )}
          >
            <thead className="sr-only">
              <tr>
                <th scope="col">Select</th>
                <th scope="col">Transaction</th>
                <th scope="col">Amount</th>
                <th scope="col">Category and claim type</th>
                <th scope="col">Transfer</th>
                <th scope="col">Source</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {items.map((tx) => (
                <ApprovalRow
                  key={tx.id}
                  transaction={tx}
                  draft={drafts[tx.id] ?? NO_DRAFT}
                  onDraftChange={(draft) => setDraft(tx.id, draft)}
                  selected={selected.has(tx.id)}
                  busy={busy.has(tx.id)}
                  disabled={closed}
                  error={rowErrors[tx.id]}
                  onToggle={() => toggle(tx.id)}
                  onApprove={(corrections) => approveOne(tx, corrections)}
                  onSplit={() => setSplitting(tx)}
                  onTransferChange={(on) => markTransfer(tx, on)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {splitting && (
        <SplitDialog
          transaction={splitting}
          defaults={drafts[splitting.id]}
          onClose={() => setSplitting(null)}
          onSaved={splitSaved}
        />
      )}
    </section>
  );
}
