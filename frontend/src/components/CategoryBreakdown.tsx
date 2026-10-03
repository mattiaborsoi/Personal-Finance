import { ChevronDown, ChevronRight, HandCoins } from 'lucide-react';
import { useState } from 'react';
import { UNCATEGORIZED } from '../api';
import { useConfig } from '../config/ConfigContext';
import { categoryEmoji } from '../lib/categories';
import { accountLabel, categoryLabel } from '../lib/format';
import { toNumber } from '../lib/money';
import { btnGhost, btnSmall, cx, focusRing } from '../lib/ui';
import { groupCategories, type Breakdown, type CategoryGroup } from '../lib/views';
import { EmptyState } from './EmptyState';
import { MoneyText } from './MoneyText';

interface Props {
  breakdown: Breakdown;
  /** Fill class for the proportional bars (the active view's accent). */
  accentClass?: string;
}

/** How many groups show before "Show all". */
export const TOP_GROUPS = 8;
/** The smallest bar, as a share of the widest, so the tail is a visible mark rather than a hairline. */
const MIN_BAR = 5;

function barWidth(amount: number, max: number): number {
  return Math.max(MIN_BAR, Math.round((amount / max) * 100));
}

/** "Housing › Service charges" for a lone sub-category, else the sub-category's own name. */
function subLabel(category: string): string {
  const label = categoryLabel(category);
  const at = label.indexOf(' › ');
  return at > 0 ? label.slice(at + 3) : label;
}

function Bar({ width, accentClass, thin = false }: { width: number; accentClass: string; thin?: boolean }) {
  return (
    <div className={cx('w-full overflow-hidden rounded-full bg-surface-3', thin ? 'h-1' : 'h-1.5')} aria-hidden="true">
      <div className={cx('rounded-r-full', thin ? 'h-1' : 'h-1.5', accentClass)} style={{ width: `${width}%` }} />
    </div>
  );
}

interface GroupRowProps {
  group: CategoryGroup;
  max: number;
  total: number;
  accentClass: string;
}

