import { TriangleAlert } from 'lucide-react';
import { api } from '../api';
import { useCurrency, useNames } from '../config/ConfigContext';
import { useAsync } from '../hooks/useAsync';
import { periodLabel } from '../lib/dates';
import { settlementHeadline } from '../lib/settlement';
import { cardInset, cx, eyebrow } from '../lib/ui';
import { ErrorMessage } from './ErrorMessage';
import { LoadingState } from './LoadingState';

interface Props {
  period: string;
  refreshKey?: number;
}

/** Compact "who owes whom" tile for the mobile claim page (both roles may read it). */
export function SettlementNetLine({ period, refreshKey = 0 }: Props) {
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

  return (
    <div className={cx(cardInset, 'py-4')}>
      <p className={eyebrow}>{periodLabel(period)} so far</p>
      <p className="mt-1.5 text-xl font-semibold tracking-tight text-ink">
        {settlementHeadline(settlement.data.net_owed_by_secondary, names, symbol)}
      </p>
      {settlement.data.pending_review_count > 0 && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-warning-ink">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Some transactions are still under review, so this may change.
        </p>
      )}
    </div>
  );
}
