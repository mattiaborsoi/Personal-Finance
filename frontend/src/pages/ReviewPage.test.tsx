import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { PeriodOut } from '../api';
import { ID_OCADO, ID_UBER, period, transaction } from '../test/fixtures';
import { jsonResponse, mockFetch, renderWithProviders, type RecordedCall } from '../test/utils';
import { ReviewPage } from './ReviewPage';

/** Shows where the router is, since a MemoryRouter never touches window.location. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

// Both months are in the past, so August (the newest) is the default.
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
    const queue = screen.getByRole('region', { name: 'Approval queue' });
    expect(await within(queue).findByRole('button', { name: 'Ocado' })).toBeInTheDocument();
    expect(within(queue).getByRole('button', { name: 'Uber' })).toBeInTheDocument();
    expect(within(queue).getByText('2 transactions pending review')).toBeInTheDocument();
    expect(queueCalls(calls)).toEqual(['/api/transactions?period=2026-07&status=pending_review&limit=200&offset=0']);
    // The selector follows the URL once the periods are in, and says what is waiting where.
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Period' })).toHaveValue('2026-07'));
    expect(screen.getByRole('option', { name: 'July 2026 · 2 to review' })).toBeInTheDocument();
  });

  it('opens on the default period without one in the URL and follows the period selector', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse(periods);
      if (method === 'GET' && url.startsWith('/api/transactions?period=2026-08&')) return jsonResponse({ items: [], total: 0 });
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

    expect(await screen.findByText('Nothing to review. All caught up.')).toBeInTheDocument();
    expect(screen.getByText('August 2026', { selector: 'p' })).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Period' }), '2026-07');

    expect(screen.getByTestId('location')).toHaveTextContent('/review?period=2026-07');
    expect(await screen.findByRole('button', { name: 'Ocado' })).toBeInTheDocument();
    expect(queueCalls(calls)).toEqual([
      '/api/transactions?period=2026-08&status=pending_review&limit=200&offset=0',
      '/api/transactions?period=2026-07&status=pending_review&limit=200&offset=0',
    ]);
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
