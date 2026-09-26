import type { AccountFlow, CategoryAmount, MetricsOut, Money, TrendPoint } from '../api';

export type MetricView = 'macro' | 'micro' | 'liquidity';

export interface ViewDefinition {
  id: MetricView;
  label: string;
  /** Short name for compact controls. */
  short: string;
  hint: string;
  trendKey: keyof Omit<TrendPoint, 'period_key'>;
  /** Design token behind this view's accent (see src/index.css). */
  accentToken: 'accent-macro' | 'accent-micro' | 'accent-liquidity';
  /** Tailwind classes for the accent as a fill / text / soft wash. */
  accent: { bg: string; text: string; soft: string; ring: string };
}

export const VIEWS: ViewDefinition[] = [
  {
    id: 'macro',
    label: 'Macro · Household',
    short: 'Household',
    hint: 'Everything the household spent, across both of you.',
    trendKey: 'household_burn',
    accentToken: 'accent-macro',
    accent: { bg: 'bg-accent-macro', text: 'text-accent-macro', soft: 'bg-accent-macro/10', ring: 'ring-accent-macro/30' },
  },
  {
    id: 'micro',
    label: 'Micro · Personal',
    short: 'Personal',
    hint: 'Your true share of expenses after the split.',
    trendKey: 'true_net_expense',
    accentToken: 'accent-micro',
    accent: { bg: 'bg-accent-micro', text: 'text-accent-micro', soft: 'bg-accent-micro/10', ring: 'ring-accent-micro/30' },
  },
  {
    id: 'liquidity',
    label: 'Liquidity · Cash flow',
    short: 'Cash flow',
    hint: 'Money in minus money out across accounts.',
    trendKey: 'net_cash_flow',
    accentToken: 'accent-liquidity',
    accent: {
      bg: 'bg-accent-liquidity',
      text: 'text-accent-liquidity',
      soft: 'bg-accent-liquidity/10',
      ring: 'ring-accent-liquidity/30',
    },
  },
];

export function viewDefinition(view: MetricView): ViewDefinition {
  return VIEWS.find((v) => v.id === view) ?? VIEWS[0];
}

const VIEW_STORAGE_KEY = 'pf.view';

export function readStoredView(): MetricView {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (raw === 'macro' || raw === 'micro' || raw === 'liquidity') return raw;
  } catch {
    // ignore
  }
  return 'macro';
}

export function storeView(view: MetricView): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // ignore
  }
}

/**
 * A supporting figure under the headline. Sub-figures are magnitudes: they
 * render without a sign and without a colour, whatever the view.
 */
export interface SubFigure {
  label: string;
  value: Money;
}

/** "-617.27" -> "617.27". The API already sends credits/debits as magnitudes; this is belt and braces. */
export function magnitude(value: Money): Money {
  return value.replace(/^\s*[-+]/, '');
}

export type Breakdown =
  | { kind: 'category'; rows: CategoryAmount[] }
  | { kind: 'account'; rows: AccountFlow[] };

export interface ViewFigures {
  headlineLabel: string;
  headline: Money;
  subFigures: SubFigure[];
  breakdown: Breakdown;
}

export function selectViewFigures(metrics: MetricsOut, view: MetricView): ViewFigures {
  switch (view) {
    case 'micro':
      return {
        headlineLabel: 'True net expense',
        headline: metrics.micro.true_net_expense,
        subFigures: [
          { label: 'From transactions', value: metrics.micro.from_transactions },
          { label: 'From partner claims', value: metrics.micro.from_partner_claims },
        ],
        breakdown: { kind: 'category', rows: metrics.micro.by_category },
      };
    case 'liquidity':
      return {
        headlineLabel: 'Net cash flow',
        headline: metrics.liquidity.net_cash_flow,
        subFigures: [
          { label: 'Credits (in)', value: magnitude(metrics.liquidity.credits) },
          { label: 'Debits (out)', value: magnitude(metrics.liquidity.debits) },
        ],
        breakdown: { kind: 'account', rows: metrics.liquidity.by_account },
      };
    case 'macro':
    default:
      return {
        headlineLabel: 'Household burn',
        headline: metrics.macro.household_burn,
        subFigures: [
          { label: 'Primary accounts', value: metrics.macro.primary_accounts_burn },
          { label: 'Partner claims', value: metrics.macro.partner_claims_burn },
        ],
        breakdown: { kind: 'category', rows: metrics.macro.by_category },
      };
  }
}
