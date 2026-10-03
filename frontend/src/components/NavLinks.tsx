import {
  Brain,
  CirclePlus,
  HandCoins,
  LayoutDashboard,
  Receipt,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { useId } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { Role } from '../api';
import { monthsPhrase } from '../lib/dates';
import { plural } from '../lib/format';
import { reviewPath } from '../lib/review';
import { cx, eyebrow, focusRing } from '../lib/ui';

interface NavItem {
  to: string;
  label: string;
  roles: Role[];
  /** Top-level items carry an icon; children are text only. */
  icon?: LucideIcon;
  /** Pages that belong to this one, listed indented under it. */
  children?: NavItem[];
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const REVIEW_PATH = '/review';

/*
  Three groups: the money itself, what the two of you owe each other, and the
  setup behind both. Review, the upload and transfer matching all work on
  transactions, so they sit under it; logging a claim sits under the claims list.
  Children are always shown (no collapsing), so the Review count stays in view.
*/
const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Money',
    items: [
      { to: '/', label: 'Dashboard', roles: ['primary'], icon: LayoutDashboard },
      {
        to: '/transactions',
        label: 'Transactions',
        roles: ['primary'],
        icon: Receipt,
        children: [
          { to: REVIEW_PATH, label: 'Review', roles: ['primary'] },
          { to: '/upload', label: 'Upload statement', roles: ['primary'] },
          { to: '/transfers', label: 'Transfers', roles: ['primary'] },
        ],
      },
    ],
  },
  {
    label: 'Partner',
    items: [
      {
        to: '/claims',
        label: 'Claims',
        roles: ['primary'],
        icon: HandCoins,
        // The partner sees only this page; with its parent hidden it stands on its own, with this icon.
        children: [{ to: '/claim', label: 'Log a claim', roles: ['primary', 'secondary'], icon: CirclePlus }],
      },
    ],
  },
  {
    label: 'Setup',
    items: [
      { to: '/memory', label: 'Merchant memory', roles: ['primary'], icon: Brain },
      { to: '/settings', label: 'Settings', roles: ['primary'], icon: Settings },
    ],
  },
];

/** The groups `role` can see; a child whose parent is hidden moves up to the top level. */
function visibleGroups(role: Role): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    label: group.label,
    items: group.items.flatMap((item): NavItem[] => {
      const children = (item.children ?? []).filter((child) => child.roles.includes(role));
      if (item.roles.includes(role)) return [{ ...item, children }];
      return children;
    }),
  })).filter((group) => group.items.length > 0);
}

function matches(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/';
  return pathname === to || pathname.startsWith(`${to}/`);
}

interface Props {
  role: Role;
  onNavigate?: () => void;
  /** The period the Review link opens on (see `reviewBadge`); null for the page's default. */
  reviewPeriod?: string | null;
  /** Lines waiting for review across every month; the badge shows only above zero. */
  reviewCount?: number;
  /** The months those lines are in, for the badge's tooltip. */
  reviewMonths?: string[];
}

export function NavLinks({ role, onNavigate, reviewPeriod = null, reviewCount = 0, reviewMonths = [] }: Props) {
  const { pathname } = useLocation();
  const idBase = useId();
  const groups = visibleGroups(role);
  // One group (the partner's single page) needs no heading.
  const labelled = groups.length > 1;

  function badge(item: NavItem) {
    if (item.to !== REVIEW_PATH || reviewCount <= 0) return null;
    return (
      <>
        {' '}
        <span
          className="ml-auto rounded-full bg-warning/15 px-1.5 py-px text-2xs font-semibold leading-4 tabular text-warning-ink"
          title={`${plural(reviewCount, 'line')} waiting for review${reviewMonths.length > 0 ? ` in ${monthsPhrase(reviewMonths)}` : ''}`}
        >
          <span aria-hidden="true">{reviewCount}</span>
          <span className="sr-only">{`(${plural(reviewCount, 'line')} to review)`}</span>
        </span>
      </>
    );
  }

  function href(item: NavItem): string {
    return item.to === REVIEW_PATH ? reviewPath(reviewPeriod) : item.to;
  }

  function child(item: NavItem) {
    const current = matches(pathname, item.to);
    return (
      <li key={item.to} className="relative">
        {/* The active child marks its stretch of the guide line. */}
        {current && <span aria-hidden="true" className="absolute -left-px inset-y-1 w-0.5 rounded-full bg-brand" />}
        <Link
          to={href(item)}
          onClick={onNavigate}
          aria-current={current ? 'page' : undefined}
          className={cx(
            'flex items-center gap-3 rounded-lg px-3 py-1.5 text-sm transition-colors',
            focusRing,
            current ? 'bg-brand-soft font-medium text-brand-strong' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
          )}
        >
          {item.label}
          {badge(item)}
        </Link>
      </li>
    );
  }

  function topLevel(item: NavItem) {
    const Icon = item.icon;
    const current = matches(pathname, item.to);
    const children = item.children ?? [];
    // A parent whose child page is open is marked as the current section, not as the page.
    const holdsCurrent = !current && children.some((c) => matches(pathname, c.to));
    return (
      <li key={item.to}>
        <Link
          to={href(item)}
          onClick={onNavigate}
          aria-current={current ? 'page' : holdsCurrent ? 'true' : undefined}
          className={cx(
            'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            focusRing,
            current
              ? 'bg-brand-soft text-brand-strong'
              : holdsCurrent
                ? 'text-ink hover:bg-surface-2'
                : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
          )}
        >
          {Icon && (
            <Icon
              className={cx(
                'h-4 w-4 shrink-0 transition-colors',
                current || holdsCurrent ? 'text-brand' : 'text-ink-3 group-hover:text-ink-2',
              )}
              aria-hidden="true"
            />
          )}
          {item.label}
          {badge(item)}
        </Link>
        {children.length > 0 && (
          // The guide line runs under the parent's icon; children line up with its label.
          <ul className="mb-1 ml-5 mt-0.5 flex flex-col gap-0.5 border-l border-hairline pl-2">{children.map(child)}</ul>
        )}
      </li>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => {
        const labelId = `${idBase}-${group.label.toLowerCase()}`;
        return (
          <div key={group.label}>
            {labelled && (
              <p id={labelId} className={cx(eyebrow, 'px-3 pb-1.5')}>
                {group.label}
              </p>
            )}
            <ul aria-labelledby={labelled ? labelId : undefined} className="flex flex-col gap-0.5">
              {group.items.map(topLevel)}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
