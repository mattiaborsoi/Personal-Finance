import { FileText, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage, isApiError, type StatementOut } from '../api';
import { useConfig } from '../config/ConfigContext';
import { formatDateTime, periodRangeLabel } from '../lib/dates';
import { accountLabel, plural } from '../lib/format';
import { chipSoft, cx, tableBase, tableFlush, tdBase, thBase, trHover } from '../lib/ui';
import { Badge } from './Badge';
import { ConfirmButton } from './ConfirmButton';
import { EmptyState } from './EmptyState';
import { ErrorMessage } from './ErrorMessage';
import { Notice } from './Notice';

interface Props {
  statements: StatementOut[];
  /** Called with the upload's id once it has been deleted (or turned out to be gone already). */
  onDeleted?: (id: string) => void;
}

/** Why Delete is off for an upload the server marks `deletable: false`. */
export const NOT_DELETABLE_TITLE =
  'Uploaded before lines were linked to uploads, and another upload has the same file name, so its lines cannot be told apart. Delete them from the Transactions page instead.';

function confirmQuestion(lines: number): string {
  return lines === 0
    ? 'Delete this upload? It added no lines.'
    : `Delete this upload and the ${plural(lines, 'line')} it added?`;
}

/** Table of previous uploads, each with a confirmed Delete; designed to sit inside `<Card flush>`. */
export function UploadHistory({ statements, onDeleted }: Props) {
  const config = useConfig();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Deleted here: hidden at once rather than when the refreshed list arrives. */
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());

  async function remove(s: StatementOut) {
    setError(null);
    setNotice(null);
    try {
      await api.deleteStatement(s.id);
    } catch (err) {
      // A 404 means it is gone already; refreshing the list is all that is left to do.
      if (!isApiError(err, 404)) {
        setError(`${s.filename} was not deleted: ${errorMessage(err)}`);
        return;
      }
    }
    setGone((prev) => new Set(prev).add(s.id));
    setNotice(
      s.transaction_count > 0
        ? `Deleted ${s.filename} and the ${plural(s.transaction_count, 'line')} it added. You can upload it again.`
        : `Deleted ${s.filename}. You can upload it again.`,
    );
    onDeleted?.(s.id);
  }

  const rows = statements.filter((s) => !gone.has(s.id));
  const messages = (error || notice) && (
    <div className="space-y-3 px-5 pt-4 sm:px-6">
      <ErrorMessage message={error} onDismiss={() => setError(null)} />
      {notice && (
        <Notice tone="good" role="status">
          {notice}
        </Notice>
      )}
    </div>
  );

  if (rows.length === 0) {
    return (
      <>
        {messages}
        <EmptyState icon={Upload} title="No statements uploaded yet" hint="Your first import will show up here." />
      </>
    );
  }
  return (
    <>
      {messages}
      <div className="overflow-x-auto">
        <table className={cx(tableBase, tableFlush)}>
          <thead>
            <tr>
              <th scope="col" className={thBase}>
                File
              </th>
              <th scope="col" className={thBase}>
                Account
              </th>
              <th scope="col" className={thBase}>
                Period
              </th>
              <th scope="col" className={thBase}>
                Parser
              </th>
              <th scope="col" className={cx(thBase, 'text-right')}>
                Rows
              </th>
              <th scope="col" className={cx(thBase, 'text-right')}>
                Uploaded
              </th>
              <th scope="col" className={thBase}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {rows.map((s) => (
              <tr key={String(s.id)} className={trHover}>
                <td className={tdBase}>
                  <span className="flex items-center gap-2.5">
                    <span
                      aria-hidden="true"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-2"
                    >
                      <FileText className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 break-all font-medium text-ink" title={s.sha256}>
                      {s.filename}
                    </span>
                  </span>
                </td>
                <td className={tdBase}>
                  <span className={chipSoft}>{accountLabel(config.accounts, s.account_id)}</span>
                </td>
                <td className={cx(tdBase, 'whitespace-nowrap text-ink-2')}>
                  {periodRangeLabel(s.period_from, s.period_to, s.period_key)}
                </td>
                <td className={tdBase}>
                  <Badge tone="neutral">{s.parser}</Badge>
                </td>
                <td className={cx(tdBase, 'text-right tabular')}>{s.transaction_count}</td>
                <td className={cx(tdBase, 'whitespace-nowrap text-right text-ink-3')}>{formatDateTime(s.created_at)}</td>
                <td className={cx(tdBase, 'whitespace-nowrap py-2.5 text-right')}>
                  <ConfirmButton
                    confirmLabel={confirmQuestion(s.transaction_count)}
                    onConfirm={() => remove(s)}
                    tone="danger"
                    icon={Trash2}
                    iconOnly
                    ariaLabel={`Delete upload ${s.filename}`}
                    disabled={!s.deletable}
                    title={s.deletable ? 'Delete this upload and its lines' : NOT_DELETABLE_TITLE}
                  >
                    Delete
                  </ConfirmButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
