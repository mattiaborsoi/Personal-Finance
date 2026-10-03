import { PiggyBank } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useConfig } from '../config/ConfigContext';
import { useAsync } from '../hooks/useAsync';
import { accountLabel } from '../lib/format';
import { cx, linkBase, tableBase, tdBase, thBase, trHover } from '../lib/ui';
import { Card } from './Card';
import { ErrorMessage } from './ErrorMessage';
import { LoadingState } from './LoadingState';
import { MoneyText } from './MoneyText';
import { StatTile } from './StatTile';
import { TableScroller } from './TableScroller';

interface Props {
  refreshKey?: number;
}

/**
 * Lifetime money in and out of the investment accounts. Deposits and
 * withdrawals are magnitudes; net invested capital and realised gain are
 * signed, and only the gain is coloured because only it can reasonably go
 * either way. One account collapses to a single line; none to a quiet note.
 */
export function InvestmentCard({ refreshKey = 0 }: Props) {
  const config = useConfig();
  const investment = useAsync(() => api.getInvestmentMetrics(), `investment:${refreshKey}`);
  const data = investment.data;
  const single = data && data.accounts.length === 1 ? data.accounts[0] : null;

  return (
    <Card
      icon={PiggyBank}
      title="Investments"
      description={single ? `${accountLabel(config.accounts, single.account_id)} · all time` : 'All time, across investment accounts'}
      actions={investment.loading && <LoadingState inline />}
    >
      {investment.error && <ErrorMessage message={investment.error.message} onRetry={investment.reload} />}
      {!data && !investment.error && <LoadingState label="Loading investments" rows={2} />}
      {data && data.accounts.length === 0 && (
        <p className="text-sm text-ink-2" data-testid="no-investments">
          No investment accounts yet. Add one with the type Investment under{' '}
          <Link to="/settings?tab=accounts" className={linkBase}>
            Settings, Accounts
          </Link>{' '}
          and transfers to it are tracked here.
        </p>
      )}
      {single && (
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="investment-single">
          <StatTile as="dl-item" label="Deposits" value={<MoneyText value={single.total_deposits} />} />
          <StatTile as="dl-item" label="Withdrawals" value={<MoneyText value={single.total_withdrawals} />} />
          <StatTile as="dl-item" label="Net invested" value={<MoneyText value={single.net_invested_capital} />} />
          <StatTile as="dl-item" label="Realised gain" value={<MoneyText value={single.realized_gain} tone signed />} />
        </dl>
      )}
      {data && data.accounts.length > 1 && (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile as="dl-item" label="Deposits" value={<MoneyText value={data.total_deposits} />} />
            <StatTile as="dl-item" label="Withdrawals" value={<MoneyText value={data.total_withdrawals} />} />
            <StatTile as="dl-item" label="Net invested" value={<MoneyText value={data.net_invested_capital} />} />
            <StatTile as="dl-item" label="Realised gain" value={<MoneyText value={data.realized_gain} tone signed />} />
          </dl>
          <TableScroller className="rounded-xl border border-hairline p-px">
            <table className={cx(tableBase, 'tabular')}>
              <thead>
                <tr>
                  <th scope="col" className={thBase}>
                    Account
                  </th>
                  <th scope="col" className={cx(thBase, 'text-right')}>
                    Deposits
                  </th>
                  <th scope="col" className={cx(thBase, 'text-right')}>
                    Withdrawals
                  </th>
                  <th scope="col" className={cx(thBase, 'text-right')}>
                    Net invested
                  </th>
                  <th scope="col" className={cx(thBase, 'text-right')}>
                    Realised gain
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {data.accounts.map((row) => (
                  <tr key={row.account_id} className={trHover}>
                    <td className={cx(tdBase, 'whitespace-nowrap font-medium')}>{accountLabel(config.accounts, row.account_id)}</td>
                    <td className={cx(tdBase, 'text-right text-ink-2')}>
                      <MoneyText value={row.total_deposits} />
                    </td>
                    <td className={cx(tdBase, 'text-right text-ink-2')}>
                      <MoneyText value={row.total_withdrawals} />
                    </td>
                    <td className={cx(tdBase, 'text-right font-medium')}>
                      <MoneyText value={row.net_invested_capital} />
                    </td>
                    <td className={cx(tdBase, 'text-right font-medium')}>
                      <MoneyText value={row.realized_gain} tone signed />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-hairline bg-surface-2 font-semibold text-ink">
                  <th scope="row" className={cx(tdBase, 'text-left')}>
                    Total
                  </th>
                  <td className={cx(tdBase, 'text-right')}>
                    <MoneyText value={data.total_deposits} />
                  </td>
                  <td className={cx(tdBase, 'text-right')}>
                    <MoneyText value={data.total_withdrawals} />
                  </td>
                  <td className={cx(tdBase, 'text-right')}>
                    <MoneyText value={data.net_invested_capital} />
                  </td>
                  <td className={cx(tdBase, 'text-right')}>
                    <MoneyText value={data.realized_gain} tone signed />
                  </td>
                </tr>
              </tfoot>
            </table>
          </TableScroller>
        </div>
      )}
    </Card>
  );
}
