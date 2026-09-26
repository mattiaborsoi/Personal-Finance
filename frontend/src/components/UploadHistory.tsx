import { FileText, Upload } from 'lucide-react';
import type { StatementOut } from '../api';
import { useConfig } from '../config/ConfigContext';
import { formatDateTime, periodLabel } from '../lib/dates';
import { accountLabel } from '../lib/format';
import { chipSoft, cx, tableBase, tableFlush, tdBase, thBase, trHover } from '../lib/ui';
import { Badge } from './Badge';
import { EmptyState } from './EmptyState';

interface Props {
  statements: StatementOut[];
}

/** Table of previous uploads; designed to sit inside `<Card flush>`. */
export function UploadHistory({ statements }: Props) {
  const config = useConfig();
  if (statements.length === 0) {
    return <EmptyState icon={Upload} title="No statements uploaded yet" hint="Your first import will show up here." />;
  }
  return (
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
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {statements.map((s) => (
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
              <td className={cx(tdBase, 'whitespace-nowrap text-ink-2')}>{periodLabel(s.period_key)}</td>
              <td className={tdBase}>
                <Badge tone="neutral">{s.parser}</Badge>
              </td>
              <td className={cx(tdBase, 'text-right tabular')}>{s.transaction_count}</td>
              <td className={cx(tdBase, 'whitespace-nowrap text-right text-ink-3')}>{formatDateTime(s.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
