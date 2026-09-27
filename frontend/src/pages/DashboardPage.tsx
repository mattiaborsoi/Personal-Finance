import { ArrowRight, ListChecks, Upload } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { api, type PeriodOut } from '../api';
import { AuditCard } from '../components/AuditCard';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { ClosePeriodButton } from '../components/ClosePeriodButton';
import { EmptyState } from '../components/EmptyState';
import { ErrorMessage } from '../components/ErrorMessage';
import { FirstRunChecklist } from '../components/FirstRunChecklist';
import { InvestmentCard } from '../components/InvestmentCard';
import { LoadingState } from '../components/LoadingState';
import { MetricsSection } from '../components/MetricsSection';
import { Notice } from '../components/Notice';
import { PageHeader } from '../components/PageHeader';
import { PeriodSelector } from '../components/PeriodSelector';
import { SettlementBanner } from '../components/SettlementBanner';
import { UnmatchedTransfersLink } from '../components/UnmatchedTransfersLink';
import { ViewToggleBar } from '../components/ViewToggleBar';
import { useSharePeriods } from '../hooks/reviewBadge';
import { useAsync } from '../hooks/useAsync';
import { useSetupSteps } from '../hooks/useSetupSteps';
import { defaultPeriodKey, isPeriodKey, periodLabel } from '../lib/dates';
import { readNotice } from '../lib/navNotice';
import { pendingMonths, pendingSummary, reviewPath } from '../lib/review';
import { setupIncomplete } from '../lib/setup';
import { btnPrimary, btnSecondary, btnSmall, cardBase, cx } from '../lib/ui';
import { readStoredView, storeView, type MetricView } from '../lib/views';

/**
 * Lines waiting for review in any month (not only the one on show), naming the
 * months, with the way to the Review page, which opens on the oldest of them.
 */
function PendingReviewCard({ periods, period }: { periods: PeriodOut[]; period: string | null }) {
  const months = pendingMonths(periods);
  const includesThisMonth = months.some((m) => m.period === period);
  return (
    <section
      aria-label="Waiting for review"
      className={cx(cardBase, 'flex flex-wrap items-center justify-between gap-3 py-4 sm:py-4')}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-warning/15 text-warning-ink"
        >
          <ListChecks className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-base font-semibold tracking-tight text-ink">{pendingSummary(periods)}</p>
          <p className="mt-0.5 text-xs text-ink-3">
            {includesThisMonth
              ? 'The figures below may change until they are approved.'
              : 'Figures for those months may change until they are approved.'}
          </p>
        </div>
      </div>
      <Link to={reviewPath(null)} className={cx(btnSecondary, btnSmall)}>
        Review now
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </section>
  );
}

export function DashboardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const periods = useAsync(() => api.listPeriods(), 'periods');
  useSharePeriods(periods.data);
  const [refreshKey, setRefreshKey] = useState(0);
  /** A confirmation from the page that sent us here (a reset in Settings). */
  const arrivalNotice = readNotice(location.state);
  const [noticeDismissed, setNoticeDismissed] = useState(false);

  // The view lives in the URL (?view=) so a shared link or Back restores it; the last choice is the fallback.
  const requestedView = searchParams.get('view');
  const view: MetricView =
    requestedView === 'macro' || requestedView === 'micro' || requestedView === 'liquidity'
      ? requestedView
      : readStoredView();

  const requested = searchParams.get('period');
  const period =
    requested && isPeriodKey(requested) ? requested : periods.data ? defaultPeriodKey(periods.data) : null;
  const periodInfo = periods.data?.find((p) => p.period_key === period) ?? null;
  const closed = periodInfo?.is_closed ?? false;
  const anyPending = pendingMonths(periods.data).length > 0;
  const setup = useSetupSteps();
  const settingUp = setupIncomplete(setup);

  const reloadPeriods = periods.reload;
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);
  const onPeriodChanged = useCallback(() => {
    reloadPeriods();
    bump();
  }, [reloadPeriods, bump]);

  function changeView(next: MetricView) {
    storeView(next);
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.set('view', next);
      return params;
    });
  }

  function changePeriod(next: string) {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (next) params.set('period', next);
      else params.delete('period');
      return params;
    });
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

      {arrivalNotice && !noticeDismissed && (
        <Notice
          tone="good"
          role="status"
          actions={
            <button type="button" className={cx(btnSecondary, btnSmall)} onClick={() => setNoticeDismissed(true)}>
              Dismiss
            </button>
          }
        >
          {arrivalNotice}
        </Notice>
      )}

      {setup && <FirstRunChecklist steps={setup} />}

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
            hint={
              settingUp
                ? 'Once the steps above are done, each month your statements cover appears here.'
                : 'Upload a statement to get started, or type a period above.'
            }
            action={
              settingUp ? undefined : (
                <Link to="/upload" className={btnPrimary}>
                  <Upload className="h-4 w-4" aria-hidden="true" />
                  Upload a statement
                </Link>
              )
            }
          />
        </Card>
      )}

      {periods.data && anyPending && <PendingReviewCard periods={periods.data} period={period} />}

      {period && (
        <>
          <MetricsSection period={period} view={view} refreshKey={refreshKey} />
          <SettlementBanner period={period} periodInfo={periodInfo} refreshKey={refreshKey} onChanged={bump} />
          <InvestmentCard refreshKey={refreshKey} />
          <AuditCard period={period} refreshKey={refreshKey} />
        </>
      )}
    </div>
  );
}