/** One top-level group: its total and bar; when it holds several categories, a disclosure lists them. */
function GroupRow({ group, max, total, accentClass }: GroupRowProps) {
  const config = useConfig();
  const [open, setOpen] = useState(false);
  const emoji = categoryEmoji(group.rows[0].category || UNCATEGORIZED, config.category_emojis);
  const expandable = group.rows.length > 1;
  const share = total > 0 ? Math.round((group.amount / total) * 100) : 0;
  const name = group.group === UNCATEGORIZED ? categoryLabel(UNCATEGORIZED) : group.group;
  const subMax = Math.max(...group.rows.map((r) => Math.abs(toNumber(r.amount))), 0.01);
  return (
    <li>
      <div className="flex items-center justify-between gap-3 text-sm">
        {expandable ? (
          <button
            type="button"
            className={cx('flex min-w-0 items-center gap-1.5 rounded text-left text-ink', focusRing)}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden="true" />
            )}
            {emoji && (
              <span className="shrink-0" aria-hidden="true">
                {emoji}
              </span>
            )}
            <span className="truncate">{name}</span>
            <span className="shrink-0 text-xs text-ink-3">{group.rows.length}</span>
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 text-ink">
            {emoji && (
              <span className="shrink-0" aria-hidden="true">
                {emoji}
              </span>
            )}
            <span className="truncate">{categoryLabel(group.rows[0].category || UNCATEGORIZED)}</span>
          </span>
        )}
        <span className="flex shrink-0 items-baseline gap-2">
          <span className="text-xs tabular text-ink-3">{share}%</span>
          <MoneyText value={group.amount} className="font-semibold" />
        </span>
      </div>
      <div className="mt-1.5">
        <Bar width={barWidth(group.amount, max)} accentClass={accentClass} />
      </div>
      {expandable && open && (
        <ul className="mt-2 space-y-2 border-l border-hairline pl-4">
          {group.rows.map((row) => {
            const amount = Math.abs(toNumber(row.amount)) || 0;
            return (
              <li key={row.category}>
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="truncate text-ink-2">{subLabel(row.category)}</span>
                  <MoneyText value={row.amount} className="shrink-0 font-medium text-ink" />
                </div>
                <div className="mt-1">
                  <Bar width={barWidth(amount, subMax)} accentClass={cx(accentClass, 'opacity-60')} thin />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/** Category (or account) list for the active metric view, with a proportional bar per group. */
export function CategoryBreakdown({ breakdown, accentClass = 'bg-brand' }: Props) {
  const config = useConfig();
  const [showAll, setShowAll] = useState(false);

  if (breakdown.kind === 'account') {
    // Only accounts that moved: an idle current account is noise on a cash-flow list.
    const rows = breakdown.rows.filter((row) => Math.abs(toNumber(row.credits)) >= 0.005 || Math.abs(toNumber(row.debits)) >= 0.005);
    if (rows.length === 0) return <EmptyState title="No account activity this period" />;
    return (
      // Name and net on one line, in and out underneath: nothing to clip, however narrow the card.
      <ul className="divide-y divide-hairline" aria-label="By account">
        {rows.map((row) => (
          <li key={row.account_id} className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{accountLabel(config.accounts, row.account_id)}</p>
              <p className="mt-0.5 text-xs tabular text-ink-3">
                In <MoneyText value={row.credits} className="text-ink-2" /> · Out <MoneyText value={row.debits} className="text-ink-2" />
              </p>
            </div>
            <MoneyText value={row.net} tone signed className="shrink-0 text-sm font-semibold" />
          </li>
        ))}
      </ul>
    );
  }

  const groups = groupCategories(breakdown.rows);
  const claims = breakdown.claims && Math.abs(toNumber(breakdown.claims.amount)) >= 0.005 ? breakdown.claims : undefined;
  const claimsAmount = claims ? Math.abs(toNumber(claims.amount)) : 0;
  const max = Math.max(...groups.map((g) => g.amount), claimsAmount, 0.01);
  const total = groups.reduce((sum, g) => sum + g.amount, 0) + claimsAmount;
  const visible = showAll ? groups : groups.slice(0, TOP_GROUPS);
  const hidden = groups.length - visible.length;
  // The headline is gross spend; refunds are worth knowing about but are deliberately not netted off it.
  const refunds = Math.abs(toNumber(breakdown.refunds));
  const hasRefunds = Number.isFinite(refunds) && refunds >= 0.005;

  return (
    <>
      {groups.length === 0 && !claims ? (
        <EmptyState title="No categorised spend this period" />
      ) : (
        <ul className="space-y-3">
          {visible.map((group) => (
            <GroupRow key={group.group} group={group} max={max} total={total} accentClass={accentClass} />
          ))}
          {claims && (
            <li data-testid="claims-segment">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-1.5 text-ink">
                  <HandCoins className="h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
                  <span className="truncate">Partner claims</span>
                  {claims.count !== null && <span className="shrink-0 text-xs text-ink-3">{claims.count}</span>}
                </span>
                <span className="flex shrink-0 items-baseline gap-2">
                  <span className="text-xs tabular text-ink-3">{total > 0 ? Math.round((claimsAmount / total) * 100) : 0}%</span>
                  <MoneyText value={claims.amount} className="font-semibold" />
                </span>
              </div>
              <div className="mt-1.5">
                {/* Claims are not a category: a hatched bar keeps them apart from the categorised spend. */}
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
                  <div
                    className={cx('h-1.5 rounded-r-full opacity-50', accentClass)}
                    style={{
                      width: `${barWidth(claimsAmount, max)}%`,
                      backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 3px, rgb(255 255 255 / 0.45) 3px 5px)',
                    }}
                  />
                </div>
              </div>
            </li>
          )}
        </ul>
      )}
      {hidden > 0 && (
        <button type="button" className={cx(btnGhost, btnSmall, '-ml-2.5 mt-3')} onClick={() => setShowAll(true)}>
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          Show all {groups.length}
        </button>
      )}
      {showAll && groups.length > TOP_GROUPS && (
        <button type="button" className={cx(btnGhost, btnSmall, '-ml-2.5 mt-3')} onClick={() => setShowAll(false)}>
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          Show top {TOP_GROUPS}
        </button>
      )}
      {hasRefunds && (
        <p className="mt-4 text-xs text-ink-3" data-testid="refunds-note">
          Refunds received this month: <MoneyText value={refunds} />
        </p>
      )}
    </>
  );
}
