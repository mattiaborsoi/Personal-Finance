import { TriangleAlert } from 'lucide-react';
import type { UnusualOut } from '../api';
import { useNames } from '../config/ConfigContext';
import { categoryLabel, claimTypeLabel } from '../lib/format';

/** The tooltip: "Filed this way 1 of 14 times on this card; usually Dining, Personal (not shared)." */
export function unusualTitle(unusual: UnusualOut, names: { primary: string; secondary: string }): string {
  return `Filed this way ${unusual.times} of ${unusual.total} times on this card; usually ${categoryLabel(unusual.usual_category)}, ${claimTypeLabel(unusual.usual_claim_type, names)}.`;
}

/** Short label for the badge: "Usually Dining · Personal". */
export function unusualLabel(unusual: UnusualOut, names: { primary: string; secondary: string }): string {
  const claim = claimTypeLabel(unusual.usual_claim_type, names).replace(' (not shared)', '');
  return `Usually ${categoryLabel(unusual.usual_category)} · ${claim}`;
}

/**
 * Flags a line filed unlike its merchant usually is on the same card (see `TransactionOut.unusual`).
 * A quiet line under the merchant's details: w-0 + min-w-full lets it truncate instead of widening the table.
 */
export function UnusualBadge({ unusual }: { unusual: UnusualOut | null | undefined }) {
  const names = useNames();
  if (!unusual) return null;
  return (
    <p
      className="mt-1 flex w-0 min-w-full items-center gap-1 text-xs font-medium text-warning-ink"
      title={unusualTitle(unusual, names)}
    >
      <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{unusualLabel(unusual, names)}</span>
    </p>
  );
}
