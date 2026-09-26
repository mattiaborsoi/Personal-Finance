import { Suspense, lazy } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import { cx, eyebrow } from '../lib/ui';
import { selectViewFigures, viewDefinition, type MetricView } from '../lib/views';
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
}

const TREND_PERIODS = 6;

/** Headline figure, sub-figures, six-period trend ending at `period`, and the breakdown list for one view. */
export function MetricsSection({ period, view, refreshKey }: Props) {
  const metrics = useAsync(() => api.getMetrics(period), `metrics:${period}:${refreshKey}`);
  const trends = useAsync(() => api.getTrends(TREND_PERIODS, period), `trends:${period}:${refreshKey}`);
  const definition = viewDefinition(view);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card
        className={cx('lg:col-span-2 transition-opacity', metrics.loading && metrics.data && 'opacity-70')}
        accentClass={definition.accent.bg}
        title={definition.label}
        actions={metrics.loading && <LoadingState inline />}
      >
        {metrics.error && <ErrorMessage message={metrics.error.message} onRetry={metrics.reload} />}
        {metrics.data ? (
          <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            <MetricsHeadline
              figures={selectViewFigures(metrics.data, view)}
              hint={definition.hint}
              signed={view === 'liquidity'}
              accentClass={definition.accent.bg}
            />
            <div className="min-w-0">
              <p className={cx(eyebrow, 'mb-2')}>Last {trends.data?.length ?? TREND_PERIODS} periods</p>
              {trends.error && <ErrorMessage message={trends.error.message} onRetry={trends.reload} />}
              {trends.data ? (
                <Suspense fallback={<LoadingState label="Loading chart" />}>
                  <TrendChart data={trends.data} view={view} />
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
      <Card title={view === 'liquidity' ? 'By account' : 'By category'} description="This period">
        {metrics.data ? (
          <CategoryBreakdown breakdown={selectViewFigures(metrics.data, view).breakdown} accentClass={definition.accent.bg} />
        ) : (
          !metrics.error && <LoadingState />
        )}
      </Card>
    </div>
  );
}
