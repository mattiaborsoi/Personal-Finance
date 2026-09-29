import { describe, expect, it } from 'vitest';
import type { SettlementOut, SettlementSnapshot } from '../api';
import { period, settlement, settlementBalance } from '../test/fixtures';
import {
  amountProblem,
  awaitingFirstApproval,
  balanceHeadline,
  checkpointDrifted,
  driftMessage,
  entryEffect,
  lastDayOfPeriod,
  nearbyLedgerPayment,
  owedByPhrase,
  paymentDateRange,
  settlementHeadline,
  snapshotDiffers,
  suggestedCheckpointAmount,
  viewerBalanceHeadline,
  workingSummary,
} from './settlement';

const names = { primary: 'Alex', secondary: 'Sam' };
const ids = { primary: 'user_primary', secondary: 'user_secondary' };

const snapshot: SettlementSnapshot = {
  period_key: '2026-03',
  net_owed_by_secondary: '45.90',
  secondary_share_of_primary_paid_shared: '120.00',
  primary_share_of_secondary_paid_shared: '60.00',
  secondary_personal_on_primary_paid: '10.00',
  primary_personal_on_secondary_paid: '24.10',
  settlement_payments_received: '0.00',
  line_count: 1,
  snapshot_at: '2026-04-01T08:00:00Z',
};

/** A period whose every line is still pending: zero sums, no lines, nothing to settle. */
function nothingApproved(overrides: Partial<SettlementOut> = {}): SettlementOut {
  return settlement({
    net_owed_by_secondary: '0.00',
    pending_review_count: 3,
    unsettled_claim_count: 0,
    lines: [],
    ...overrides,
  });
}

describe('settlementHeadline and balanceHeadline', () => {
  it('phrase a positive balance as the secondary owing the primary', () => {
    expect(settlementHeadline('45.90', names, '£')).toBe('Sam owes Alex £45.90');
    expect(balanceHeadline('312.40', names, '£')).toBe('Sam owes Alex £312.40');
  });

  it('phrase a negative balance the other way round with the absolute amount', () => {
    expect(settlementHeadline('-12.00', names, '£')).toBe('Alex owes Sam £12.00');
    expect(balanceHeadline('-1234.5', names, '£')).toBe('Alex owes Sam £1,234.50');
  });

  it('say settled up at zero (including negative zero and sub-penny noise)', () => {
    expect(balanceHeadline('0.00', names, '£')).toBe('Settled up');
    expect(balanceHeadline('-0.00', names, '£')).toBe('Settled up');
    expect(balanceHeadline('0.001', names, '£')).toBe('Settled up');
  });
});

describe('viewerBalanceHeadline', () => {
  it('speaks to the secondary as "you"', () => {
    expect(viewerBalanceHeadline('312.40', names, 'secondary', '£')).toBe('You owe Alex £312.40');
    expect(viewerBalanceHeadline('-12.00', names, 'secondary', '£')).toBe('Alex owes you £12.00');
  });

  it('speaks to the primary as "you"', () => {
    expect(viewerBalanceHeadline('312.40', names, 'primary', '£')).toBe('Sam owes you £312.40');
    expect(viewerBalanceHeadline('-12.00', names, 'primary', '£')).toBe('You owe Sam £12.00');
  });

  it('says settled up at zero', () => {
    expect(viewerBalanceHeadline('0.00', names, 'secondary', '£')).toBe('Settled up');
  });
});

describe('workingSummary', () => {
  it('names the direction of each figure in words', () => {
    const balance = settlementBalance({ carried_in: '266.50', net: '-20.00', payments_ledger: '100.00', balance_out: '146.50' });
    expect(workingSummary(balance, names, '£')).toBe(
      'Carried in £266.50 owed by Sam · this month £20.00 owed by Alex · Sam paid £100.00',
    );
  });

  it('adds adjustments only when there are some, and nets payments in both directions', () => {
    const balance = settlementBalance({ payments_ledger: '50.00', payments_manual: '-80.00', adjustments: '5.00' });
    expect(workingSummary(balance, names, '£')).toBe(
      'Carried in £0.00 · this month £45.90 owed by Sam · Alex paid £30.00 · adjusted £5.00 in Alex’s favour',
    );
    expect(owedByPhrase('0', names, '£')).toBe('£0.00');
  });
});

