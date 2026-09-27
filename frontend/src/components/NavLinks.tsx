import {
  ArrowLeftRight,
  Brain,
  CirclePlus,
  HandCoins,
  LayoutDashboard,
  ListChecks,
  Receipt,
  Settings,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import { NavLink } from 'react-router-dom';
import type { Role } from '../api';
import { monthsPhrase } from '../lib/dates';
import { plural } from '../lib/format';
import { reviewPath } from '../lib/review';
import { cx, focusRing } from '../lib/ui';

interface NavItem {
  to: string;
  label: string;
  roles: Role[];
  icon: LucideIcon;
}

const REVIEW_PATH = '/review';

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', roles: ['primary'], icon: LayoutDashboard },
  { to: REVIEW_PATH, label: 'Review', roles: ['primary'], icon: ListChecks },
  { to: '/transactions', label: 'Transactions', roles: ['primary'], icon: Receipt },
  { to: '/upload', label: 'Upload statement', roles: ['primary'], icon: Upload },
  { to: '/transfers', label: 'Transfers', roles: ['primary'], icon: ArrowLeftRight },
  { to: '/claims', label: 'Claims', roles: ['primary'], icon: HandCoins },
  { to: '/claim', label: 'Log a claim', roles: ['primary', 'secondary'], icon: CirclePlus },
  { to: '/memory', label: 'Merchant memory', roles: ['primary'], icon: Brain },
  { to: '/settings', label: 'Settings', roles: ['primary'], icon: Settings },
];

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
  return (
    <ul className="flex flex-col gap-0.5">
      {NAV_ITEMS.filter((item) => item.roles.includes(role)).map((item) => {
        const Icon = item.icon;
        const isReview = item.to === REVIEW_PATH;
        const count = isReview ? reviewCount : 0;
        return (
          <li key={item.to}>
            <NavLink
              to={isReview ? reviewPath(reviewPeriod) : item.to}
              end={item.to === '/'}
              onClick={onNavigate}
              className={({ isActive }) =>
                cx(
                  'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  focusRing,
                  isActive ? 'bg-brand-soft text-brand-strong' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    className={cx(
                      'h-4 w-4 shrink-0 transition-colors',
                      isActive ? 'text-brand' : 'text-ink-3 group-hover:text-ink-2',
                    )}
                    aria-hidden="true"
                  />
                  {item.label}
                  {count > 0 && ' '}
                  {count > 0 && (
                    <span
                      className="ml-auto rounded-full bg-warning/15 px-1.5 py-px text-2xs font-semibold leading-4 tabular text-warning-ink"
                      title={`${plural(count, 'line')} waiting for review${reviewMonths.length > 0 ? ` in ${monthsPhrase(reviewMonths)}` : ''}`}
                    >
                      <span aria-hidden="true">{count}</span>
                      <span className="sr-only">{`(${plural(count, 'line')} to review)`}</span>
                    </span>
                  )}
                </>
              )}
            </NavLink>
          </li>
        );
      })}
    </ul>
  );
}
