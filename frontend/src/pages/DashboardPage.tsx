import { Upload } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ApprovalQueue } from '../components/ApprovalQueue';
import { AuditCard } from '../components/AuditCard';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { ClosePeriodButton } from '../components/ClosePeriodButton';
import { EmptyState } from '../components/EmptyState';
import { ErrorMessage } from '../components/ErrorMessage';
import { InvestmentCard } from '../components/InvestmentCard';
import { LoadingState } from '../components/LoadingState';
import { MetricsSection } from '../components/MetricsSection';
import { PageHeader } from '../components/PageHeader';
import { PeriodSelector } from '../components/PeriodSelector';
import { SettlementBanner } from '../components/SettlementBanner';
import { UnmatchedTransfersLink } from '../components/UnmatchedTransfersLink';
import { ViewToggleBar } from '../components/ViewToggleBar';
import { useAsync } from '../hooks/useAsync';
import { defaultPeriodKey, isPeriodKey, periodLabel } from '../lib/dates';
import { btnPrimary } from '../lib/ui';
import { readStoredView, storeView, type MetricView } from '../lib/views';

export function DashboardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const periods = useAsync(() => api.listPeriods(), 'periods');
  const [view, setView] = useState<MetricView>(readStoredView);
  const [refreshKey, setRefreshKey] = useState(0);

  const requested = searchParams.get('period');
  const period =
    requested && isPeriodKey(requested) ? requested : periods.data ? defaultPeriodKey(periods.data) : null;
  const periodInfo = periods.data?.find((p) => p.period_key === period) ?? null;
  const closed = periodInfo?.is_closed ?? false;

  const reloadPeriods = periods.reload;
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);
  const onPeriodChanged = useCallback(() => {
    reloadPeriods();
    bump();
  }, [reloadPeriods, bump]);

  function changeView(next: MetricView) {
    setView(next);
    storeView(next);
  }

  function changePeriod(next: string) {
    setSearchParams(next ? { period: next } : {});
  }

  return (
    // min-w-0: a wide table inside a card scrolls within it instead of widening the page on a phone.
    <div className="min-w-0 space-y-6">
      <PageHeader
        title="Dashboard"
        description={period ? periodLabel(period) : undefined}
        actions={
          period && (
            <>
              {closed && (
                <Badge tone="neutral" dot>
                  Closed
                </Badge>
              )}
              <UnmatchedTransfersLink refreshKey={refreshKey} />
              <ClosePeriodButton period={periodInfo} periodKey={period} onChanged={onPeriodChanged} />
            </>
          )
        }
      />

      {periods.error && <ErrorMessage message={periods.error.message} onRetry={periods.reload} />}
      {!periods.data && !periods.error && <LoadingState label="Loading periods" />}

      {periods.data && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PeriodSelector periods={periods.data} value={period} onChange={changePeriod} />
          <ViewToggleBar view={view} onChange={changeView} />
        </div>
      )}

      {periods.data && !period && (
        <Card>
          <EmptyState
            icon={Upload}
            title="No periods yet"
            hint="Upload a statement to get started, or type a period above."
            action={
              <Link to="/upload" className={btnPrimary}>
                <Upload className="h-4 w-4" aria-hidden="true" />
                Upload a statement
              </Link>
            }
          />
        </Card>
      )}

      {period && (
        <>
          <MetricsSection period={period} view={view} refreshKey={refreshKey} />
          <SettlementBanner period={period} periodInfo={periodInfo} refreshKey={refreshKey} onChanged={bump} />
          <InvestmentCard refreshKey={refreshKey} />
          <AuditCard period={period} refreshKey={refreshKey} />
          <ApprovalQueue period={period} closed={closed} onChanged={onPeriodChanged} />
        </>
      )}
    </div>
  );
}
