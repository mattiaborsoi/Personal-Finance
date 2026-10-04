import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SubscriptionOut, SubscriptionsOut } from '../api';
import { jsonResponse, mockFetch, renderWithProviders } from '../test/utils';
import { SubscriptionsCard, TOP_SUBSCRIPTIONS } from './SubscriptionsCard';

function sub(overrides: Partial<SubscriptionOut> = {}): SubscriptionOut {
  return {
    merchant: 'Netflix',
    category: 'Subscriptions:Entertainment',
    kind: 'subscription',
    cadence: 'monthly',
    amount: '12.99',
    monthly_cost: '12.99',
    charges: 4,
    first_date: '2026-06-07',
    last_date: '2026-09-07',
    next_expected: '2026-10-07',
    status: 'active',
    change: { from: '10.99', to: '12.99', month: '2026-09' },
    ...overrides,
  };
}

function serve(body: SubscriptionsOut) {
  return mockFetch(({ method, url }) => (method === 'GET' && url === '/api/subscriptions' ? jsonResponse(body) : undefined));
}

describe('<SubscriptionsCard />', () => {
  it('lists each subscription with its monthly cost, next date, and a badge for a price change, new or stopped', async () => {
    serve({
      items: [
        sub(),
        sub({ merchant: 'Gym', amount: '40.00', monthly_cost: '40.00', status: 'new', change: null, category: 'Health:Gym' }),
        sub({ merchant: 'Cloud', cadence: 'yearly', amount: '99.00', monthly_cost: '8.25', change: null, next_expected: '2027-02-15' }),
        sub({ merchant: 'Old mag', status: 'stopped', change: null, last_date: '2026-03-01', monthly_cost: '5.00' }),
      ],
      total_monthly: '61.24',
      as_of: '2026-09-20',
    });

    renderWithProviders(<SubscriptionsCard />);

    const card = await screen.findByRole('region', { name: 'Regular payments' });
    expect(card).toHaveTextContent('3 regular payments, about £61.24 a month');
    const items = within(card).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('Netflix');
    expect(items[0]).toHaveTextContent('went from £10.99 to £12.99 in September 2026');
    expect(items[0]).toHaveTextContent('Monthly · next 7 Oct 2026');
    expect(items[0]).toHaveTextContent('£12.99a month');
    expect(items[1]).toHaveTextContent('New');
    expect(items[2]).toHaveTextContent('£99.00 a year · next 15 Feb 2027');
    expect(items[2]).toHaveTextContent('£8.25');
    expect(items[3]).toHaveTextContent('Stopped');
    expect(items[3]).toHaveTextContent('last seen 1 Mar 2026');
  });

  it('puts bills first, each group with its own monthly total', async () => {
    serve({
      items: [
        sub({ merchant: 'Netflix', change: null }),
        sub({ merchant: 'Lender', kind: 'bill', category: 'Housing:Mortgage', amount: '900.00', monthly_cost: '900.00', change: null }),
        sub({ merchant: 'Water Co', kind: 'bill', category: 'Bills:Water', amount: '50.00', monthly_cost: '50.00', change: null }),
      ],
      total_monthly: '962.99',
      as_of: '2026-09-20',
    });

    renderWithProviders(<SubscriptionsCard />);

    const bills = await screen.findByRole('list', { name: 'Bills' });
    expect(within(bills).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Lender'),
      expect.stringContaining('Water Co'),
    ]);
    expect(screen.getByRole('region', { name: 'Bills' })).toHaveTextContent('about £950.00 a month');
    const subscriptions = screen.getByRole('list', { name: 'Subscriptions' });
    expect(within(subscriptions).getByText('Netflix')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Subscriptions' })).toHaveTextContent('about £12.99 a month');
  });

  it('shows the top few with "Show all" for the rest', async () => {
    const user = userEvent.setup();
    serve({
      items: Array.from({ length: TOP_SUBSCRIPTIONS + 2 }, (_, i) => sub({ merchant: `Service ${i}`, change: null })),
      total_monthly: '100.00',
      as_of: '2026-09-20',
    });

    renderWithProviders(<SubscriptionsCard />);

    expect(await screen.findAllByRole('listitem')).toHaveLength(TOP_SUBSCRIPTIONS);
    await user.click(screen.getByRole('button', { name: `Show all ${TOP_SUBSCRIPTIONS + 2}` }));
    expect(screen.getAllByRole('listitem')).toHaveLength(TOP_SUBSCRIPTIONS + 2);
  });

  it('says so quietly when nothing regular has been found', async () => {
    serve({ items: [], total_monthly: '0.00', as_of: null });
    renderWithProviders(<SubscriptionsCard />);
    expect(await screen.findByText(/Nothing regular yet/)).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('surfaces an API failure with a retry', async () => {
    mockFetch(() => jsonResponse({ detail: 'boom' }, 500));
    renderWithProviders(<SubscriptionsCard />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
