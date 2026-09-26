import type { SettlementLine } from '../api';
import { useConfig, useNames } from '../config/ConfigContext';
import { formatDate } from '../lib/dates';
import { claimTypeLabel } from '../lib/format';
import { cx, tableBase, tdBase, thBase, trHover } from '../lib/ui';
import { Badge } from './Badge';
import { EmptyState } from './EmptyState';
import { InitialsChip } from './InitialsChip';
import { MoneyText } from './MoneyText';

interface Props {
  lines: SettlementLine[];
}

const SOURCE_LABELS: Record<string, string> = { claim: 'Claim', transaction: 'Transaction' };

export function SettlementLines({ lines }: Props) {
  const config = useConfig();
  const names = useNames();
  if (lines.length === 0) return <EmptyState title="No settlement lines this period" />;

  const userName = (id: string) =>
    id === config.users.primary.id ? names.primary : id === config.users.secondary.id ? names.secondary : id;

  return (
    <div>
      <div className="overflow-x-auto rounded-xl border border-hairline">
        <table className={cx(tableBase, 'tabular')}>
          <thead>
            <tr>
              <th scope="col" className={thBase}>
                Date
              </th>
              <th scope="col" className={thBase}>
                Merchant
              </th>
              <th scope="col" className={thBase}>
                Paid by
              </th>
              <th scope="col" className={thBase}>
                Split
              </th>
              <th scope="col" className={cx(thBase, 'text-right')}>
                Amount
              </th>
              <th scope="col" className={cx(thBase, 'text-right')}>
                {names.primary}
              </th>
              <th scope="col" className={cx(thBase, 'text-right')}>
                {names.secondary}
              </th>
              <th scope="col" className={cx(thBase, 'text-right')}>
                Effect
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {lines.map((line) => (
              <tr key={`${line.source}-${line.id}`} className={trHover}>
                <td className={cx(tdBase, 'whitespace-nowrap text-ink-3')}>{formatDate(line.date)}</td>
                <td className={tdBase}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{line.merchant}</span>
                    <Badge tone="neutral">{SOURCE_LABELS[line.source] ?? line.source}</Badge>
                  </span>
                </td>
                <td className={cx(tdBase, 'whitespace-nowrap')}>
                  <span className="flex items-center gap-2 text-ink-2">
                    <InitialsChip name={userName(line.paid_by)} />
                    {userName(line.paid_by)}
                  </span>
                </td>
                <td className={cx(tdBase, 'whitespace-nowrap text-ink-2')}>{claimTypeLabel(line.claim_type, names)}</td>
                <td className={cx(tdBase, 'text-right')}>
                  <MoneyText value={line.amount} />
                </td>
                <td className={cx(tdBase, 'text-right text-ink-2')}>
                  <MoneyText value={line.primary_share} />
                </td>
                <td className={cx(tdBase, 'text-right text-ink-2')}>
                  <MoneyText value={line.secondary_share} />
                </td>
                <td className={cx(tdBase, 'text-right font-semibold')}>
                  <MoneyText value={line.effect_on_secondary_owes} signed tone />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-3">
        Effect is the change to what {names.secondary} owes: positive increases it, negative reduces it.
      </p>
    </div>
  );
}
