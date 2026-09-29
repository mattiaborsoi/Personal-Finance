import type {
  PeriodOut,
  SettlementBalance,
  SettlementCheckpoint,
  SettlementEntry,
  SettlementLedgerPayment,
  SettlementOut,
} from '../api';
import { formatDate } from './dates';
import { formatMoney, toNumber } from './money';

type Names = { primary: string; secondary: string };
type UserIds = { primary: string; secondary: string };

/**
 * True while the period has nothing approved yet: lines are waiting for review
 * and neither an approved transaction nor a claim exists, so a zero net is
 * "no figure yet", not "settled up".
 *
 * The period's counts say how many transactions are approved (an approved line
 * borne entirely by its payer never reaches `lines`, so the lines alone cannot
 * tell); without them the settlement lines are the best evidence available.
 */
export function awaitingFirstApproval(
  data: Pick<SettlementOut, 'pending_review_count' | 'unsettled_claim_count' | 'lines'>,
  period?: Pick<PeriodOut, 'transaction_count' | 'pending_review_count'> | null,
): boolean {
  if (data.pending_review_count <= 0) return false;
  if (data.unsettled_claim_count > 0 || data.lines.some((line) => line.source === 'claim')) return false;
  if (period) return period.transaction_count - period.pending_review_count <= 0;
  return !data.lines.some((line) => line.source !== 'claim');
}

function differ(a: string | number | null | undefined, b: string | number | null | undefined): boolean {
  const x = toNumber(a);
  const y = toNumber(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) >= 0.005;
}

/**
 * True when the live figure has drifted from the one recorded at close (beyond
 * rounding). A snapshot that recorded the running balance is compared on the
 * outstanding balance; an older one on the month's net.
 */
export function snapshotDiffers(
  data: Pick<SettlementOut, 'net_owed_by_secondary' | 'snapshot'> & { balance?: Pick<SettlementBalance, 'balance_out'> },
): boolean {
  if (!data.snapshot) return false;
  const recordedBalance = data.snapshot.balance_out;
  if (recordedBalance !== null && recordedBalance !== undefined && data.balance) {
    return differ(data.balance.balance_out, recordedBalance);
  }
  return differ(data.net_owed_by_secondary, data.snapshot.net_owed_by_secondary);
}

export type SettlementDirection = 'secondary_owes' | 'primary_owes' | 'settled';

export function settlementDirection(netOwedBySecondary: string | number | null | undefined): SettlementDirection {
  const n = toNumber(netOwedBySecondary);
  if (!Number.isFinite(n)) return 'settled';
  const rounded = Math.round(n * 100) / 100;
  if (rounded > 0) return 'secondary_owes';
  if (rounded < 0) return 'primary_owes';
  return 'settled';
}

function absMoney(value: string | number | null | undefined, symbol: string): string {
  const n = toNumber(value);
  return formatMoney(Number.isFinite(n) ? Math.abs(n) : 0, symbol);
}

/**
 * "<secondary> owes <primary> £x" when net > 0, the reverse when net < 0,
 * "Settled up" when zero.
 */
export function settlementHeadline(
  netOwedBySecondary: string | number | null | undefined,
  names: Names,
  symbol: string,
): string {
  const amount = absMoney(netOwedBySecondary, symbol);
  switch (settlementDirection(netOwedBySecondary)) {
    case 'secondary_owes':
      return `${names.secondary} owes ${names.primary} ${amount}`;
    case 'primary_owes':
      return `${names.primary} owes ${names.secondary} ${amount}`;
    default:
      return 'Settled up';
  }
}

/** The outstanding running balance as a sentence: "Sam owes Alex £312.40", "Alex owes Sam £…" or "Settled up". */
export function balanceHeadline(balanceOut: string | number | null | undefined, names: Names, symbol: string): string {
  return settlementHeadline(balanceOut, names, symbol);
}

/**
 * The outstanding balance from the viewer's side: "You owe Alex £312.40",
 * "Alex owes you £12.00" or "Settled up".
 */
