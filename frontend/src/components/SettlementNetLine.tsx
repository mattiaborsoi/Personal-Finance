import { TriangleAlert } from 'lucide-react';
import { api, type PeriodOut } from '../api';
import { useCurrency, useNames } from '../config/ConfigContext';
import { useAsync } from '../hooks/useAsync';
import { periodLabel } from '../lib/dates';
import { plural } from '../lib/format';
import { awaitingFirstApproval, settlementHeadline } from '../lib/settlement';
import { cardInset, cx, eyebrow } from '../lib/ui';
import { ErrorMessage } from './ErrorMessage';
import { LoadingState } from './LoadingState';

interface Props {
  period: string;
  /** The period's counts, which say whether anything is approved yet; null while unknown. */
  periodInfo?: PeriodOut | null;
  refreshKey?: number;
}

/** Compact "who owes whom" tile for the mobile claim page (both roles may read it). */
export function SettlementNetLine({ period, periodInfo = null, refreshKey = 0 }: Props) {
  const names = useNames();
  const symbol = useCurrency();
  const settlement = useAsync(() => api.getSettlement(period), `settlement-line:${period}:${refreshKey}`);

  if (settlement.error) return <ErrorMessage message={settlement.error.message} onRetry={settlement.reload} />;
  if (!settlement.data) {
    return (
      <div className={cx(cardInset, 'flex min-h-[5.5rem] items-center py-4')}>
        <LoadingState inline label="Calculating settlement" />
      </div>
    );
  }

  const data = settlement.data;
  const awaiting = awaitingFirstApproval(data, periodInfo);

  return (
    <div className={cx(cardInset, 'py-4')}>
      <p className={eyebrow}>{periodLabel(period)} so far</p>
      <p className="mt-1.5 text-xl font-semibold tracking-tight text-ink" data-testid="settlement-net-line">
        {awaiting ? 'Nothing approved yet' : settlementHeadline(data.net_owed_by_secondary, names, symbol)}
      </p>
      {awaiting ? (
        <p className="mt-2 text-xs text-ink-2">
          {plural(data.pending_review_count, 'line is', 'lines are')} waiting for review, so there is no figure yet.
        </p>
      ) : (
        data.pending_review_count > 0 && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-warning-ink">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Some transactions are still under review, so this may change.
          </p>
        )
      )}
    </div>
  );
}
