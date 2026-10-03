import type { AutoApproveReason, AutoApproveResponse } from '../api';
import { plural } from './format';

/** What each reason for keeping a line in the queue is called in the dialog, in the order shown. */
export const STAY_LABELS: ReadonlyArray<[AutoApproveReason, string]> = [
  ['new_merchant', 'New merchants'],
  ['new_on_this_card', 'New on this card'],
  ['few_approvals', 'Approved only once'],
  ['mixed_history', 'Filed different ways'],
  ['unusual_amount', 'Unusual amount'],
  ['other_sign', 'Other sign'],
  ['transfer', 'Transfers'],
  ['split', 'Split lines'],
  ['closed_period', 'Closed months'],
];

/** "New merchants 330 · Filed different ways 51", leaving out reasons with no lines. */
export function staysBreakdown(skipped: AutoApproveResponse['skipped']): string {
  return STAY_LABELS.filter(([reason]) => (skipped[reason] ?? 0) > 0)
    .map(([reason, label]) => `${label} ${skipped[reason]}`)
    .join(' · ');
}

/** "12 lines from merchants you know can be approved" (or "were approved" once done). */
export function knownMerchantsSentence(count: number, done = false): string {
  if (count === 0) return done ? 'No lines from merchants you know were approved' : 'No lines from merchants you know can be approved';
  return `${plural(count, 'line')} from merchants you know ${done ? (count === 1 ? 'was' : 'were') : 'can be'} approved`;
}
