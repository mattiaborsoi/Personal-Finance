import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { PeriodOut } from '../api';
import { currentPeriodKey, monthName } from '../lib/dates';
import { ID_OCADO, ID_UBER, period, transaction } from '../test/fixtures';
import { jsonResponse, mockFetch, renderWithProviders, type RecordedCall } from '../test/utils';
import { ReviewPage } from './ReviewPage';

/** Shows where the router is, since a MemoryRouter never touches window.location. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

// Both months are in the past; lines wait only in July, so July is the default.
const periods: PeriodOut[] = [
  period({ period_key: '2026-08', start_date: '2026-08-01', end_date: '2026-08-31', pending_review_count: 0 }),
  period({ period_key: '2026-07', start_date: '2026-07-01', end_date: '2026-07-31', pending_review_count: 2 }),
];

const july = [
  transaction({ id: ID_OCADO, period_key: '2026-07', cleaned_merchant: 'Ocado' }),
  transaction({ id: ID_UBER, period_key: '2026-07', cleaned_merchant: 'Uber', raw_description: 'UBER *TRIP' }),
];

function queueCalls(calls: RecordedCall[]): string[] {
  return calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/transactions?')).map((c) => c.url);
}

describe('<ReviewPage />', () => {
  it('shows the approval queue for the period in the URL', async () => {
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse(periods);
      if (method === 'GET' && url.startsWith('/api/transactions?period=2026-07&')) return jsonResponse({ items: july, total: 2 });
      return undefined;
    });

    renderWithProviders(<ReviewPage />, { route: '/review?period=2026-07' });

    expect(screen.getByRole('heading', { level: 1, name: 'Review' })).toBeInTheDocument();
    expect(screen.getByText('July 2026', { selector: 'p' })).toBeInTheDocument();
    const queue = await screen.findByRole('region', { name: 'Approval queue' });
    expect(await within(queue).findByRole('button', { name: 'Ocado' })).toBeInTheDocument();
    expect(within(queue).getByRole('button', { name: 'Uber' })).toBeInTheDocument();
    expect(within(queue).getByText('2 transactions pending review')).toBeInTheDocument();
    expect(queueCalls(calls)).toEqual(['/api/transactions?period=2026-07&status=pending_review&limit=200&offset=0']);
    // The selector follows the URL once the periods are in, and says what is waiting where.
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Period' })).toHaveValue('2026-07'));
    expect(screen.getByRole('option', { name: 'July 2026 · 2 to review' })).toBeInTheDocument();
  });

  it('filters the queue by the account in the URL and keeps the month when the account changes', async () => {
    const user = userEvent.setup();
    const mixed = [july[0], { ...july[1], account_id: 'acc_checking_hsbc' }];
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse(periods);
      if (method === 'GET' && url.startsWith('/api/transactions?period=2026-07&')) return jsonResponse({ items: mixed, total: 2 });
      return undefined;
    });

    renderWithProviders(
      <>
        <ReviewPage />
        <LocationProbe />
      </>,
      { route: '/review?period=2026-07&account=acc_checking_hsbc' },
    );

    const queue = await screen.findByRole('region', { name: 'Approval queue' });
    expect(await within(queue).findByRole('button', { name: 'Uber' })).toBeInTheDocument();
    expect(within(queue).queryByRole('button', { name: 'Ocado' })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Show lines from'), '');
    expect(await within(queue).findByRole('button', { name: 'Ocado' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/review\?period=2026-07$/);
  });

  it('opens on the oldest month with lines waiting and follows the period selector', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse(periods);
      if (method === 'GET' && url.startsWith('/api/transactions?period=2026-07&')) return jsonResponse({ items: july, total: 2 });
      return undefined;
    });

    renderWithProviders(
      <>
        <ReviewPage />
        <LocationProbe />
      </>,
      { route: '/review' },
    );

    expect(await screen.findByRole('button', { name: 'Ocado' })).toBeInTheDocument();
    expect(screen.getByText('July 2026', { selector: 'p' })).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Period' }), '2026-08');

    expect(screen.getByTestId('location')).toHaveTextContent('/review?period=2026-08');
    // August has nothing, July does: say so and link there, never "all caught up".
    expect(await screen.findByText(/^Nothing waiting in August( 2026)?\.$/)).toBeInTheDocument();
    expect(screen.queryByText(/All caught up/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Review July( 2026)?$/ })).toHaveAttribute('href', '/review?period=2026-07');
    // An empty month's queue is not asked for.
    expect(queueCalls(calls)).toEqual(['/api/transactions?period=2026-07&status=pending_review&limit=200&offset=0']);
  });

  it('counts the periods again after an approval, so the selector stays current', async () => {
    const user = userEvent.setup();
    let pending = 2;
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') {
        return jsonResponse(periods.map((p) => (p.period_key === '2026-07' ? { ...p, pending_review_count: pending } : p)));
      }
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: july, total: 2 });
      if (method === 'POST' && url === `/api/transactions/${ID_OCADO}/approve`) {
        pending = 1;
        return jsonResponse(transaction({ id: ID_OCADO, review_status: 'manual_approved' }));
      }
      return undefined;
    });

    renderWithProviders(<ReviewPage />, { route: '/review?period=2026-07' });
    await screen.findByRole('option', { name: 'July 2026 · 2 to review' });
    await user.click(await screen.findByRole('button', { name: 'Approve Ocado' }));

    expect(await screen.findByRole('option', { name: 'July 2026 · 1 to review' })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'GET' && c.url === '/api/periods')).toHaveLength(2);
  });

  it('lists the queue read-only for a closed period', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') {
        return jsonResponse(periods.map((p) => (p.period_key === '2026-07' ? { ...p, is_closed: true } : p)));
      }
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: july, total: 2 });
      return undefined;
    });

    renderWithProviders(<ReviewPage />, { route: '/review?period=2026-07' });

    expect(await screen.findByText(/This period is closed, so nothing here can be approved/)).toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reopen period' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve Ocado' })).toBeDisabled();
  });
});

/** The month `back` months before this one, as YYYY-MM. */
function monthsBack(back: number): string {
  const now = new Date();
  return currentPeriodKey(new Date(now.getFullYear(), now.getMonth() - back, 1));
}

