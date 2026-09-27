import { Upload } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
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
import { defaultPeriodKey, isPeriodKey, periodLabel } from '../lib/dates';
import { btnPrimary } from '../lib/ui';

/** The approval queue on its own page, on the same `?period=YYYY-MM` the dashboard uses. */
export function ReviewPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const periods = useAsync(() => api.listPeriods(), 'periods');
  useSharePeriods(periods.data);

  const requested = searchParams.get('period');
  const period =
    requested && isPeriodKey(requested) ? requested : periods.data ? defaultPeriodKey(periods.data) : null;
  const periodInfo = periods.data?.find((p) => p.period_key === period) ?? null;
  const closed = periodInfo?.is_closed ?? false;

  function changePeriod(next: string) {
    setSearchParams(next ? { period: next } : {});
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
      {period && <ApprovalQueue key={period} period={period} closed={closed} onChanged={periods.reload} />}
    </div>
  );
}
