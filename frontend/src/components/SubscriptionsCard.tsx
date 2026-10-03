import { Repeat } from 'lucide-react';
import { useState } from 'react';
import { api, type SubscriptionOut } from '../api';
import { useCurrency } from '../config/ConfigContext';
import { useAsync } from '../hooks/useAsync';
import { formatDate, periodLabel } from '../lib/dates';
import { plural } from '../lib/format';
import { formatMoney } from '../lib/money';
import { btnGhost, btnSmall, cx } from '../lib/ui';
import { Badge } from './Badge';
import { Card } from './Card';
import { ErrorMessage } from './ErrorMessage';
import { LoadingState } from './LoadingState';
import { MerchantAvatar } from './MerchantAvatar';
import { MoneyText } from './MoneyText';

interface Props {
  refreshKey?: number;
}

/** How many subscriptions show before "Show all". */
export const TOP_SUBSCRIPTIONS = 6;

/** "went from £10.99 to £12.99 in September 2026" */
export function changePhrase(change: NonNullable<SubscriptionOut['change']>, symbol: string): string {
  return `went from ${formatMoney(change.from, symbol)} to ${formatMoney(change.to, symbol)} in ${periodLabel(change.month)}`;
}

/** Recurring payments found from the ledger (no AI): monthly cost, next expected date, price changes, new and stopped. */
export function SubscriptionsCard({ refreshKey = 0 }: Props) {
  const symbol = useCurrency();
  const subs = useAsync(() => api.getSubscriptions(), `subscriptions:${refreshKey}`);
  const [showAll, setShowAll] = useState(false);
  const data = subs.data;
  const items = data?.items ?? [];
  const visible = showAll ? items : items.slice(0, TOP_SUBSCRIPTIONS);
  const running = items.filter((s) => s.status !== 'stopped').length;

  return (
    <Card
      icon={Repeat}
      title="Subscriptions"
      description={
        data ? (running ? `${plural(running, 'regular payment')}, about ${formatMoney(data.total_monthly, symbol)} a month` : 'Regular payments, found from your statements') : undefined
      }
      actions={subs.loading && <LoadingState inline />}
    >
      {subs.error && <ErrorMessage message={subs.error.message} onRetry={subs.reload} />}
      {!data && !subs.error && <LoadingState label="Looking for regular payments" rows={3} />}
      {data && items.length === 0 && (
        <p className="text-sm text-ink-2">Nothing regular yet. A merchant charged every month or year for a similar amount shows up here.</p>
      )}
      {data && items.length > 0 && (
        <ul className="divide-y divide-hairline" aria-label="Subscriptions">
          {visible.map((sub) => (
            <li key={`${sub.merchant}-${sub.cadence}`} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
              <MerchantAvatar name={sub.merchant} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p className={cx('truncate text-sm font-medium', sub.status === 'stopped' ? 'text-ink-3' : 'text-ink')}>{sub.merchant}</p>
                  {sub.status === 'new' && (
                    <Badge tone="green" dot>
                      New
                    </Badge>
                  )}
                  {sub.status === 'stopped' && (
                    <Badge tone="neutral" dot>
                      Stopped
                    </Badge>
                  )}
                  {/* The phrase is long for a phone: there it wraps inside a rounded block instead of clipping. */}
                  {sub.change && (
                    <Badge tone="amber" dot className="max-w-full !whitespace-normal rounded-lg" title={`${sub.merchant} ${changePhrase(sub.change, symbol)}`}>
                      {changePhrase(sub.change, symbol)}
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-ink-3">
                  {sub.cadence === 'yearly' ? `${formatMoney(sub.amount, symbol)} a year` : 'Monthly'}
                  {sub.status === 'stopped' ? ` · last seen ${formatDate(sub.last_date)}` : ` · next ${formatDate(sub.next_expected)}`}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <MoneyText value={sub.monthly_cost} className={cx('text-sm font-semibold', sub.status === 'stopped' ? 'text-ink-3' : 'text-ink')} />
                <p className="text-xs text-ink-3">a month</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {items.length > TOP_SUBSCRIPTIONS && (
        <button type="button" className={cx(btnGhost, btnSmall, '-ml-2.5 mt-3')} onClick={() => setShowAll((v) => !v)}>
          {showAll ? `Show top ${TOP_SUBSCRIPTIONS}` : `Show all ${items.length}`}
        </button>
      )}
    </Card>
  );
}
