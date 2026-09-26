import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { InvestmentMetrics } from '../api';
import { jsonResponse, mockFetch, renderWithProviders } from '../test/utils';
import { InvestmentCard } from './InvestmentCard';

const metrics: InvestmentMetrics = {
  accounts: [
    {
      account_id: 'acc_checking_hsbc',
      total_deposits: '1000.00',
      total_withdrawals: '250.00',
      net_invested_capital: '750.00',
      realized_gain: '50.00',
    },
    {
      account_id: 'acc_unknown_broker',
      total_deposits: '2500.50',
      total_withdrawals: '0.00',
      net_invested_capital: '2500.50',
      realized_gain: '-12.25',
    },
  ],
  total_deposits: '3500.50',
  total_withdrawals: '250.00',
  net_invested_capital: '3250.50',
  realized_gain: '37.75',
};

describe('<InvestmentCard />', () => {
  it('lists each account with deposits, withdrawals, net invested capital and realised gain, plus totals', async () => {
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/metrics/investment') return jsonResponse(metrics);
      return undefined;
    });

    renderWithProviders(<InvestmentCard />);

    const table = await screen.findByRole('table');
    expect(calls[0].url).toBe('/api/metrics/investment');
    expect(calls[0].headers.Authorization).toBe('Bearer primary-token');

    const hsbc = within(table).getByText('HSBC Premier ··4471').closest('tr') as HTMLElement;
    expect(within(hsbc).getByText('£1,000.00')).toBeInTheDocument();
    expect(within(hsbc).getByText('£250.00')).toBeInTheDocument();
    expect(within(hsbc).getByText('£750.00')).toBeInTheDocument();
    expect(within(hsbc).getByText('+£50.00')).toHaveClass('text-good-ink');

    // An account the config does not know is still shown, by id.
    const broker = within(table).getByText('acc_unknown_broker').closest('tr') as HTMLElement;
    expect(within(broker).getByText('-£12.25')).toHaveClass('text-critical-ink');

    const totals = within(table).getByRole('row', { name: /total/i });
    expect(within(totals).getByText('£3,500.50')).toBeInTheDocument();
    expect(within(totals).getByText('£3,250.50')).toBeInTheDocument();
    expect(within(totals).getByText('+£37.75')).toBeInTheDocument();
  });

  it('shows an empty state when there are no investment accounts', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/metrics/investment') {
        return jsonResponse({
          accounts: [],
          total_deposits: '0.00',
          total_withdrawals: '0.00',
          net_invested_capital: '0.00',
          realized_gain: '0.00',
        });
      }
      return undefined;
    });

    renderWithProviders(<InvestmentCard />);

    expect(await screen.findByText('No investment accounts yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('surfaces an API failure with a retry', async () => {
    mockFetch(() => jsonResponse({ detail: 'boom' }, 500));
    renderWithProviders(<InvestmentCard />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