describe('workingSummary for a month with an agreed balance', () => {
  it('says the balance was set instead of summing', () => {
    const checkpoint = {
      id: 'cp',
      amount: '-30.00',
      entry_date: '2026-03-31',
      note: null,
      net_at_checkpoint: '45.90',
      drift: '0.00',
      drifted: false,
    };
    expect(workingSummary(settlementBalance({ balance_out: '-30.00', checkpoint }), names, '£')).toBe(
      'Balance set on 31 Mar 2026: £30.00 owed by Alex',
    );
  });
});

describe('amountProblem', () => {
  it('accepts positive amounts with up to two decimals', () => {
    expect(amountProblem('45.9')).toBeNull();
    expect(amountProblem('£1,234.50')).toBeNull();
  });

  it('refuses blanks, zero, words and a third decimal place', () => {
    expect(amountProblem('')).toBe('Enter an amount above zero.');
    expect(amountProblem('0')).toBe('Enter an amount above zero.');
    expect(amountProblem('abc')).toMatch(/as a number/);
    expect(amountProblem('-5')).toMatch(/as a number/);
    expect(amountProblem('10.005')).toBe('Use at most two decimal places.');
  });
});

describe('entryEffect', () => {
  it('takes a payment by the secondary off what they owe, and adds one by the primary', () => {
    expect(entryEffect({ kind: 'payment', amount: '50.00', paid_by: 'user_secondary' }, ids)).toBe(-50);
    expect(entryEffect({ kind: 'payment', amount: '50.00', paid_by: 'user_primary' }, ids)).toBe(50);
    expect(entryEffect({ kind: 'adjustment', amount: '-7.50', paid_by: null }, ids)).toBe(-7.5);
    expect(entryEffect({ kind: 'checkpoint', amount: '300.00', paid_by: null }, ids)).toBe(0);
  });
});

describe('checkpoint drift', () => {
  const checkpoint = { amount: '300.00', drift: '20.00', drifted: true };

  it('describes what has been approved since the balance was set, and in whose favour', () => {
    expect(checkpointDrifted(checkpoint)).toBe(true);
    expect(driftMessage(checkpoint, 'March 2026', names, '£')).toBe(
      '£20.00 approved in March 2026 since the balance was set (in Alex’s favour)',
    );
    expect(driftMessage({ ...checkpoint, drift: '-4.00' }, 'March 2026', names, '£')).toMatch(/£4\.00 .*in Sam’s favour/);
  });

  it('is silent without a checkpoint, when not drifted, or within rounding', () => {
    expect(checkpointDrifted(null)).toBe(false);
    expect(driftMessage({ ...checkpoint, drifted: false }, 'March 2026', names, '£')).toBeNull();
    expect(driftMessage({ ...checkpoint, drift: '0.001' }, 'March 2026', names, '£')).toBeNull();
  });

  it('suggests the agreed balance with the drift folded in', () => {
    expect(suggestedCheckpointAmount(checkpoint)).toBe(320);
    expect(suggestedCheckpointAmount({ amount: '-10.00', drift: '2.50' })).toBe(-7.5);
  });
});

describe('dates', () => {
  it('finds the last day of a month, leap years included', () => {
    expect(lastDayOfPeriod('2026-03')).toBe('2026-03-31');
    expect(lastDayOfPeriod('2028-02')).toBe('2028-02-29');
    expect(lastDayOfPeriod('2026-04')).toBe('2026-04-30');
  });

  it('keeps a payment between the start of the month and today, defaulting to today', () => {
    expect(paymentDateRange('2026-03', '2026-09-29')).toEqual({ min: '2026-03-01', max: '2026-09-29', initial: '2026-09-29' });
    expect(paymentDateRange('2026-10', '2026-09-29')).toEqual({ min: '2026-09-29', max: '2026-09-29', initial: '2026-09-29' });
  });
});

