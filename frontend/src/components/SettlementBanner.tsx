import { Calendar, ChevronDown, ChevronUp, HandCoins, Landmark, ListChecks, Lock, Receipt, Scale, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage, type PeriodOut, type SettlementEntry } from '../api';
import { useAuth } from '../auth/AuthContext';
import { useConfig, useCurrency, useNames } from '../config/ConfigContext';
import { useAsync } from '../hooks/useAsync';
import { formatDate, periodLabel } from '../lib/dates';
import { accountLabel, formatPercent, plural, ratioToPercent } from '../lib/format';
import { formatMoney, toNumber } from '../lib/money';
import { reviewPath } from '../lib/review';
import {
  awaitingFirstApproval,
  balanceHeadline,
  driftMessage,
  entryEffect,
  owedByPhrase,
  settlementDirection,
  snapshotDiffers,
  suggestedCheckpointAmount,
  totalPayments,
  workingSummary,
} from '../lib/settlement';
import {
  btnGhost,
  btnPrimary,
  btnSecondary,
  btnSmall,
  cardBase,
  cardInset,
  chip,
  chipFluid,
  chipSoft,
  cx,
  eyebrow,
  linkBase,
} from '../lib/ui';
import { ConfirmButton } from './ConfirmButton';
import { ErrorMessage } from './ErrorMessage';
import { InitialsChip } from './InitialsChip';
import { LoadingState } from './LoadingState';
import { MoneyText } from './MoneyText';
import { Notice } from './Notice';
import { RecordPaymentDialog } from './RecordPaymentDialog';
import { SetBalanceDialog } from './SetBalanceDialog';
import { SettlementLines } from './SettlementLines';

interface Props {
  period: string;
  /** The period's counts, which say whether anything is approved yet; null while unknown. */
  periodInfo?: PeriodOut | null;
  refreshKey?: number;
  /** Called after a payment, adjustment or balance changes so sibling cards can refresh. */
  onChanged?: () => void;
}

type Dialog = { kind: 'payment' } | { kind: 'balance'; initialAmount: number | null } | null;

/** One step of the working: a label with its explanation on the left, the figure on the right, detail beneath. */
function WorkingRow({
  label,
  sub,
  figure,
  children,
  strong = false,
  testId,
}: {
  label: string;
  sub?: ReactNode;
  figure: ReactNode;
  children?: ReactNode;
  strong?: boolean;
  testId?: string;
}) {
  return (
    <li className="py-3 first:pt-0 last:pb-0" data-testid={testId}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className={cx('text-sm text-ink', strong ? 'font-semibold' : 'font-medium')}>{label}</p>
          {sub && <p className="mt-0.5 text-xs text-ink-3">{sub}</p>}
        </div>
        <div className={cx('text-sm tabular text-ink', strong ? 'font-semibold' : 'font-medium')}>{figure}</div>
      </div>
      {children && <div className="mt-3">{children}</div>}
    </li>
  );
}

/** How much of the month is approved: "97% approved" with the lines still to review. */
export function reviewProgress(info: Pick<PeriodOut, 'transaction_count' | 'pending_review_count'>): {
  percent: number;
  pending: number;
} {
  const total = Math.max(info.transaction_count, 0);
  const pending = Math.min(Math.max(info.pending_review_count, 0), total);
  const percent = total === 0 ? 100 : Math.floor(((total - pending) / total) * 100);
  return { percent, pending };
}

/**
 * The emotional centre of the dashboard: the outstanding balance between the two
 * of them, how it was reached (carried in, this month, payments, adjustments), and
 * the actions that move it.
 */
