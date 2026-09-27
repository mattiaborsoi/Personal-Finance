import { Calendar, ChevronDown, ChevronUp, CircleCheck, HandCoins, Lock, Receipt, Scale } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage, type PeriodOut } from '../api';
import { useCurrency, useNames } from '../config/ConfigContext';
import { useAsync } from '../hooks/useAsync';
import { formatDate, periodLabel } from '../lib/dates';
import { formatPercent, plural, ratioToPercent } from '../lib/format';
import { reviewPath } from '../lib/review';
import { awaitingFirstApproval, settlementDirection, settlementHeadline, snapshotDiffers } from '../lib/settlement';
import { btnGhost, btnSmall, cardBase, cardInset, chip, chipFluid, cx, eyebrow, linkBase } from '../lib/ui';
import { ConfirmButton } from './ConfirmButton';
import { ErrorMessage } from './ErrorMessage';
import { InitialsChip } from './InitialsChip';
import { LoadingState } from './LoadingState';
import { MoneyText } from './MoneyText';
import { Notice } from './Notice';
import { SettlementLines } from './SettlementLines';

interface Props {
  period: string;
  /** The period's counts, which say whether anything is approved yet; null while unknown. */
  periodInfo?: PeriodOut | null;
  refreshKey?: number;
  /** Called after claims are marked settled so sibling cards can refresh. */
  onChanged?: () => void;
}

