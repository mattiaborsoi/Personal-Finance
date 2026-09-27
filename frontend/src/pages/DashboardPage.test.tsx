import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PeriodOut } from '../api';
import { period } from '../test/fixtures';
import { jsonResponse, mockFetch, renderWithProviders, type RecordedCall } from '../test/utils';
import { DashboardPage } from './DashboardPage';

function periodsWith(pending: number): PeriodOut[] {
  return [
    period({ period_key: '2026-07', start_date: '2026-07-01', end_date: '2026-07-31', transaction_count: 40, pending_review_count: pending }),
  ];
}

function queueRequests(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.url.includes('status=pending_review'));
}

describe('<DashboardPage />', () => {
  it('says how many lines are waiting and links to the Review page on the same period, without the queue itself', async () => {
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse(periodsWith(12));
      return undefined;
    });

    renderWithProviders(<DashboardPage />, { route: '/?period=2026-07' });

    const card = await screen.findByRole('region', { name: 'Waiting for review' });
    expect(card).toHaveTextContent('12 lines waiting for review');
    expect(within(card).getByRole('link', { name: 'Review now' })).toHaveAttribute('href', '/review?period=2026-07');
    // The queue lives on the Review page now: the dashboard neither shows it nor asks for it.
    expect(screen.queryByRole('region', { name: 'Approval queue' })).not.toBeInTheDocument();
    expect(queueRequests(calls)).toEqual([]);
  });

  it('uses the singular for one line', async () => {
    mockFetch(({ method, url }) => (method === 'GET' && url === '/api/periods' ? jsonResponse(periodsWith(1)) : undefined));

    renderWithProviders(<DashboardPage />, { route: '/?period=2026-07' });

    expect(await screen.findByRole('region', { name: 'Waiting for review' })).toHaveTextContent('1 line waiting for review');
  });

  it('shows no card when nothing is waiting', async () => {
    mockFetch(({ method, url }) => (method === 'GET' && url === '/api/periods' ? jsonResponse(periodsWith(0)) : undefined));

    renderWithProviders(<DashboardPage />, { route: '/?period=2026-07' });

    expect(await screen.findByRole('option', { name: 'July 2026' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Waiting for review' })).not.toBeInTheDocument();
    expect(screen.queryByText(/waiting for review/)).not.toBeInTheDocument();
  });
});
