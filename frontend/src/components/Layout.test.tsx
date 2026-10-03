import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { PeriodOut } from '../api';
import { currentPeriodKey } from '../lib/dates';
import { period } from '../test/fixtures';
import { jsonResponse, mockFetch, renderWithProviders } from '../test/utils';
import { Layout } from './Layout';

/** The month `back` months before this one, as YYYY-MM. */
function monthsBack(back: number): string {
  const now = new Date();
  return currentPeriodKey(new Date(now.getFullYear(), now.getMonth() - back, 1));
}

function renderShell(periods: PeriodOut[], route = '/') {
  mockFetch(({ method, url }) => (method === 'GET' && url === '/api/periods' ? jsonResponse(periods) : undefined));
  renderWithProviders(
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<p>Page body</p>} />
      </Route>
    </Routes>,
    { route },
  );
}

async function reviewLink(name: string | RegExp): Promise<HTMLElement> {
  return within(screen.getByRole('navigation', { name: 'Main' })).findByRole('link', { name });
}

describe('<Layout /> Review badge', () => {
  it('counts lines waiting in older months while the current month has none', async () => {
    renderShell([
      period({ period_key: monthsBack(0), pending_review_count: 0 }),
      period({ period_key: monthsBack(1), pending_review_count: 5 }),
      period({ period_key: monthsBack(2), pending_review_count: 3 }),
    ]);

    const link = await reviewLink('Review (8 lines to review)');
    // No period in the URL, so the Review page picks the month (the oldest with lines waiting).
    expect(link).toHaveAttribute('href', '/review');
  });

  it('adds the current month to the count when lines wait there too', async () => {
    renderShell(
      [
        period({ period_key: monthsBack(0), pending_review_count: 4 }),
        period({ period_key: monthsBack(1), pending_review_count: 1 }),
      ],
      `/?period=${monthsBack(0)}`,
    );

    expect(await reviewLink('Review (5 lines to review)')).toHaveAttribute('href', `/review?period=${monthsBack(0)}`);
  });

  it('shows no badge when nothing waits anywhere', async () => {
    renderShell([
      period({ period_key: monthsBack(0), pending_review_count: 0 }),
      period({ period_key: monthsBack(1), pending_review_count: 0 }),
    ]);

    // Let the periods arrive before checking that no badge came with them.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await reviewLink('Review')).toBeInTheDocument();
    expect(screen.queryByText(/to review/)).not.toBeInTheDocument();
  });
});

describe('<Layout />', () => {
  it('offers a skip link as the first stop that lands on the main content', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => (method === 'GET' && url === '/api/periods' ? jsonResponse([]) : undefined));

    renderWithProviders(
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<p>Page body</p>} />
        </Route>
      </Routes>,
    );

    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip).toHaveAttribute('href', '#main');
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(main).toHaveTextContent('Page body');

    await user.tab();
    expect(skip).toHaveFocus();
  });
});

describe('<Layout /> on a phone', () => {
  it('opens the same grouped navigation from the header and closes it when a link is followed', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) =>
      method === 'GET' && url === '/api/periods' ? jsonResponse([period({ period_key: monthsBack(1), pending_review_count: 2 })]) : undefined,
    );
    renderWithProviders(
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<p>Page body</p>} />
          <Route path="*" element={<p>Another page</p>} />
        </Route>
      </Routes>,
    );

    // The sidebar's navigation is always there (hidden by CSS on a phone); the menu adds the second.
    expect(screen.getAllByRole('navigation', { name: 'Main' })).toHaveLength(1);
    const toggle = screen.getByRole('button', { name: 'Open menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true');
    const [sidebar, menu] = screen.getAllByRole('navigation', { name: 'Main' });
    expect(menu).toHaveAttribute('id', 'mobile-nav');
    const names = (nav: HTMLElement) => within(nav).getAllByRole('link').map((l) => l.textContent);
    expect(names(menu)).toEqual(names(sidebar));
    expect(within(menu).getByRole('list', { name: 'Partner' })).toBeInTheDocument();
    expect(await within(menu).findByRole('link', { name: 'Review (2 lines to review)' })).toBeInTheDocument();

    await user.click(within(menu).getByRole('link', { name: 'Transfers' }));
    expect(await screen.findByText('Another page')).toBeInTheDocument();
    expect(screen.getAllByRole('navigation', { name: 'Main' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveAttribute('aria-expanded', 'false');
    // The open page and its section are marked in the sidebar.
    expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Transfers' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Transactions' })).toHaveAttribute('aria-current', 'true');
  });
});
