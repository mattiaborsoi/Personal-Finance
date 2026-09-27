import type { ResetCounts, ResetScope } from '../api';
import { plural } from './format';

const COUNT_NOUNS: ReadonlyArray<[keyof ResetCounts, string]> = [
  ['transactions', 'transaction'],
  ['uploads', 'upload'],
  ['claims', 'partner claim'],
  ['periods', 'period'],
  ['memory', 'remembered merchant'],
  ['accounts', 'account'],
  ['settings', 'saved setting'],
];

/** "412 transactions, 9 uploads and 3 periods" from what a reset removed; null when it removed nothing. */
export function resetCountsLabel(deleted: ResetCounts): string | null {
  const parts = COUNT_NOUNS.filter(([key]) => deleted[key] > 0).map(([key, noun]) => plural(deleted[key], noun));
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The confirmation shown once a reset has run; `productName` is the app's name ("Settl"). */
export function resetSummary(scope: ResetScope, deleted: ResetCounts, productName: string): string {
  const list = resetCountsLabel(deleted);
  if (scope === 'everything') {
    return `${productName} is back to day one.${list ? ` Deleted ${list}.` : ''} The accounts in config.yaml are set up again.`;
  }
  return list ? `Deleted ${list}.` : 'Nothing to delete: there were no transactions.';
}