describe('nearbyLedgerPayment', () => {
  const ledger = [
    {
      transaction_id: 't1',
      date: '2026-03-18',
      amount: '100.00',
      account_id: 'acc_checking_hsbc',
      description: 'Transfer from Sam',
      effect: '100.00',
    },
  ];

  it('finds a ledger payment of the same amount and direction within seven days', () => {
    expect(nearbyLedgerPayment(ledger, 100, '2026-03-25', 'user_secondary', ids)?.transaction_id).toBe('t1');
    expect(nearbyLedgerPayment(ledger, 100, '2026-03-11', 'user_secondary', ids)).not.toBeNull();
  });

  it('ignores a different amount, the other direction, or more than seven days away', () => {
    expect(nearbyLedgerPayment(ledger, 90, '2026-03-18', 'user_secondary', ids)).toBeNull();
    expect(nearbyLedgerPayment(ledger, 100, '2026-03-18', 'user_primary', ids)).toBeNull();
    expect(nearbyLedgerPayment(ledger, 100, '2026-03-26', 'user_secondary', ids)).toBeNull();
    expect(nearbyLedgerPayment(ledger, 0, '2026-03-18', 'user_secondary', ids)).toBeNull();
  });
});

describe('snapshotDiffers', () => {
  it('compares the month’s net on an old snapshot, beyond a penny', () => {
    expect(snapshotDiffers({ net_owed_by_secondary: '45.90', snapshot: null })).toBe(false);
    expect(snapshotDiffers({ net_owed_by_secondary: '45.90', snapshot })).toBe(false);
    expect(snapshotDiffers({ net_owed_by_secondary: '45.904', snapshot })).toBe(false);
    expect(snapshotDiffers({ net_owed_by_secondary: '46.00', snapshot })).toBe(true);
  });

  it('compares the outstanding balance when the snapshot recorded it', () => {
    const withBalance = { ...snapshot, balance_out: '312.40' };
    expect(snapshotDiffers({ net_owed_by_secondary: '99.00', snapshot: withBalance, balance: { balance_out: '312.40' } })).toBe(false);
    expect(snapshotDiffers({ net_owed_by_secondary: '45.90', snapshot: withBalance, balance: { balance_out: '212.40' } })).toBe(true);
  });
});

describe('awaitingFirstApproval', () => {
  it('is true only while lines are pending and nothing is approved or claimed', () => {
    const pending = nothingApproved();
    expect(awaitingFirstApproval(pending, period({ transaction_count: 3, pending_review_count: 3 }))).toBe(true);
    // One approved line that never reaches `lines` (borne by its payer) still counts as approved.
    expect(awaitingFirstApproval(pending, period({ transaction_count: 4, pending_review_count: 3 }))).toBe(false);
    // A claim, settled or not, means there is a figure.
    expect(awaitingFirstApproval(nothingApproved({ unsettled_claim_count: 1 }), period({ transaction_count: 3, pending_review_count: 3 }))).toBe(false);
    expect(awaitingFirstApproval(settlement({ pending_review_count: 3 }), period({ transaction_count: 3, pending_review_count: 3 }))).toBe(false);
    // Nothing pending: whatever the figure is, it stands.
    expect(awaitingFirstApproval(nothingApproved({ pending_review_count: 0 }), period({ transaction_count: 0, pending_review_count: 0 }))).toBe(false);
  });

  it('falls back to the settlement lines when the period counts are unknown', () => {
    expect(awaitingFirstApproval(nothingApproved(), null)).toBe(true);
    expect(awaitingFirstApproval(nothingApproved({ lines: settlement().lines }), null)).toBe(false);
    expect(awaitingFirstApproval(nothingApproved({ lines: [{ ...settlement().lines[0], source: 'transaction' }] }), null)).toBe(false);
  });
});
