import { LogOut, Menu, X } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, type PeriodOut } from '../api';
import { useAuth } from '../auth/AuthContext';
import { ReviewBadgeContext } from '../hooks/reviewBadge';
import { useAsync } from '../hooks/useAsync';
import { initials } from '../lib/format';
import { reviewBadge } from '../lib/review';
import { btnIcon, cx, skipLink } from '../lib/ui';
import { BrandMark, PRODUCT_NAME, Wordmark } from './BrandMark';
import { NavLinks } from './NavLinks';
import { ThemeToggle } from './ThemeToggle';

const ROLE_LABEL = { primary: 'Primary account', secondary: 'Partner' } as const;

export function Layout() {
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  // One GET /api/periods for the Review badge; pages that load the periods again share theirs, so no polling.
  const periods = useAsync(() => api.listPeriods(), 'nav-periods', session?.role === 'primary');
  const { setData: setPeriods, reload: refreshPeriods } = periods;
  const share = useCallback((list: PeriodOut[]) => setPeriods(() => list), [setPeriods]);
  const badgeSync = useMemo(() => ({ share, refresh: refreshPeriods }), [share, refreshPeriods]);

  if (!session) return null;

  // On the dashboard and the Review page the URL names the period being looked at.
  const onPeriodPage = location.pathname === '/' || location.pathname === '/review';
  const review = reviewBadge(periods.data, onPeriodPage ? new URLSearchParams(location.search).get('period') : null);

  function handleLogout() {
    logout();
    navigate('/login', { replace: true });
  }

  const userChip = (
    <div className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand-strong"
      >
        {initials(session.display_name)}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-ink">{session.display_name}</p>
        <p className="truncate text-xs text-ink-3">{ROLE_LABEL[session.role]}</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen md:flex">
      <a href="#main" className={skipLink}>
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-hairline bg-surface md:sticky md:top-0 md:flex md:h-screen md:flex-col">
        <div className="px-5 pb-4 pt-5">
          <Wordmark />
        </div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-2">
          <NavLinks role={session.role} reviewPeriod={review.period} reviewCount={review.count} />
        </nav>
        <div className="border-t border-hairline p-3">
          <div className="flex items-center justify-between gap-2 rounded-xl px-2 py-2">
            {userChip}
            <div className="flex items-center gap-1">
              <ThemeToggle />
              <button type="button" className={btnIcon} onClick={handleLogout} aria-label="Log out" title="Log out">
                <LogOut className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 border-b border-hairline bg-surface/90 backdrop-blur md:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2.5">
            <BrandMark size={26} />
            <div className="leading-tight">
              <p className="text-sm font-semibold text-ink" translate="no">
                {PRODUCT_NAME}
              </p>
              <p className="text-xs text-ink-3">{session.display_name}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <button type="button" className={btnIcon} onClick={handleLogout} aria-label="Log out" title="Log out">
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={cx(btnIcon, menuOpen && 'bg-surface-2 text-ink')}
              aria-expanded={menuOpen}
              aria-controls="mobile-nav"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? <X className="h-4 w-4" aria-hidden="true" /> : <Menu className="h-4 w-4" aria-hidden="true" />}
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav id="mobile-nav" aria-label="Main" className="border-t border-hairline px-3 py-2 animate-rise">
            <NavLinks
              role={session.role}
              onNavigate={() => setMenuOpen(false)}
              reviewPeriod={review.period}
              reviewCount={review.count}
            />
          </nav>
        )}
      </header>

      <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-5 focus:outline-none sm:px-8 sm:py-8">
        <div className="mx-auto max-w-6xl animate-rise">
          <ReviewBadgeContext.Provider value={badgeSync}>
            <Outlet />
          </ReviewBadgeContext.Provider>
        </div>
      </main>
    </div>
  );
}
