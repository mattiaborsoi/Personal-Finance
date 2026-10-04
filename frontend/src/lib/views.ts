import { PARTNER_CLAIMS_CATEGORY, type AccountFlow, type CategoryAmount, type MetricsOut, type Money, type TrendPoint } from '../api';
import { periodLabel } from './dates';
import { toNumber } from './money';

export type MetricView = 'macro' | 'micro' | 'liquidity';

export interface ViewDefinition {
  id: MetricView;
  /** Plain words; the colour dot beside it carries the view's identity. */
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
    label: 'Household',
    short: 'Household',
    hint: 'Everything the household spent, across both of you.',
    trendKey: 'household_burn',
    accentToken: 'accent-macro',
    accent: { bg: 'bg-accent-macro', text: 'text-accent-macro', soft: 'bg-accent-macro/10', ring: 'ring-accent-macro/30' },
  },
  {
    id: 'micro',
    label: 'My share',
    short: 'My share',
    hint: 'Your true share of expenses after the split.',
    trendKey: 'true_net_expense',
    accentToken: 'accent-micro',
    accent: { bg: 'bg-accent-micro', text: 'text-accent-micro', soft: 'bg-accent-micro/10', ring: 'ring-accent-micro/30' },
  },
  {
    id: 'liquidity',
    label: 'Cash flow',
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

/** Whether the Household headline is net of refunds (the default) or gross; remembered per browser. */
export type RefundsMode = 'net' | 'gross';

const REFUNDS_STORAGE_KEY = 'pf.refunds';

export function readRefundsMode(): RefundsMode {
  try {
    if (localStorage.getItem(REFUNDS_STORAGE_KEY) === 'gross') return 'gross';
  } catch {
    // ignore
  }
  return 'net';
}

export function storeRefundsMode(mode: RefundsMode): void {
  try {
    localStorage.setItem(REFUNDS_STORAGE_KEY, mode);
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
  /** A short note under the figure, e.g. how many claims make it up. */
  note?: string;
  /** A note that is a money figure, formatted with the currency: "Refunds £83.00". */
  noteMoney?: { label: string; value: Money };
}

/** "-617.27" -> "617.27". The API already sends credits/debits as magnitudes; this is belt and braces. */
export function magnitude(value: Money): Money {
  return value.replace(/^\s*[-+]/, '');
}

function fixed(n: number): Money {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export type Breakdown =
  | {
      kind: 'category';
      /** Spend categories only: partner claims are not a category and are carried in `claims`. */
      rows: CategoryAmount[];
      /** Partner claims as their own segment beside the categories, when the month has any. */
      claims?: { amount: Money; count: number | null };
      /** Refunds received in the period, shown as a footnote (the gross headline does not deduct them). */
      refunds?: Money;
    }
  | { kind: 'account'; rows: AccountFlow[] };

/**
 * The chart's Y domain: a fixed 0–100 when every value is zero, so the axis never
 * shows £1–£4 ticks over nothing; otherwise the axis always includes 0, so a small
 * range never looks dramatic (`'auto'` only on the side that already crosses 0).
 */
export function trendYDomain(values: ReadonlyArray<number>): [number | 'auto', number | 'auto'] {
  const finite = values.filter((v) => Number.isFinite(v));
  const allZero = finite.every((v) => Math.abs(v) < 0.005);
  if (allZero) return [0, 100];
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (min >= 0) return [0, 'auto'];
  if (max <= 0) return ['auto', 0];
  return ['auto', 'auto'];
}

/** The month before `period` in the trend, when the series has it: how the headline moved. */
export interface HeadlineChange {
  /** This month minus the previous one. */
  delta: number;
  /** As a fraction of the previous month (0.12 = up 12 %); null when the previous month was 0. */
  fraction: number | null;
  /** "August 2026" */
  previousLabel: string;
}

/** The trend series behind a view: Household follows the net/gross switch, like its headline. */
export function trendKeyFor(view: MetricView, refunds: RefundsMode = 'net'): ViewDefinition['trendKey'] {
  return view === 'macro' && refunds === 'net' ? 'household_net' : viewDefinition(view).trendKey;
}

export function headlineChange(
  trend: ReadonlyArray<TrendPoint>,
  period: string,
  view: MetricView,
  refunds: RefundsMode = 'net',
): HeadlineChange | null {
  const key = trendKeyFor(view, refunds);
  const at = trend.findIndex((p) => p.period_key === period);
  if (at <= 0) return null;
  const current = toNumber(trend[at][key]);
  const previous = toNumber(trend[at - 1][key]);
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  const delta = Math.round((current - previous) * 100) / 100;
  return {
    delta,
    fraction: Math.abs(previous) < 0.005 ? null : delta / Math.abs(previous),
    previousLabel: periodLabel(trend[at - 1].period_key),
  };
}

export interface CategoryGroup {
  /** "Bills" for "Bills:Water"; a bare name is its own group. */
  group: string;
  amount: number;
  rows: CategoryAmount[];
}

/** "Bills:Water" -> "Bills"; "Groceries" -> "Groceries". */
export function categoryGroupName(category: string): string {
  const at = category.indexOf(':');
  return at > 0 ? category.slice(0, at).trim() : category;
}

/** Categories grouped under their top-level group, largest group first, rows largest first within it. */
export function groupCategories(rows: ReadonlyArray<CategoryAmount>): CategoryGroup[] {
  const groups = new Map<string, CategoryGroup>();
  for (const row of rows) {
    const name = categoryGroupName(row.category);
    const amount = Math.abs(toNumber(row.amount)) || 0;
    const group = groups.get(name) ?? { group: name, amount: 0, rows: [] };
    group.amount += amount;
    group.rows.push(row);
    groups.set(name, group);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, rows: [...g.rows].sort((a, b) => Math.abs(toNumber(b.amount)) - Math.abs(toNumber(a.amount))) }))
    .sort((a, b) => b.amount - a.amount || a.group.localeCompare(b.group));
}

export interface ViewFigures {
  headlineLabel: string;
  headline: Money;
  subFigures: SubFigure[];
  breakdown: Breakdown;
}

export function selectViewFigures(metrics: MetricsOut, view: MetricView, refunds: RefundsMode = 'net'): ViewFigures {
  switch (view) {
    case 'micro':
      return {
        headlineLabel: 'True net expense',
        headline: metrics.micro.true_net_expense,
        subFigures: [
          { label: 'From transactions', value: metrics.micro.from_transactions },
          { label: 'From partner claims', value: metrics.micro.from_partner_claims },
        ],
        breakdown: {
          kind: 'category',
          rows: metrics.micro.by_category.filter((r) => r.category !== PARTNER_CLAIMS_CATEGORY),
          claims: toNumber(metrics.micro.from_partner_claims) > 0 ? { amount: metrics.micro.from_partner_claims, count: null } : undefined,
        },
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
    default: {
      const gross = toNumber(metrics.macro.household_burn);
      const refunded = Math.abs(toNumber(metrics.macro.refunds)) || 0;
      const net = fixed(gross - refunded);
      const claimsCount = metrics.macro.partner_claims_count ?? null;
      return {
        headlineLabel: refunds === 'net' ? 'Household spend, net of refunds' : 'Household spend, gross',
        headline: refunds === 'net' ? net : metrics.macro.household_burn,
        subFigures: [
          refunds === 'net'
            ? { label: 'Gross spend', value: metrics.macro.household_burn, noteMoney: { label: 'Refunds', value: fixed(refunded) } }
            : { label: 'Net of refunds', value: net, noteMoney: { label: 'Refunds', value: fixed(refunded) } },
          { label: 'From your accounts', value: metrics.macro.primary_accounts_burn },
          {
            label: 'Partner claims',
            value: metrics.macro.partner_claims_burn,
            note: claimsCount === null ? undefined : `${claimsCount} ${claimsCount === 1 ? 'claim' : 'claims'}`,
          },
        ],
        breakdown: {
          kind: 'category',
          rows: metrics.macro.by_category.filter((r) => r.category !== PARTNER_CLAIMS_CATEGORY),
          claims: toNumber(metrics.macro.partner_claims_burn) > 0 ? { amount: metrics.macro.partner_claims_burn, count: claimsCount } : undefined,
          refunds: metrics.macro.refunds,
        },
      };
    }
  }
}
