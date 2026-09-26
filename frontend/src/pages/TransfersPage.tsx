import { ArrowLeftRight, Link2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage, type TransferBufferOut } from '../api';
import { Card } from '../components/Card';
import { ErrorMessage } from '../components/ErrorMessage';
import { LoadingState } from '../components/LoadingState';
import { Notice } from '../components/Notice';
import { PageHeader } from '../components/PageHeader';
import { TransferTable } from '../components/TransferTable';
import { useCurrency } from '../config/ConfigContext';
import { useAsync } from '../hooks/useAsync';
import { plural } from '../lib/format';
import { formatMoney } from '../lib/money';
import { amountsCancelOut } from '../lib/transfers';
import { btnPrimary, btnSecondary, btnSmall, cx } from '../lib/ui';

interface Mismatch {
  a: TransferBufferOut;
  b: TransferBufferOut;
}

export function TransfersPage() {
  const symbol = useCurrency();
  const unmatched = useAsync(() => api.listUnmatchedTransfers(), 'transfers:unmatched');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [mismatch, setMismatch] = useState<Mismatch | null>(null);

  function setBusyFor(ids: string[], on: boolean) {
    setBusy((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });
  }

  function dropRows(ids: string[]) {
    const remove = new Set(ids);
    unmatched.setData((prev) => (prev ? prev.filter((r) => !remove.has(r.id)) : prev));
    setSelected((prev) => prev.filter((id) => !remove.has(id)));
  }

  async function rematch() {
    setWorking(true);
    setPageError(null);
    setNotice(null);
    try {
      const res = await api.rematchTransfers();
      setNotice(`${plural(res.matched, 'pair')} matched automatically.`);
      unmatched.reload();
    } catch (err) {
      setPageError(errorMessage(err));
    } finally {
      setWorking(false);
    }
  }

  async function ignore(row: TransferBufferOut) {
    setBusyFor([row.id], true);
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[row.id];
      return next;
    });
    try {
      await api.ignoreTransfer(row.id);
      dropRows([row.id]);
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [row.id]: errorMessage(err) }));
    } finally {
      setBusyFor([row.id], false);
    }
  }

  async function performMatch(a: string, b: string) {
    setMismatch(null);
    setWorking(true);
    setPageError(null);
    setNotice(null);
    setBusyFor([a, b], true);
    try {
      await api.matchTransfers(a, b);
      dropRows([a, b]);
      setNotice('The two entries were linked as one transfer.');
    } catch (err) {
      setPageError(errorMessage(err));
    } finally {
      setBusyFor([a, b], false);
      setWorking(false);
    }
  }

  function matchSelected() {
    if (selected.length !== 2) return;
    const [a, b] = selected;
    const rowA = unmatched.data?.find((r) => r.id === a);
    const rowB = unmatched.data?.find((r) => r.id === b);
    if (rowA && rowB && !amountsCancelOut(rowA, rowB)) {
      setMismatch({ a: rowA, b: rowB });
      return;
    }
    void performMatch(a, b);
  }

  function toggle(id: string) {
    setMismatch(null);
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= 2 ? prev : [...prev, id]));
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transfers"
        description="Card payments that should appear on both a current account and a card statement. Match two rows by hand when the automatic window misses them."
        actions={
          <>
            <button type="button" className={btnSecondary} onClick={rematch} disabled={working}>
              <RefreshCw className={cx('h-4 w-4', working && 'animate-spin')} aria-hidden="true" />
              Rematch
            </button>
            <button
              type="button"
              className={btnPrimary}
              onClick={matchSelected}
              disabled={working || selected.length !== 2}
            >
              <Link2 className="h-4 w-4" aria-hidden="true" />
              Match selected{selected.length > 0 ? ` (${selected.length}/2)` : ''}
            </button>
          </>
        }
      />
      {notice && (
        <Notice tone="good" role="status">
          {notice}
        </Notice>
      )}
      {mismatch && (
        <Notice
          tone="warning"
          role="alertdialog"
          aria-label="Amounts differ"
          actions={
            <>
              <button
                type="button"
                className={cx(btnPrimary, btnSmall)}
                onClick={() => performMatch(mismatch.a.id, mismatch.b.id)}
                disabled={working}
              >
                Match anyway
              </button>
              <button type="button" className={cx(btnSecondary, btnSmall)} onClick={() => setMismatch(null)}>
                Cancel
              </button>
            </>
          }
        >
          Amounts differ: {formatMoney(mismatch.a.amount, symbol)} and {formatMoney(mismatch.b.amount, symbol)} do not
          cancel out. Match anyway?
        </Notice>
      )}
      <ErrorMessage message={pageError} onDismiss={() => setPageError(null)} />
      <Card
        flush
        icon={ArrowLeftRight}
        title="Unmatched buffer"
        description={
          unmatched.data
            ? `${plural(unmatched.data.length, 'entry', 'entries')} · select two rows to match them by hand`
            : undefined
        }
        actions={unmatched.loading && <LoadingState inline />}
      >
        {unmatched.error && (
          <div className="p-5 sm:p-6">
            <ErrorMessage message={unmatched.error.message} onRetry={unmatched.reload} />
          </div>
        )}
        {!unmatched.data && !unmatched.error && (
          <div className="px-5 py-5 sm:px-6">
            <LoadingState rows={4} />
          </div>
        )}
        {unmatched.data && (
          <TransferTable
            rows={unmatched.data}
            selected={selected}
            busy={busy}
            errors={rowErrors}
            onToggle={toggle}
            onIgnore={ignore}
          />
        )}
      </Card>
    </div>
  );
}
