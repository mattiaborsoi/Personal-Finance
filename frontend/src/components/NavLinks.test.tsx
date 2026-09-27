import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { PeriodOut } from '../api';
import { App } from '../App';
import { ID_OCADO, ID_UBER, period, transaction } from '../test/fixtures';
import { fixtureConfig, jsonResponse, mockFetch, renderWithProviders, secondarySession, type RecordedCall } from '../test/utils';
import { NavLinks } from './NavLinks';

// Both months are in the past, so August (the newest) is the default one.
const periods: PeriodOut[] = [
  period({ period_key: '2026-08', start_date: '2026-08-01', end_date: '2026-08-31', pending_review_count: 5 }),
  period({ period_key: '2026-07', start_date: '2026-07-01', end_date: '2026-07-31', pending_review_count: 2 }),
];

function periodFetches(calls: RecordedCall[]): number {
  return calls.filter((c) => c.method === 'GET' && c.url === '/api/periods').length;
}

function mainNav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Main' });
}

describe('<NavLinks />', () => {
  it('puts Review between Dashboard and Transactions, with no badge when nothing is waiting', () => {
    mockFetch(() => undefined);
    renderWithProviders(<NavLinks role="primary" />);

    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Dashboard',
      'Review',
      'Transactions',
      'Upload statement',
      'Transfers',
      'Claims',
      'Log a claim',
      'Merchant memory',
      'Settings',
    ]);
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/review');
  });

  it('shows the count of lines waiting in the period, and opens Review on it', () => {
    mockFetch(() => undefined);
    renderWithProviders(<NavLinks role="primary" reviewPeriod="2026-07" reviewCount={12} />);

    const link = screen.getByRole('link', { name: 'Review (12 pending)' });
    expect(link).toHaveAttribute('href', '/review?period=2026-07');
    const badge = within(link).getByTitle('12 lines waiting for review in July 2026');
    expect(badge).toHaveTextContent('12');
  });

  it('is not offered to the partner', () => {
    mockFetch(() => undefined);
    renderWithProviders(<NavLinks role="secondary" reviewPeriod="2026-07" reviewCount={12} />);

    expect(screen.queryByRole('link', { name: /Review/ })).not.toBeInTheDocument();
  });
});

describe('the Review badge in the app shell', () => {
  it('counts the default period with a single request away from the dashboard and the Review page', async () => {
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method === 'GET' && url === '/api/periods') return jsonResponse(periods);
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: [], total: 0 });
      return undefined;
    });

    renderWithProviders(<App />, { route: '/transactions?period=2026-07' });

    // A period filter on the Transactions page is not "the period being looked at".
    const link = await within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', {
      name: 'Review (5 pending)',
    });
    expect(link).toHaveAttribute('href', '/review?period=2026-08');
    // The shell asks once, and the Transactions page once for its own filters.
    await waitFor(() => expect(periodFetches(calls)).toBe(2));
  });

  it('follows the period in the URL and keeps up with approvals without polling', async () => {
    const user = userEvent.setup();
    let july = 2;
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method === 'GET' && url === '/api/periods') {
        return jsonResponse(periods.map((p) => (p.period_key === '2026-07' ? { ...p, pending_review_count: july } : p)));
      }
      if (method === 'GET' && url.startsWith('/api/transactions?')) {
        return jsonResponse({
          items: [
            transaction({ id: ID_OCADO, period_key: '2026-07', cleaned_merchant: 'Ocado' }),
            transaction({ id: ID_UBER, period_key: '2026-07', cleaned_merchant: 'Uber', raw_description: 'UBER *TRIP' }),
          ],
          total: 2,
        });
      }
      if (method === 'POST' && url === `/api/transactions/${ID_OCADO}/approve`) {
        july = 1;
        return jsonResponse(transaction({ id: ID_OCADO, review_status: 'manual_approved' }));
      }
      return undefined;
    });

    renderWithProviders(<App />, { route: '/review?period=2026-07' });

    const link = await within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', {
      name: 'Review (2 pending)',
    });
    expect(link).toHaveAttribute('href', '/review?period=2026-07');
    expect(link).toHaveAttribute('aria-current', 'page');

    await user.click(await screen.findByRole('button', { name: 'Approve Ocado' }));

    // The page counts again after the approval and hands the result to the badge.
    expect(await within(mainNav()).findByRole('link', { name: 'Review (1 pending)' })).toBeInTheDocument();
    // The shell once, the page once, and the page again after the approval: nothing more.
    expect(periodFetches(calls)).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(periodFetches(calls)).toBe(3);
  });

  it('drops the badge once the period has nothing waiting', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method === 'GET' && url === '/api/periods') {
        return jsonResponse(periods.map((p) => ({ ...p, pending_review_count: 0 })));
      }
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: [], total: 0 });
      return undefined;
    });

    renderWithProviders(<App />, { route: '/review?period=2026-07' });

    expect(await screen.findByText('Nothing to review. All caught up.')).toBeInTheDocument();
    expect(within(mainNav()).getByRole('link', { name: 'Review' })).toBeInTheDocument();
  });

  it('asks nothing for the partner', async () => {
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      return undefined;
    });

    renderWithProviders(<App />, { route: '/claim', session: secondarySession });

    expect(await within(await screen.findByRole('navigation', { name: 'Main' })).findByRole('link', { name: 'Log a claim' })).toBeInTheDocument();
    expect(periodFetches(calls)).toBe(0);
  });
});
