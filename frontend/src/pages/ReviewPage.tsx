import { ListChecks, Upload } from 'lucide-react';
import { Fragment } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type PeriodOut } from '../api';
import { ApprovalQueue } from '../components/ApprovalQueue';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { ClosePeriodButton } from '../components/ClosePeriodButton';
import { EmptyState } from '../components/EmptyState';
import { ErrorMessage } from '../components/ErrorMessage';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { PeriodSelector } from '../components/PeriodSelector';
import { useSharePeriods } from '../hooks/reviewBadge';
import { useAsync } from '../hooks/useAsync';
import { isPeriodKey, monthName, periodLabel } from '../lib/dates';
import { plural } from '../lib/format';
import { pendingMonths, reviewDefaultPeriod, reviewPath, type PendingMonth } from '../lib/review';
import { btnPrimary, linkBase } from '../lib/ui';

/**
 * In place of the queue when the month on show has nothing waiting but other
 * months do: says where the lines are and links to each, so the page never
 * reads "all caught up" while anything is pending.
 */
function PendingElsewhere({ period, months }: { period: string; months: PendingMonth[] }) {
  const oldest = months[0];
  return (
    <Card>
      <EmptyState
        icon={ListChecks}
        title={`Nothing waiting in ${monthName(period)}.`}
        hint={
          <p>
            {months.map((m, i) => (
              <Fragment key={m.period}>
                {i === 0 ? '' : i === months.length - 1 ? ' and ' : ', '}
                {i === 0 ? `${plural(m.count, 'line')} ${m.count === 1 ? 'waits' : 'wait'} in ` : `${m.count} in `}
                <Link to={reviewPath(m.period)} className={linkBase}>
                  {monthName(m.period)}
                </Link>
              </Fragment>
            ))}
            .
          </p>
        }
        action={
          <Link to={reviewPath(oldest.period)} className={btnPrimary}>
            <ListChecks className="h-4 w-4" aria-hidden="true" />
            {`Review ${monthName(oldest.period)}`}
          </Link>
        }
      />
    </Card>
  );
}

/** Months other than `period` with lines waiting, oldest first. */
function pendingElsewhere(periods: PeriodOut[] | null, period: string | null): PendingMonth[] {
  return pendingMonths(periods).filter((m) => m.period !== period);
}

/** The approval queue on its own page, on the same `?period=YYYY-MM` the dashboard uses. */
export function ReviewPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const periods = useAsync(() => api.listPeriods(), 'periods');
  useSharePeriods(periods.data);

  const requested = searchParams.get('period');
  const period =
    requested && isPeriodKey(requested) ? requested : periods.data ? reviewDefaultPeriod(periods.data) : null;
  const periodInfo = periods.data?.find((p) => p.period_key === period) ?? null;
  const closed = periodInfo?.is_closed ?? false;
  // Nothing waits in this month but lines wait in others: point at them instead of an "all caught up" queue.
  const elsewhere = (periodInfo?.pending_review_count ?? 0) === 0 ? pendingElsewhere(periods.data, period) : [];

  const account = searchParams.get('account') ?? '';

  // The account filter carries over to another month; the month is kept when the account changes.
  function changePeriod(next: string) {
    setSearchParams({ ...(next ? { period: next } : {}), ...(account ? { account } : {}) });
  }

  function changeAccount(next: string) {
    setSearchParams({ ...(requested ? { period: requested } : {}), ...(next ? { account: next } : {}) }, { replace: true });
  }

  return (
    // min-w-0: the queue's table scrolls inside its card instead of widening the page on a phone.
    <div className="min-w-0 space-y-6">
      <PageHeader
        title="Review"
        description={period ? periodLabel(period) : undefined}
        actions={
          period && (
            <>
              {closed && (
                <Badge tone="neutral" dot>
                  Closed
                </Badge>
              )}
              <ClosePeriodButton period={periodInfo} periodKey={period} onChanged={periods.reload} />
            </>
          )
        }
      />

      {periods.error && <ErrorMessage message={periods.error.message} onRetry={periods.reload} />}
      {!periods.data && !periods.error && <LoadingState label="Loading periods" />}
      {periods.data && <PeriodSelector periods={periods.data} value={period} onChange={changePeriod} />}

      {periods.data && !period && (
        <Card>
          <EmptyState
            icon={Upload}
            title="No periods yet"
            hint="Upload a statement and its new lines will wait here for a quick check."
            action={
              <Link to="/upload" className={btnPrimary}>
                <Upload className="h-4 w-4" aria-hidden="true" />
                Upload a statement
              </Link>
            }
          />
        </Card>
      )}

      {/* Keyed on the period so a selection or an unsaved choice never carries over to another month. */}
      {period && elsewhere.length > 0 && <PendingElsewhere period={period} months={elsewhere} />}
      {/* Waits for the periods (unless they fail), so an empty queue never shows while other months have lines. */}
      {period && (periods.data || periods.error) && elsewhere.length === 0 && (
        <ApprovalQueue
          key={period}
          period={period}
          closed={closed}
          onChanged={periods.reload}
          account={account}
          onAccountChange={changeAccount}
        />
      )}
    </div>
  );
}
