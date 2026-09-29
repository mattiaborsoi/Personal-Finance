import { TriangleAlert } from 'lucide-react';
import { api, type PeriodOut } from '../api';
import { useAuth } from '../auth/AuthContext';
import { useCurrency, useNames } from '../config/ConfigContext';
import { useAsync } from '../hooks/useAsync';
import { periodLabel } from '../lib/dates';
import { plural } from '../lib/format';
import { formatSignedMoney } from '../lib/money';
import { awaitingFirstApproval, settlementDirection, viewerBalanceHeadline } from '../lib/settlement';
import { cardInset, cx, eyebrow } from '../lib/ui';
import { ErrorMessage } from './ErrorMessage';
import { LoadingState } from './LoadingState';

interface Props {
  period: string;
  /** The period's counts, which say whether anything is approved yet; null while unknown. */
  periodInfo?: PeriodOut | null;
  refreshKey?: number;
}

/**
 * Compact, read-only "who owes whom" tile for the mobile claim page (both roles
 * may read it): the outstanding running balance from the viewer's side first,
 * then what this month has added so far.
 */
export function SettlementNetLine({ period, periodInfo = null, refreshKey = 0 }: Props) {
  const names = useNames();
  const symbol = useCurrency();
  const { session } = useAuth();
  const viewer = session?.role ?? 'secondary';
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
  const balance = data.balance;
  const awaiting = awaitingFirstApproval(data, periodInfo);
  // Nothing approved and nothing outstanding: a zero is "no figure yet", not "settled up".
  const noFigure = awaiting && settlementDirection(balance.balance_out) === 'settled';

  return (
    <div className={cx(cardInset, 'py-4')}>
      <p className={eyebrow}>Outstanding</p>
      <p className="mt-1.5 text-xl font-semibold tracking-tight text-ink" data-testid="settlement-net-line">
        {noFigure ? 'Nothing approved yet' : viewerBalanceHeadline(balance.balance_out, names, viewer, symbol)}
      </p>
      {!noFigure && (
        <p className="mt-1 text-sm text-ink-2" data-testid="settlement-month-so-far">
          {periodLabel(period)} so far: <span className="tabular">{formatSignedMoney(balance.net, symbol)}</span>{' '}
          <span className="text-ink-3">on what {viewer === 'secondary' ? 'you owe' : `${names.secondary} owes`}</span>
        </p>
      )}
      {awaiting ? (
        <p className="mt-2 text-xs text-ink-2">
          {plural(data.pending_review_count, 'line is', 'lines are')} waiting for review
          {noFigure ? ', so there is no figure yet.' : ', so this month has no figure yet.'}
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