export function viewerBalanceHeadline(
  balanceOut: string | number | null | undefined,
  names: Names,
  viewer: 'primary' | 'secondary',
  symbol: string,
): string {
  const direction = settlementDirection(balanceOut);
  if (direction === 'settled') return 'Settled up';
  const amount = absMoney(balanceOut, symbol);
  const debtor = direction === 'secondary_owes' ? 'secondary' : 'primary';
  const creditor = debtor === 'secondary' ? 'primary' : 'secondary';
  return debtor === viewer ? `You owe ${names[creditor]} ${amount}` : `${names[debtor]} owes you ${amount}`;
}

/** "£120.00 owed by Sam", "£12.00 owed by Alex", or "£0.00" for a figure in secondary-owes terms. */
export function owedByPhrase(value: string | number | null | undefined, names: Names, symbol: string): string {
  const amount = absMoney(value, symbol);
  switch (settlementDirection(value)) {
    case 'secondary_owes':
      return `${amount} owed by ${names.secondary}`;
    case 'primary_owes':
      return `${amount} owed by ${names.primary}`;
    default:
      return amount;
  }
}

/** Payments as the contract sums them: positive when the secondary paid the primary, negative the other way. */
export function totalPayments(balance: Pick<SettlementBalance, 'payments_ledger' | 'payments_manual'>): number {
  const ledger = toNumber(balance.payments_ledger);
  const manual = toNumber(balance.payments_manual);
  return (Number.isFinite(ledger) ? ledger : 0) + (Number.isFinite(manual) ? manual : 0);
}

/** "Sam paid £100.00", "Alex paid £20.00" (net of both directions), or "paid £0.00". */
export function paidPhrase(paid: number, names: Names, symbol: string): string {
  const amount = absMoney(paid, symbol);
  switch (settlementDirection(paid)) {
    case 'secondary_owes':
      return `${names.secondary} paid ${amount}`;
    case 'primary_owes':
      return `${names.primary} paid ${amount}`;
    default:
      return `paid ${amount}`;
  }
}

/** "adjusted £5.00 in Alex’s favour"; the favoured person is the one the change is owed to. */
export function adjustedPhrase(value: string | number | null | undefined, names: Names, symbol: string): string {
  const amount = absMoney(value, symbol);
  switch (settlementDirection(value)) {
    case 'secondary_owes':
      return `adjusted ${amount} in ${names.primary}’s favour`;
    case 'primary_owes':
      return `adjusted ${amount} in ${names.secondary}’s favour`;
    default:
      return `adjusted ${amount}`;
  }
}

/**
 * Null when a typed amount can be sent (a positive number with at most two
 * decimal places); otherwise the problem, in words. The server refuses more than
 * two decimals, so they are never rounded away silently.
 */
export function amountProblem(raw: string): string | null {
  const cleaned = raw.trim().replace(/[£$€,\s]/g, '');
  if (!cleaned) return 'Enter an amount above zero.';
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '.') return 'Enter the amount as a number, like 45.90.';
  if (/\.\d{3,}$/.test(cleaned)) return 'Use at most two decimal places.';
  if (Number(cleaned) <= 0) return 'Enter an amount above zero.';
  return null;
}

/** A month with an agreed balance: the balance replaces the sum, so carried in, payments and adjustments do not move it. */
export function isCheckpointMonth(balance: Pick<SettlementBalance, 'checkpoint'>): boolean {
  return balance.checkpoint !== null;
}

/**
 * The one line of working under the headline:
 * "Carried in £120.00 owed by Sam · this month £45.90 owed by Sam · Sam paid £100.00",
 * with "adjusted …" added when the month has adjustments. A month with an agreed
 * balance says that instead: "Balance set on 31 Mar 2026: £300.00 owed by Sam".
 */
