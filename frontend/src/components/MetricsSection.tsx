import { Suspense, lazy, useState, type ReactNode } from 'react';
import { api, type PeriodOut } from '../api';
import { useAsync } from '../hooks/useAsync';
import { cx, eyebrow } from '../lib/ui';
import {
  headlineChange,
  readRefundsMode,
  yearChange,
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
  /** Show this calendar year (its months added up) instead of the month `period`. */
  year?: number | null;
}

const TREND_PERIODS = 6;

/** Headline figure, how it moved, sub-figures and the six-period trend, then the breakdown beside `aside`. */
export function MetricsSection({ period, view, refreshKey, periods = null, aside, year = null }: Props) {
  const monthly = year === null;
  const month = useAsync(() => api.getMetrics(period), `metrics:${period}:${refreshKey}`, monthly);
  const trends = useAsync(() => api.getTrends(TREND_PERIODS, period), `trends:${period}:${refreshKey}`, monthly);
  const annual = useAsync(() => api.getYearMetrics(year ?? 0), `year:${year}:${refreshKey}`, !monthly);
  // One shape for both: a year is its months added up, its trend the months themselves.
  const metrics = monthly
    ? month
    : { data: annual.data?.totals ?? null, error: annual.error, loading: annual.loading, reload: annual.reload };
  const trend = monthly
    ? trends
    : { data: annual.data?.months ?? null, error: null, loading: annual.loading, reload: annual.reload };
  const [refunds, setRefunds] = useState<RefundsMode>(readRefundsMode);
  const definition = viewDefinition(view);
  const figures = metrics.data ? selectViewFigures(metrics.data, view, refunds) : null;
  const change = monthly
    ? trends.data
      ? headlineChange(trends.data, period, view, refunds)
      : null
    : annual.data
      ? yearChange(annual.data, view, refunds)
      : null;
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
              change={change}
              refunds={view === 'macro' ? { mode: refunds, onChange: changeRefunds } : undefined}
              people={view === 'macro' ? metrics.data.macro.by_person : undefined}
            />
            <div className="min-w-0">
              <p className={cx(eyebrow, 'mb-2')}>
                {monthly ? `Last ${trend.data?.length ?? TREND_PERIODS} months` : `${year} by month`}
              </p>
              {trend.error && <ErrorMessage message={trend.error.message} onRetry={trend.reload} />}
              {trend.data ? (
                <Suspense fallback={<LoadingState label="Loading chart" />}>
                  <TrendChart data={trend.data} view={view} refunds={refunds} incomplete={incomplete} />
                </Suspense>
              ) : (
                !trend.error && <LoadingState />
              )}
            </div>
          </div>
        ) : (
          !metrics.error && <LoadingState label="Loading metrics" />
        )}
      </Card>
      <div className={cx('grid gap-4', aside ? 'lg:grid-cols-2' : undefined)}>
        <Card title={view === 'liquidity' ? 'By account' : 'By category'} description={monthly ? 'This month' : `All of ${year}`}>
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