/** The emotional centre of the dashboard: who owes whom, why, and the one action that clears it. */
export function SettlementBanner({ period, periodInfo = null, refreshKey = 0, onChanged }: Props) {
  const names = useNames();
  const symbol = useCurrency();
  const settlement = useAsync(() => api.getSettlement(period), `settlement:${period}:${refreshKey}`);
  // The open lines panel lives in the URL (?lines=open), so a reload or a shared link keeps it open.
  const [searchParams, setSearchParams] = useSearchParams();
  const expanded = searchParams.get('lines') === 'open';
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const data = settlement.data;
  // Nothing approved yet: a zero net is "no figure yet", never "settled up".
  const awaiting = data ? awaitingFirstApproval(data, periodInfo) : false;
  const direction = data ? settlementDirection(data.net_owed_by_secondary) : 'settled';
  const settled = direction === 'settled' && !awaiting;

  async function markSettled() {
    setActionError(null);
    setNotice(null);
    try {
      const res = await api.markSettled(period);
      setNotice(`${plural(res.settled_claims, 'claim')} marked as settled.`);
      // One refetch: the parent's refresh key already re-keys this card, so only
      // reload directly when nobody upstream is listening.
      if (onChanged) onChanged();
      else settlement.reload();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  const components = data
    ? [
        {
          label: `${names.secondary}’s share of shared items ${names.primary} paid`,
          value: data.secondary_share_of_primary_paid_shared,
          sign: '+',
        },
        {
          label: `${names.primary}’s share of shared items ${names.secondary} paid`,
          value: data.primary_share_of_secondary_paid_shared,
          sign: '−',
        },
        {
          label: `${names.secondary}’s personal items on ${names.primary}’s cards`,
          value: data.secondary_personal_on_primary_paid,
          sign: '+',
        },
        {
          label: `${names.primary}’s personal items on ${names.secondary}’s cards`,
          value: data.primary_personal_on_secondary_paid,
          sign: '−',
        },
      ]
    : [];

  const drifted = data ? snapshotDiffers(data) : false;

  return (
    <section
      aria-label="Settlement"
      className={cx(cardBase, 'overflow-hidden p-0 transition-opacity sm:p-0', settlement.loading && data && 'opacity-90')}
    >
      <div
        className={cx(
          'px-5 py-6 sm:px-6 sm:py-7',
          awaiting ? 'bg-surface-2' : settled && data ? 'bg-good/10' : 'bg-brand-soft/60',
        )}
      >
        {/* On a phone the action sits under the figure, full width; from `sm` it sits to the right of it. */}
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between sm:gap-4" data-testid="settlement-top">
          <div className="min-w-0 flex-1">
            <h2 className={eyebrow}>Settlement · {periodLabel(period)}</h2>
            {settlement.error && (
              <ErrorMessage className="mt-3" message={settlement.error.message} onRetry={settlement.reload} />
            )}
            {!data && !settlement.error && (
              <div className="mt-4 flex min-h-[5rem] items-center">
                <LoadingState inline label="Calculating settlement" />
              </div>
            )}
            {data && (
              <>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-3">
                  <span className="flex -space-x-2" aria-hidden="true">
                    <InitialsChip name={names.primary} size={36} className="ring-2 ring-surface" />
                    <InitialsChip name={names.secondary} size={36} className="ring-2 ring-surface" />
                  </span>
                  <p
                    className="min-w-0 flex-1 text-balance text-2xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl"
                    data-testid="settlement-headline"
                  >
                    {awaiting ? 'Nothing approved yet' : settlementHeadline(data.net_owed_by_secondary, names, symbol)}
                  </p>
                </div>
                {awaiting && (
                  <p className="mt-3 text-sm text-ink-2" data-testid="settlement-awaiting">
                    There is no figure until something is approved.{' '}
                    {plural(data.pending_review_count, 'line is', 'lines are')} waiting for review.{' '}
                    <Link to={reviewPath(period)} className={linkBase}>
                      Review the queue
                    </Link>
                  </p>
                )}
                {/* Chips wrap as whole chips; only the long split chip may break, between its two halves. */}
                <ul className="mt-4 flex flex-wrap gap-2">
                  {data.settlement_due_date && (
                    <li className={cx(chip, 'whitespace-nowrap')}>
                      <Calendar className="h-3.5 w-3.5 text-ink-3" aria-hidden="true" />
                      Settle by {formatDate(data.settlement_due_date)}
                    </li>
                  )}
                  <li className={chipFluid}>
                    <Scale className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden="true" />
                    <span>
                      <span className="whitespace-nowrap">
                        Split {formatPercent(ratioToPercent(data.primary_ratio))} {names.primary} /
                      </span>{' '}
                      <span className="whitespace-nowrap">
                        {formatPercent(ratioToPercent(data.secondary_ratio))} {names.secondary}
                      </span>
                    </span>
                  </li>
                  <li className={cx(chip, 'whitespace-nowrap')}>
                    <Receipt className="h-3.5 w-3.5 text-ink-3" aria-hidden="true" />
                    {plural(data.unsettled_claim_count, 'unsettled claim')}
                  </li>
                  <li className={cx(chip, 'whitespace-nowrap')}>
                    <HandCoins className="h-3.5 w-3.5 text-ink-3" aria-hidden="true" />
                    Payments received <MoneyText value={data.settlement_payments_received} />
                  </li>
                </ul>
              </>
            )}
          </div>
          {data && (
            <div className="flex w-full items-center gap-3 sm:w-auto sm:shrink-0">
              {settlement.loading && <LoadingState inline />}
              <ConfirmButton
                className="w-full sm:w-auto"
                confirmLabel="Mark all of this period’s claims as settled?"
                onConfirm={markSettled}
                tone="primary"
                icon={CircleCheck}
                disabled={data.unsettled_claim_count === 0}
              >
                Mark claims settled
              </ConfirmButton>
            </div>
          )}
        </div>
      </div>

      {data && (
        <div className="space-y-4 px-5 py-5 sm:px-6">
          {data.pending_review_count > 0 && !awaiting && (
            <Notice tone="warning" role="status">
              {plural(data.pending_review_count, 'transaction is', 'transactions are')} still pending review, so this
              figure may change.
            </Notice>
          )}

          {/* The four sums are all zero while nothing is approved; they would only dress up a figure that does not exist. */}
          {!awaiting && (
            <dl className="grid gap-3 sm:grid-cols-2">
              {components.map((c) => (
                <div key={c.label} className={cx(cardInset, 'flex items-start justify-between gap-3')}>
                  <dt className="flex gap-2 text-xs leading-5 text-ink-2">
                    <span className="w-3 shrink-0 font-mono text-sm leading-5 text-ink-3" aria-hidden="true">
                      {c.sign}
                    </span>
                    {c.label}
                  </dt>
                  <dd className="shrink-0 text-sm font-semibold leading-5 tabular text-ink">
                    <MoneyText value={c.value} />
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {notice && (
            <Notice tone="good" role="status">
              {notice}
            </Notice>
          )}
          <ErrorMessage message={actionError} onDismiss={() => setActionError(null)} />

          {(data.snapshot || !awaiting) && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-4">
              {data.snapshot ? (
                <p
                  className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-ink-3"
                  data-testid="settlement-snapshot"
                >
                  <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    Recorded at close: {settlementHeadline(data.snapshot.net_owed_by_secondary, names, symbol)}
                    {data.snapshot.snapshot_at ? ` (${formatDate(data.snapshot.snapshot_at)})` : ''}
                  </span>
                  {drifted && (
                    <span className="text-warning-ink" role="note">
                      · The live figure differs from what was recorded when the period was closed.
                    </span>
                  )}
                </p>
              ) : (
                <span className="text-xs text-ink-3">Every line behind this figure is listed below.</span>
              )}
              {!awaiting && (
                <button
                  type="button"
                  className={cx(btnGhost, btnSmall)}
                  aria-expanded={expanded}
                  aria-controls="settlement-lines"
                  onClick={() =>
                    setSearchParams(
                      (prev) => {
                        const next = new URLSearchParams(prev);
                        if (expanded) next.delete('lines');
                        else next.set('lines', 'open');
                        return next;
                      },
                      { replace: true },
                    )
                  }
                >
                  {expanded ? (
                    <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {expanded ? 'Hide' : 'Show'} {plural(data.lines.length, 'line')}
                </button>
              )}
            </div>
          )}
          {expanded && !awaiting && (
            <div id="settlement-lines" className="animate-rise">
              <SettlementLines lines={data.lines} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
