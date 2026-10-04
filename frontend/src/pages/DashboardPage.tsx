import { Upload } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { api, type PeriodOut } from '../api';
import { AuditCard, RunAuditButton, useAuditReport } from '../components/AuditCard';
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
import { SubscriptionsCard } from '../components/SubscriptionsCard';
import { UnmatchedTransfersLink } from '../components/UnmatchedTransfersLink';
import { ViewToggleBar } from '../components/ViewToggleBar';
import { useSharePeriods } from '../hooks/reviewBadge';
import { useAsync } from '../hooks/useAsync';
import { useSetupSteps } from '../hooks/useSetupSteps';
import { defaultPeriodKey, isPeriodKey, periodLabel } from '../lib/dates';
import { formatCount } from '../lib/money';

import { readNotice } from '../lib/navNotice';
import { pendingMonths, reviewPath } from '../lib/review';
import { setupIncomplete } from '../lib/setup';
import { btnPrimary, btnSecondary, btnSmall, cx, linkBase } from '../lib/ui';
import { readStoredView, storeView, type MetricView } from '../lib/views';

/**
 * "1,193 lines still to review in 7 earlier months": lines waiting in months other
 * than the one on show, as one quiet line for the header. Never lists the months.
 */
export function pendingElsewhereNote(periods: ReadonlyArray<PeriodOut> | null, period: string | null): string | null {
  const others = pendingMonths(periods).filter((m) => m.period !== period);
  if (others.length === 0) return null;
  const count = others.reduce((sum, m) => sum + m.count, 0);
  const allEarlier = period !== null && others.every((m) => m.period < period);
  const where = `${others.length} ${allEarlier ? 'earlier' : 'other'} ${others.length === 1 ? 'month' : 'months'}`;
  return `${formatCount(count)} ${count === 1 ? 'line' : 'lines'} still to review in ${where}`;
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
  const elsewhere = pendingElsewhereNote(periods.data, period);
  const setup = useSetupSteps();
  const settingUp = setupIncomplete(setup);
  const audit = useAuditReport(period ?? '', refreshKey);

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
              <RunAuditButton period={period} audit={audit} />
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

      {elsewhere && (
        <p className="-mt-3 text-xs text-ink-3" data-testid="pending-elsewhere">
          {elsewhere}.{' '}
          <Link to={reviewPath(null)} className={linkBase}>
            Review them
          </Link>
        </p>
      )}

      {periods.data && !period && (
        <Card>
          <EmptyState
            icon={Upload}
            title="No periods yet"
            hint={
              settingUp
                ? 'Once the steps above are done, each month your statements cover appears here.'
                : 'Upload a statement to get started.'
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

      {period && (
        <>
          <SettlementBanner period={period} periodInfo={periodInfo} refreshKey={refreshKey} onChanged={bump} />
          <MetricsSection
            period={period}
            view={view}
            refreshKey={refreshKey}
            periods={periods.data}
            aside={<SubscriptionsCard refreshKey={refreshKey} />}
          />
          <AuditCard audit={audit} />
          <InvestmentCard refreshKey={refreshKey} />
        </>
      )}
    </div>
  );
}
