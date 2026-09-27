import type { PeriodOut, SettlementOut } from '../api';
import { formatMoney, toNumber } from './money';

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

/** True when the live net has drifted from the figure recorded at close (beyond rounding). */
export function snapshotDiffers(data: Pick<SettlementOut, 'net_owed_by_secondary' | 'snapshot'>): boolean {
  if (!data.snapshot) return false;
  const live = toNumber(data.net_owed_by_secondary);
  const recorded = toNumber(data.snapshot.net_owed_by_secondary);
  if (!Number.isFinite(live) || !Number.isFinite(recorded)) return false;
  return Math.abs(live - recorded) >= 0.005;
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

/**
 * "<secondary> owes <primary> £x" when net > 0, the reverse when net < 0,
 * "Settled up" when zero.
 */
export function settlementHeadline(
  netOwedBySecondary: string | number | null | undefined,
  names: { primary: string; secondary: string },
  symbol: string,
): string {
  const direction = settlementDirection(netOwedBySecondary);
  const amount = formatMoney(Math.abs(toNumber(netOwedBySecondary)), symbol);
  switch (direction) {
    case 'secondary_owes':
      return `${names.secondary} owes ${names.primary} ${amount}`;
    case 'primary_owes':
      return `${names.primary} owes ${names.secondary} ${amount}`;
    default:
      return 'Settled up';
  }
}
