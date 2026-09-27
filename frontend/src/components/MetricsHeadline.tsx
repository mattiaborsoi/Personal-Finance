import { MoneyText } from './MoneyText';
import type { ViewFigures } from '../lib/views';
import { cardInset, cx, eyebrow } from '../lib/ui';

interface Props {
  figures: ViewFigures;
  hint: string;
  /** Sign and colour the headline (cash flow view). Sub-figures are always plain magnitudes. */
  signed?: boolean;
  /** Accent text class for the small marker beside the label. */
  accentClass?: string;
}

/** The view's hero figure (one per view, proportional figures) and its two supporting stat tiles. */
export function MetricsHeadline({ figures, hint, signed = false, accentClass = 'bg-brand' }: Props) {
  return (
    <div>
      <p className={cx(eyebrow, 'flex items-center gap-2')}>
        <span aria-hidden="true" className={cx('h-2 w-2 rounded-full', accentClass)} />
        {figures.headlineLabel}
      </p>
      <p className="mt-2 text-[2.75rem] font-semibold leading-none tracking-tight text-ink sm:text-5xl">
        {/* The hero figure reads in proportional numerals (DESIGN.md); MoneyText's `.tabular` is for columns. */}
        <MoneyText value={figures.headline} tone={signed} signed={signed} className="!normal-nums" />
      </p>
      <p className="mt-3 max-w-xs text-sm text-ink-2">{hint}</p>
      <dl className="mt-5 grid grid-cols-2 gap-3">
        {figures.subFigures.map((sub) => (
          <div key={sub.label} className={cardInset}>
            <dt className="text-xs text-ink-3">{sub.label}</dt>
            <dd className="mt-0.5 text-lg font-semibold text-ink">
              <MoneyText value={sub.value} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
