import { Suspense, lazy, useState, type ReactNode } from 'react';
import { api, type PeriodOut } from '../api';
import { useAsync } from '../hooks/useAsync';
import { cx, eyebrow } from '../lib/ui';
import {
  headlineChange,
  readRefundsMode,
  selectViewFigures,
  storeRefundsMode,
  viewDefinition,
  type MetricView,
  type RefundsMode,
} from '../lib/views';
import { Card } from './Card';
import { CategoryBreakdown } from './CategoryBreakdown';
import { ErrorMessage } from './ErrorMessage';
import { LoadingState } from './LoadingState';
import { MetricsHeadline } from './MetricsHeadline';

// recharts is the largest dependency; only the dashboard needs it.
const TrendChart = lazy(() => import('./TrendChart').then((m) => ({ default: m.TrendChart })));

interface Props {
  period: string;
  view: MetricView;
  refreshKey: number;
  /** Every period on record: the months with lines still to review are marked on the chart. */
  periods?: PeriodOut[] | null;
  /** A card to sit beside the breakdown (the subscriptions). */
  aside?: ReactNode;
}

const TREND_PERIODS = 6;

/** Headline figure, how it moved, sub-figures and the six-period trend, then the breakdown beside `aside`. */
export function MetricsSection({ period, view, refreshKey, periods = null, aside }: Props) {
  const metrics = useAsync(() => api.getMetrics(period), `metrics:${period}:${refreshKey}`);
  const trends = useAsync(() => api.getTrends(TREND_PERIODS, period), `trends:${period}:${refreshKey}`);
  const [refunds, setRefunds] = useState<RefundsMode>(readRefundsMode);
  const definition = viewDefinition(view);
  const figures = metrics.data ? selectViewFigures(metrics.data, view, refunds) : null;
  const incomplete = new Set((periods ?? []).filter((p) => p.pending_review_count > 0).map((p) => p.period_key));

  function changeRefunds(mode: RefundsMode) {
    storeRefundsMode(mode);
    setRefunds(mode);
  }

  return (
    <div className="space-y-4">
      <Card
        className={cx('transition-opacity', metrics.loading && metrics.data && 'opacity-70')}
        accentClass={definition.accent.bg}
        title={definition.label}
        actions={metrics.loading && <LoadingState inline />}
      >
        {metrics.error && <ErrorMessage message={metrics.error.message} onRetry={metrics.reload} />}
        {metrics.data && figures ? (
          <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)]">
            <MetricsHeadline
              figures={figures}
              hint={definition.hint}
              signed={view === 'liquidity'}
              accentClass={definition.accent.bg}
              change={trends.data ? headlineChange(trends.data, period, view, refunds) : null}
              refunds={view === 'macro' ? { mode: refunds, onChange: changeRefunds } : undefined}
              people={view === 'macro' ? metrics.data.macro.by_person : undefined}
            />
            <div className="min-w-0">
              <p className={cx(eyebrow, 'mb-2')}>Last {trends.data?.length ?? TREND_PERIODS} months</p>
              {trends.error && <ErrorMessage message={trends.error.message} onRetry={trends.reload} />}
              {trends.data ? (
                <Suspense fallback={<LoadingState label="Loading chart" />}>
                  <TrendChart data={trends.data} view={view} refunds={refunds} incomplete={incomplete} />
                </Suspense>
              ) : (
                !trends.error && <LoadingState />
              )}
            </div>
          </div>
        ) : (
          !metrics.error && <LoadingState label="Loading metrics" />
        )}
      </Card>
      <div className={cx('grid gap-4', aside ? 'lg:grid-cols-2' : undefined)}>
        <Card title={view === 'liquidity' ? 'By account' : 'By category'} description="This month">
          {figures ? (
            <CategoryBreakdown breakdown={figures.breakdown} accentClass={definition.accent.bg} />
          ) : (
            !metrics.error && <LoadingState />
          )}
        </Card>
        {aside}
      </div>
    </div>
  );
}