function queueFor(key: string) {
  return `/api/transactions?period=${key}&status=pending_review&limit=200&offset=0`;
}

describe('<ReviewPage /> finds the lines wherever they wait', () => {
  const current = monthsBack(0);
  const last = monthsBack(1);
  const before = monthsBack(2);

  function serve(pending: Record<string, number>) {
    return mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') {
        return jsonResponse(Object.entries(pending).map(([period_key, n]) => period({ period_key, pending_review_count: n })));
      }
      if (method === 'GET' && url.startsWith('/api/transactions?')) {
        const key = new URLSearchParams(url.split('?')[1]).get('period') ?? '';
        return jsonResponse(pending[key] ? { items: [transaction({ id: ID_OCADO, period_key: key, cleaned_merchant: 'Ocado' })], total: 1 } : { items: [], total: 0 });
      }
      return undefined;
    });
  }

  it('opens on the oldest month when lines wait only in older months, not the current one', async () => {
    const { calls } = serve({ [current]: 0, [last]: 5, [before]: 3 });

    renderWithProviders(<ReviewPage />, { route: '/review' });

    expect(await screen.findByRole('button', { name: 'Ocado' })).toBeInTheDocument();
    expect(queueCalls(calls)).toEqual([queueFor(before)]);
    expect(screen.queryByText(/All caught up/)).not.toBeInTheDocument();
  });

  it('on the current month with nothing in it, names the months that have lines and links to each', async () => {
    const { calls } = serve({ [current]: 0, [last]: 5, [before]: 3 });

    renderWithProviders(<ReviewPage />, { route: `/review?period=${current}` });

    expect(await screen.findByText(`Nothing waiting in ${monthName(current)}.`)).toBeInTheDocument();
    const hint = screen.getByText(/lines wait in/).closest('p') as HTMLElement;
    expect(hint).toHaveTextContent(`3 lines wait in ${monthName(before)} and 5 in ${monthName(last)}.`);
    expect(within(hint).getByRole('link', { name: monthName(before) })).toHaveAttribute('href', `/review?period=${before}`);
    expect(within(hint).getByRole('link', { name: monthName(last) })).toHaveAttribute('href', `/review?period=${last}`);
    expect(screen.queryByText(/All caught up/)).not.toBeInTheDocument();
    expect(queueCalls(calls)).toEqual([]);
  });

  it('opens on the current month when that is where the lines wait', async () => {
    const { calls } = serve({ [current]: 4, [last]: 0 });

    renderWithProviders(<ReviewPage />, { route: '/review' });

    expect(await screen.findByRole('button', { name: 'Ocado' })).toBeInTheDocument();
    expect(queueCalls(calls)).toEqual([queueFor(current)]);
  });

  it('says all caught up only when nothing waits anywhere', async () => {
    const { calls } = serve({ [current]: 0, [last]: 0 });

    renderWithProviders(<ReviewPage />, { route: '/review' });

    expect(await screen.findByText('Nothing to review. All caught up.')).toBeInTheDocument();
    expect(queueCalls(calls)).toEqual([queueFor(current)]);
  });
});
