import { Filter, Lock, Receipt } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  api,
  editErrorMessage,
  type ReviewStatus,
  type TransactionOut,
  type TransactionPart,
  type TransactionPatch,
} from '../api';
import { AskBox } from '../components/AskBox';
import { Card } from '../components/Card';
import { ErrorMessage } from '../components/ErrorMessage';
import { LoadingState } from '../components/LoadingState';
import { Notice } from '../components/Notice';
import { PageHeader } from '../components/PageHeader';
import { Pagination } from '../components/Pagination';
import { SplitDialog } from '../components/SplitDialog';
import { TransactionFilters, type TransactionFilterValues } from '../components/TransactionFilters';
import { TransactionTable } from '../components/TransactionTable';
import { ClaimTypeHelp } from '../components/ClaimTypeHelp';
import { useAsync } from '../hooks/useAsync';
import { periodLabel } from '../lib/dates';
import { plural } from '../lib/format';
import { mergePartUpdate } from '../lib/splits';

const PAGE_SIZE = 50;
const STATUSES: ReviewStatus[] = ['pending_review', 'auto_approved', 'manual_approved'];

function readFilters(params: URLSearchParams): TransactionFilterValues & { offset: number } {
  const status = params.get('status') ?? '';
  return {
    period: params.get('period') ?? '',
    status: STATUSES.includes(status as ReviewStatus) ? (status as ReviewStatus) : '',
    account_id: params.get('account_id') ?? '',
    category: params.get('category') ?? '',
    q: params.get('q') ?? '',
    include_transfers: params.get('include_transfers') !== 'false',
    unusual: params.get('unusual') === 'true',
    offset: Math.max(0, Number(params.get('offset') ?? 0) || 0),
  };
}

export function TransactionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = readFilters(searchParams);
  const periods = useAsync(() => api.listPeriods(), 'periods');
  const list = useAsync(
    () =>
      api.listTransactions({
        period: filters.period || undefined,
        status: filters.status || undefined,
        account_id: filters.account_id || undefined,
        category: filters.category || undefined,
        q: filters.q || undefined,
        include_transfers: filters.include_transfers,
        unusual: filters.unusual || undefined,
        limit: PAGE_SIZE,
        offset: filters.offset,
      }),
    `transactions:${searchParams.toString()}`,
  );
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  /** The transaction whose split dialog is open. */
  const [splitting, setSplitting] = useState<TransactionOut | null>(null);

  const closedPeriods = new Set((periods.data ?? []).filter((p) => p.is_closed).map((p) => p.period_key));
  const filteredPeriodClosed = filters.period !== '' && closedPeriods.has(filters.period);

  function writeFilters(next: TransactionFilterValues, offset = 0) {
    const params: Record<string, string> = {};
    if (next.period) params.period = next.period;
    if (next.status) params.status = next.status;
    if (next.account_id) params.account_id = next.account_id;
    if (next.category) params.category = next.category;
    if (next.q) params.q = next.q;
    if (!next.include_transfers) params.include_transfers = 'false';
    if (next.unusual) params.unusual = 'true';
    if (offset > 0) params.offset = String(offset);
    setSearchParams(params);
  }

  function setRowError(id: string, message: string | null) {
    setRowErrors((prev) => {
      const next = { ...prev };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });
  }

  async function patch(tx: TransactionOut, change: TransactionPatch) {
    setRowError(tx.id, null);
    try {
      const updated = await api.patchTransaction(tx.id, change);
      // A row that just became a transfer no longer matches a list that hides transfers.
      const hidden = updated.is_internal_transfer && !filters.include_transfers;
      list.setData((prev) => {
        if (!prev) return prev;
        if (hidden) return { items: prev.items.filter((t) => t.id !== tx.id), total: prev.total - 1 };
        return { ...prev, items: prev.items.map((t) => (t.id === tx.id ? updated : t)) };
      });
    } catch (err) {
      setRowError(tx.id, editErrorMessage(err));
    }
  }

  async function remove(tx: TransactionOut) {
    setRowError(tx.id, null);
    try {
      await api.deleteTransaction(tx.id);
      list.setData((prev) =>
        prev ? { items: prev.items.filter((t) => t.id !== tx.id), total: prev.total - 1 } : prev,
      );
    } catch (err) {
      setRowError(tx.id, editErrorMessage(err));
    }
  }

  function replaceRow(updated: TransactionOut) {
    list.setData((prev) => (prev ? { ...prev, items: prev.items.map((t) => (t.id === updated.id ? updated : t)) } : prev));
  }

  function splitSaved(parent: TransactionOut) {
    setRowError(parent.id, null);
    replaceRow(parent);
    setSplitting(null);
  }

  async function unsplit(tx: TransactionOut) {
    setRowError(tx.id, null);
    try {
      replaceRow(await api.unsplitTransaction(tx.id));
    } catch (err) {
      setRowError(tx.id, editErrorMessage(err));
    }
  }

  async function patchPart(tx: TransactionOut, part: TransactionPart, change: TransactionPatch) {
    setRowError(part.id, null);
    try {
      const updated = await api.patchTransaction(part.id, change);
      list.setData((prev) =>
        prev ? { ...prev, items: prev.items.map((t) => (t.id === tx.id ? mergePartUpdate(t, part.id, updated) : t)) } : prev,
      );
    } catch (err) {
      setRowError(part.id, editErrorMessage(err));
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transactions"
        description={list.data ? `${plural(list.data.total, 'transaction')} match` : undefined}
      />
      <AskBox />
      <Card icon={Filter} title="Filters">
        <TransactionFilters periods={periods.data ?? []} values={filters} onChange={(v) => writeFilters(v, 0)} />
      </Card>
      <Card flush icon={Receipt} title="Results" actions={list.loading && <LoadingState inline />}>
        {filteredPeriodClosed && (
          <div className="px-5 pt-4 sm:px-6">
            <Notice tone="neutral" role="status" icon={Lock}>
              {periodLabel(filters.period)} is closed, so its transactions are read-only. Reopen the period from the
              dashboard to make changes.
            </Notice>
          </div>
        )}
        {list.error && (
          <div className="p-5 sm:p-6">
            <ErrorMessage message={list.error.message} onRetry={list.reload} />
          </div>
        )}
        {!list.data && !list.error && (
          <div className="px-5 py-5 sm:px-6">
            <LoadingState label="Loading transactions" rows={6} />
          </div>
        )}
        {list.data && (
          <>
            {list.data.items.length > 0 && <ClaimTypeHelp className="px-5 pt-3 sm:px-6" />}
            <TransactionTable
              items={list.data.items}
              errors={rowErrors}
              closedPeriods={closedPeriods}
              onPatch={patch}
              onDelete={remove}
              onSplit={setSplitting}
              onUnsplit={unsplit}
              onPatchPart={patchPart}
            />
            {list.data.total > 0 && (
              <div className="border-t border-hairline px-5 py-3 sm:px-6">
                <Pagination
                  total={list.data.total}
                  limit={PAGE_SIZE}
                  offset={filters.offset}
                  onChange={(offset) => writeFilters(filters, offset)}
                />
              </div>
            )}
          </>
        )}
      </Card>
      {splitting && <SplitDialog transaction={splitting} onClose={() => setSplitting(null)} onSaved={splitSaved} />}
    </div>
  );
}
