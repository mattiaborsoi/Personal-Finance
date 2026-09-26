import {
  ArrowLeftRight,
  Brain,
  CirclePlus,
  HandCoins,
  LayoutDashboard,
  Receipt,
  Settings,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import { NavLink } from 'react-router-dom';
import type { Role } from '../api';
import { cx, focusRing } from '../lib/ui';

interface NavItem {
  to: string;
  label: string;
  roles: Role[];
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', roles: ['primary'], icon: LayoutDashboard },
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
}

export function NavLinks({ role, onNavigate }: Props) {
  return (
    <ul className="flex flex-col gap-0.5">
      {NAV_ITEMS.filter((item) => item.roles.includes(role)).map((item) => {
        const Icon = item.icon;
        return (
          <li key={item.to}>
            <NavLink
              to={item.to}
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
                </>
              )}
            </NavLink>
          </li>
        );
      })}
    </ul>
  );
}
