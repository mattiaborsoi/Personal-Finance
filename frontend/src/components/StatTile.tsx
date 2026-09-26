import type { ReactNode } from 'react';
import { cardInset, cx } from '../lib/ui';

interface Props {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
  /** Render as a definition-list item (inside a `<dl>`) rather than a plain block. */
  as?: 'div' | 'dl-item';
  /** `inset` sits on a card; `raised` sits on a coloured wash. */
  surface?: 'inset' | 'raised';
}

const SURFACES = {
  inset: cardInset,
  raised: 'rounded-xl border border-hairline bg-surface px-4 py-3',
};

/** Small figure with its label above: the unit of every "stats row". */
export function StatTile({ label, value, hint, className = '', as = 'div', surface = 'inset' }: Props) {
  const wrap = cx(SURFACES[surface], className);
  if (as === 'dl-item') {
    return (
      <div className={wrap}>
        <dt className="text-xs text-ink-3">{label}</dt>
        <dd className="mt-0.5 text-lg font-semibold tabular text-ink">{value}</dd>
        {hint && <dd className="mt-0.5 text-xs text-ink-3">{hint}</dd>}
      </div>
    );
  }
  return (
    <div className={wrap}>
      <p className="text-xs text-ink-3">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}