export function SettlementBanner({ period, periodInfo = null, refreshKey = 0, onChanged }: Props) {
  const config = useConfig();
  const names = useNames();
  const symbol = useCurrency();
  const { session } = useAuth();
  const isPrimary = session?.role === 'primary';
  const settlement = useAsync(() => api.getSettlement(period), `settlement:${period}:${refreshKey}`);
  // The open lines panel lives in the URL (?lines=open), so a reload or a shared link keeps it open.
  const [searchParams, setSearchParams] = useSearchParams();
  const expanded = searchParams.get('lines') === 'open';
  // The working is collapsed by default: the headline and its one-line summary are the point.
  const [workingOpen, setWorkingOpen] = useState(expanded);
  const showWorking = workingOpen || expanded;
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  const data = settlement.data;
  const balance = data?.balance;
  const month = periodLabel(period);
  const ids = { primary: config.users.primary.id, secondary: config.users.secondary.id };
  // Nothing approved yet and nothing outstanding: a zero is "no figure yet", never "settled up".
  const awaiting = data ? awaitingFirstApproval(data, periodInfo) : false;
  const direction = balance ? settlementDirection(balance.balance_out) : 'settled';
  const noFigure = awaiting && direction === 'settled';
  const settled = direction === 'settled' && !noFigure;
  const checkpoint = balance?.checkpoint ?? null;
  const drift = balance ? driftMessage(checkpoint, month, names, symbol) : null;
  const history = balance?.before_checkpoint ?? false;

  function changed(message: string) {
    setActionError(null);
    setNotice(message);
    // One refetch: the parent's refresh key already re-keys this card, so only
    // reload directly when nobody upstream is listening.
    if (onChanged) onChanged();
    else settlement.reload();
  }

  async function removeEntry(entry: SettlementEntry) {
    setActionError(null);
    setNotice(null);
    try {
      await api.deleteSettlementEntry(entry.id);
      changed(entry.kind === 'payment' ? 'Payment removed.' : 'Adjustment removed.');
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

  const entries = data?.entries ?? [];
  const manualPayments = entries.filter((e) => e.kind === 'payment');
  const adjustments = entries.filter((e) => e.kind === 'adjustment');
  const ledgerPayments = data?.ledger_payments ?? [];
  const paid = balance ? totalPayments(balance) : 0;
  const snapshotDrifted = data ? snapshotDiffers(data) : false;
  const recordedAtClose = data?.snapshot
    ? (data.snapshot.balance_out ?? data.snapshot.net_owed_by_secondary)
    : null;

  const userName = (id: string | null) =>
    id === ids.primary ? names.primary : id === ids.secondary ? names.secondary : (id ?? '');

  function entryRow(entry: SettlementEntry) {
    const effect = entryEffect(entry, ids);
    const what =
      entry.kind === 'payment'
        ? `${userName(entry.paid_by)} paid ${userName(entry.paid_by === ids.primary ? ids.secondary : ids.primary)}`
        : 'Adjustment';
    const amountText = formatMoney(Math.abs(toNumber(entry.amount)), symbol);
    return (
      <li key={entry.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
            <span className="whitespace-nowrap text-xs text-ink-3">{formatDate(entry.entry_date)}</span>
            <span className={chipSoft}>Recorded by hand</span>
            <span>{what}</span>
          </p>
          {entry.note && <p className="mt-0.5 text-xs text-ink-3">{entry.note}</p>}
        </div>
        <span className="flex items-center gap-1">
          <MoneyText value={effect} signed className="text-sm font-medium" />
          {isPrimary && (
            <ConfirmButton
              iconOnly
              icon={Trash2}
              tone="danger"
              ariaLabel={`Delete the ${entry.kind} of ${amountText} on ${formatDate(entry.entry_date)}`}
              confirmLabel={`Delete this ${entry.kind}?`}
              onConfirm={() => removeEntry(entry)}
            >
              Delete
            </ConfirmButton>
          )}
        </span>
      </li>
    );
  }

  const claimLines = data ? data.lines.filter((line) => line.source === 'claim') : [];
  const claimsTotal = claimLines.reduce((sum, line) => sum + Math.abs(toNumber(line.amount) || 0), 0);
  const claimCount = Math.max(claimLines.length, data?.unsettled_claim_count ?? 0);
  const progress = periodInfo && periodInfo.transaction_count > 0 ? reviewProgress(periodInfo) : null;

  const headlineLabel = history
    ? `At the end of ${month}, before the balance was set`
    : `Outstanding at end of ${month}`;

  return (
    <section
      aria-label="Settlement"
      className={cx(cardBase, 'overflow-hidden p-0 transition-opacity sm:p-0', settlement.loading && data && 'opacity-90')}
    >
      <div
        className={cx(
          'px-5 py-6 sm:px-6 sm:py-7',
          noFigure || history ? 'bg-surface-2' : settled && data ? 'bg-good/10' : 'bg-brand-soft/60',
        )}
      >
        {/* On a phone the actions sit under the figure, full width; from `sm` they sit to the right of it. */}
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between sm:gap-4" data-testid="settlement-top">
          <div className="min-w-0 flex-1">
            <h2 className={eyebrow}>Settlement · {month}</h2>
            {settlement.error && (
              <ErrorMessage className="mt-3" message={settlement.error.message} onRetry={settlement.reload} />
            )}
            {!data && !settlement.error && (
              <div className="mt-4 flex min-h-[5rem] items-center">
                <LoadingState inline label="Calculating settlement" />
              </div>
            )}
            {data && balance && (
              <>
                {!noFigure && (
                  <p className="mt-3 text-sm font-medium text-ink-2" data-testid="settlement-headline-label">
                    {headlineLabel}
                  </p>
                )}
                <div className={cx('flex flex-wrap items-center gap-x-4 gap-y-3', noFigure ? 'mt-3' : 'mt-2')}>
                  <span className="flex -space-x-2" aria-hidden="true">
                    <InitialsChip name={names.primary} size={36} className="ring-2 ring-surface" />
                    <InitialsChip name={names.secondary} size={36} className="ring-2 ring-surface" />
                  </span>
                  <p
                    className="min-w-0 flex-1 text-balance text-xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl"
                    data-testid="settlement-headline"
                  >
                    {noFigure ? 'Nothing approved yet' : balanceHeadline(balance.balance_out, names, symbol)}
                  </p>
                </div>
                {!noFigure && (
                  <p className="mt-3 text-sm text-ink-2" data-testid="settlement-working-line">
                    {workingSummary(balance, names, symbol)}
                  </p>
                )}
                {awaiting && (
                  <p className="mt-3 text-sm text-ink-2" data-testid="settlement-awaiting">
                    {noFigure
                      ? 'There is no figure until something is approved. '
                      : `Nothing from ${month} is approved yet. `}
                    {plural(data.pending_review_count, 'line is', 'lines are')} waiting for review.{' '}
                    <Link to={reviewPath(period)} className={linkBase}>
                      Review the queue
                    </Link>
                  </p>
                )}
                {/* Chips wrap as whole chips; only the long split chip may break, between its two halves. */}
                <ul className="mt-4 flex flex-wrap gap-2">
                  {checkpoint && (
                    <li className={cx(chip, 'whitespace-nowrap')}>
                      <Landmark className="h-3.5 w-3.5 text-ink-3" aria-hidden="true" />
                      Balance set on {formatDate(checkpoint.entry_date)}
                    </li>
                  )}
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
                  <li className={cx(chip, 'whitespace-nowrap')} data-testid="settlement-claims">
                    <Receipt className="h-3.5 w-3.5 text-ink-3" aria-hidden="true" />
                    {claimCount === 0
                      ? 'No partner claims'
                      : `${plural(claimCount, 'partner claim')} · ${formatMoney(claimsTotal, symbol)}${
                          data.unsettled_claim_count > 0 ? `, ${data.unsettled_claim_count} unsettled` : ''
                        }`}
                  </li>
                  {progress && (
                    <li className={cx(chip, 'whitespace-nowrap')} data-testid="settlement-progress">
                      <ListChecks className="h-3.5 w-3.5 text-ink-3" aria-hidden="true" />
                      {progress.pending > 0 ? (
                        <Link to={reviewPath(period)} className={cx('rounded', linkBase, 'font-medium')}>
                          {progress.percent}% approved · {progress.pending} to review
                        </Link>
                      ) : (
                        `${progress.percent}% approved`
                      )}
                      {(periodInfo?.unusual_count ?? 0) > 0 && (
                        <>
                          {' · '}
                          <Link
                            to={`/transactions?period=${encodeURIComponent(period)}&unusual=true`}
                            className={cx('rounded', linkBase, 'font-medium')}
                            title="Filed unlike that merchant usually is on the same card"
                          >
                            {plural(periodInfo?.unusual_count ?? 0, 'line looks', 'lines look')} unusual
                          </Link>
                        </>
                      )}
                    </li>
                  )}
                </ul>
              </>
            )}
          </div>
          {data && (settlement.loading || isPrimary) && (
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:shrink-0 sm:flex-row sm:items-center">
              {settlement.loading && <LoadingState inline />}
              {isPrimary && (
                <>
                  <button
                    type="button"
                    className={cx(btnPrimary, 'w-full sm:w-auto')}
                    onClick={() => setDialog({ kind: 'payment' })}
                  >
                    <HandCoins className="h-4 w-4" aria-hidden="true" />
                    Record a payment
                  </button>
                  <button
                    type="button"
                    className={cx(btnSecondary, 'w-full sm:w-auto')}
                    onClick={() => setDialog({ kind: 'balance', initialAmount: null })}
                  >
                    <Landmark className="h-4 w-4" aria-hidden="true" />
                    Set the balance
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {data && balance && (
        <div className="space-y-4 px-5 py-5 sm:px-6">
          {data.pending_review_count > 0 && !noFigure && (
            <Notice tone="warning" role="status">
              {plural(data.pending_review_count, 'transaction is', 'transactions are')} still pending review, so this
              figure may change.
            </Notice>
          )}
          {history && (
            <Notice tone="neutral">
              {balance?.later_checkpoint_period
                ? `The balance was set in ${periodLabel(balance.later_checkpoint_period)}, so ${month} is history, not carried forward.`
                : `Before the balance was set in a later month: ${month} is history, not carried forward.`}
            </Notice>
          )}
          {drift && checkpoint && (
            <Notice
              tone="warning"
              actions={
                isPrimary && (
                  <button
                    type="button"
                    className={cx(btnSecondary, btnSmall)}
                    onClick={() => setDialog({ kind: 'balance', initialAmount: suggestedCheckpointAmount(checkpoint) })}
                  >
                    Set it again
                  </button>
                )
              }
            >
              {drift}.
            </Notice>
          )}

          <div aria-live="polite" className="empty:hidden">
            {notice && (
              <Notice tone="good" role="status">
                {notice}
              </Notice>
            )}
          </div>
          <ErrorMessage message={actionError} onDismiss={() => setActionError(null)} />

          {!noFigure && (
            <button
              type="button"
              className={cx(btnGhost, btnSmall, '-ml-2.5')}
              aria-expanded={showWorking}
              aria-controls="settlement-working"
              onClick={() => {
                if (showWorking && expanded) {
                  setSearchParams(
                    (prev) => {
                      const next = new URLSearchParams(prev);
                      next.delete('lines');
                      return next;
                    },
                    { replace: true },
                  );
                }
                setWorkingOpen(!showWorking);
              }}
            >
              {showWorking ? (
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {showWorking ? 'Hide the working' : 'Show the working'}
            </button>
          )}
          {!noFigure && showWorking && (
            <div id="settlement-working" className="animate-rise">
              <h3 className={eyebrow}>The working</h3>
              <ol className="mt-3 divide-y divide-hairline" data-testid="settlement-working">
                <WorkingRow
                  label="Carried in"
                  sub={
                    checkpoint
                      ? 'Not used: the balance set for this month replaces it'
                      : balance.anchored_on
                        ? `From the balance set on ${formatDate(balance.anchored_on.entry_date)}`
                        : balance.from_period && balance.from_period !== period
                          ? `From ${periodLabel(balance.from_period)}`
                          : 'Nothing earlier on record'
                  }
                  figure={owedByPhrase(balance.carried_in, names, symbol)}
                />
                <WorkingRow
                  label="This month"
                  sub={`What ${month}’s approved lines and claims add to what ${names.secondary} owes`}
                  figure={<MoneyText value={balance.net} signed />}
                >
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
                  <button
                    type="button"
                    className={cx(btnGhost, btnSmall, 'mt-2')}
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
                  {expanded && (
                    <div id="settlement-lines" className="mt-2 animate-rise">
                      <SettlementLines lines={data.lines} />
                    </div>
                  )}
                </WorkingRow>
                <WorkingRow
                  label="Payments"
                  sub={
                    ledgerPayments.length + manualPayments.length === 0
                      ? `No payments in ${month}`
                      : checkpoint
                        ? 'Listed for reference: the balance set for this month already takes them into account'
                        : 'Settlement transfers in the ledger and payments recorded by hand'
                  }
                  figure={<MoneyText value={-paid} signed />}
                  testId="settlement-payments"
                >
                  {ledgerPayments.length + manualPayments.length > 0 && (
                    <ul className="divide-y divide-hairline rounded-xl border border-hairline px-3">
                      {ledgerPayments.map((p) => (
                        <li
                          key={p.transaction_id}
                          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
                        >
                          <p className="flex min-w-0 flex-1 basis-48 flex-wrap items-center gap-2 text-sm text-ink">
                            <span className="whitespace-nowrap text-xs text-ink-3">{formatDate(p.date)}</span>
                            <span className={chipSoft}>{accountLabel(config.accounts, p.account_id)}</span>
                            <span className="min-w-0 break-words">{p.description}</span>
                          </p>
                          {/* The ledger's effect is what the payment takes off; the working shows the change to what is owed. */}
                          <MoneyText value={-toNumber(p.effect)} signed className="text-sm font-medium" />
                        </li>
                      ))}
                      {manualPayments.map(entryRow)}
                    </ul>
                  )}
                </WorkingRow>
                {(adjustments.length > 0 || settlementDirection(balance.adjustments) !== 'settled') && (
                  <WorkingRow
                    label="Adjustments"
                    sub={
                      checkpoint
                        ? 'Listed for reference: the balance set for this month replaces them'
                        : 'Corrections agreed between you'
                    }
                    figure={<MoneyText value={balance.adjustments} signed />}
                    testId="settlement-adjustments"
                  >
                    {adjustments.length > 0 && (
                      <ul className="divide-y divide-hairline rounded-xl border border-hairline px-3">
                        {adjustments.map(entryRow)}
                      </ul>
                    )}
                  </WorkingRow>
                )}
                <WorkingRow
                  label="Outstanding"
                  strong
                  sub={
                    checkpoint
                      ? `Balance set on ${formatDate(checkpoint.entry_date)}: ${owedByPhrase(checkpoint.amount, names, symbol)}${checkpoint.note ? ` (${checkpoint.note})` : ''}. It replaces the sum above.`
                      : 'Carried in, plus this month, less payments, plus adjustments'
                  }
                  figure={owedByPhrase(balance.balance_out, names, symbol)}
                  testId="settlement-outstanding"
                />
              </ol>
              <p className="mt-3 text-xs text-ink-3">
                Signed figures are the change to what {names.secondary} owes {names.primary}: positive adds to it,
                negative takes it off.
              </p>
            </div>
          )}

          {showWorking && data.snapshot && recordedAtClose !== null && (
            <p
              className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 border-t border-hairline pt-4 text-xs text-ink-3"
              data-testid="settlement-snapshot"
            >
              <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                Recorded at close: {balanceHeadline(recordedAtClose, names, symbol)}
                {data.snapshot.snapshot_at ? ` (${formatDate(data.snapshot.snapshot_at)})` : ''}
              </span>
              {snapshotDrifted && (
                <span className="text-warning-ink" role="note">
                  · The live figure differs from what was recorded when the period was closed.
                </span>
              )}
            </p>
          )}
        </div>
      )}

      {dialog?.kind === 'payment' && balance && data && (
        <RecordPaymentDialog
          period={period}
          balanceOut={balance.balance_out}
          ledgerPayments={data.ledger_payments}
          onClose={() => setDialog(null)}
          onSaved={(entry) => {
            setDialog(null);
            changed(
              `Payment recorded: ${userName(entry.paid_by)} paid ${formatMoney(Math.abs(toNumber(entry.amount)), symbol)} on ${formatDate(entry.entry_date)}.`,
            );
          }}
        />
      )}
      {dialog?.kind === 'balance' && (
        <SetBalanceDialog
          period={period}
          checkpoint={checkpoint}
          initialAmount={dialog.initialAmount}
          onClose={() => setDialog(null)}
          onSaved={(message) => {
            setDialog(null);
            changed(message);
          }}
        />
      )}
    </section>
  );
}
