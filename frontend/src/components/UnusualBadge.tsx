import { TriangleAlert } from 'lucide-react';
import type { UnusualOut } from '../api';
import { useNames } from '../config/ConfigContext';
import { categoryLabel, claimTypeLabel } from '../lib/format';
import { Badge } from './Badge';

/** The tooltip: "Filed this way 1 of 14 times on this card; usually Dining, Personal (not shared)." */
export function unusualTitle(unusual: UnusualOut, names: { primary: string; secondary: string }): string {
  return `Filed this way ${unusual.times} of ${unusual.total} times on this card; usually ${categoryLabel(unusual.usual_category)}, ${claimTypeLabel(unusual.usual_claim_type, names)}.`;
}

/** Short label for the badge: "Usually Dining · Personal". */
export function unusualLabel(unusual: UnusualOut, names: { primary: string; secondary: string }): string {
  const claim = claimTypeLabel(unusual.usual_claim_type, names).replace(' (not shared)', '');
  return `Usually ${categoryLabel(unusual.usual_category)} · ${claim}`;
}

/** Flags a line filed unlike its merchant usually is on the same card (see `TransactionOut.unusual`). */
export function UnusualBadge({ unusual }: { unusual: UnusualOut | null | undefined }) {
  const names = useNames();
  if (!unusual) return null;
  return (
    <Badge tone="amber" title={unusualTitle(unusual, names)}>
      <TriangleAlert className="h-3 w-3" aria-hidden="true" />
      {unusualLabel(unusual, names)}
    </Badge>
  );
}