export function workingSummary(balance: SettlementBalance, names: Names, symbol: string): string {
  if (balance.checkpoint) {
    return `Balance set on ${formatDate(balance.checkpoint.entry_date)}: ${owedByPhrase(balance.checkpoint.amount, names, symbol)}`;
  }
  const parts = [
    `Carried in ${owedByPhrase(balance.carried_in, names, symbol)}`,
    `this month ${owedByPhrase(balance.net, names, symbol)}`,
    paidPhrase(totalPayments(balance), names, symbol),
  ];
  if (settlementDirection(balance.adjustments) !== 'settled') parts.push(adjustedPhrase(balance.adjustments, names, symbol));
  return parts.join(' · ');
}

/** A hand-recorded entry's change to what the secondary owes (a checkpoint has none: it replaces the balance). */
export function entryEffect(entry: Pick<SettlementEntry, 'kind' | 'amount' | 'paid_by'>, ids: UserIds): number {
  const amount = toNumber(entry.amount);
  if (!Number.isFinite(amount)) return 0;
  if (entry.kind === 'adjustment') return amount;
  if (entry.kind === 'payment') {
    if (entry.paid_by === ids.secondary) return -Math.abs(amount);
    if (entry.paid_by === ids.primary) return Math.abs(amount);
  }
  return 0;
}

/** Whether the month's net has moved since its balance was set. */
export function checkpointDrifted(checkpoint: Pick<SettlementCheckpoint, 'drifted' | 'drift'> | null | undefined): boolean {
  if (!checkpoint) return false;
  return checkpoint.drifted && settlementDirection(checkpoint.drift) !== 'settled';
}

/** "£20.00 approved in March 2026 since the balance was set (in Alex’s favour)", or null when nothing has moved. */
export function driftMessage(
  checkpoint: Pick<SettlementCheckpoint, 'drifted' | 'drift'> | null | undefined,
  monthLabel: string,
  names: Names,
  symbol: string,
): string | null {
  if (!checkpoint || !checkpointDrifted(checkpoint)) return null;
  const favoured = settlementDirection(checkpoint.drift) === 'secondary_owes' ? names.primary : names.secondary;
  return `${absMoney(checkpoint.drift, symbol)} approved in ${monthLabel} since the balance was set (in ${favoured}’s favour)`;
}

/** The agreed balance with what has been approved since folded in: the natural figure to set it again to. */
export function suggestedCheckpointAmount(checkpoint: Pick<SettlementCheckpoint, 'amount' | 'drift'>): number {
  const amount = toNumber(checkpoint.amount);
  const drift = toNumber(checkpoint.drift);
  return Math.round(((Number.isFinite(amount) ? amount : 0) + (Number.isFinite(drift) ? drift : 0)) * 100) / 100;
}

/** "2026-02" -> "2026-02-28": the last day of a period, as YYYY-MM-DD. */
export function lastDayOfPeriod(periodKey: string): string {
  const [year, month] = periodKey.split('-').map(Number);
  const day = new Date(year, month, 0).getDate();
  return `${periodKey}-${day < 10 ? `0${day}` : day}`;
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/**
 * An approved ledger settlement payment that a hand-recorded one would duplicate:
 * the same amount, the same direction, within `days` days of `date`.
 */
export function nearbyLedgerPayment(
  payments: ReadonlyArray<SettlementLedgerPayment>,
  amount: number,
  date: string,
  paidBy: string,
  ids: UserIds,
  days = 7,
): SettlementLedgerPayment | null {
  if (!Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
  // A ledger payment's effect is positive when it takes money off what the secondary owes.
  const wanted = paidBy === ids.secondary ? amount : -amount;
  const target = dayNumber(date);
  return (
    payments.find((p) => {
      const effect = toNumber(p.effect);
      if (!Number.isFinite(effect) || Math.abs(effect - wanted) >= 0.005) return false;
      return Math.abs(dayNumber(p.date) - target) <= days;
    }) ?? null
  );
}

/**
 * The dates a payment recorded from a month's banner may carry: from the first
 * day of that month up to today (a payment is never in the future), with today
 * as the default. Viewing a month still ahead, today is the only choice.
 */
export function paymentDateRange(periodKey: string, today: string): { min: string; max: string; initial: string } {
  const min = `${periodKey}-01`;
  if (today < min) return { min: today, max: today, initial: today };
  return { min, max: today, initial: today };
}
