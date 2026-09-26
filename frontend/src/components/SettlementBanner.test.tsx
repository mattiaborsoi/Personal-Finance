import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SettlementOut } from '../api';
import { settlementHeadline, snapshotDiffers } from '../lib/settlement';
import { jsonResponse, mockFetch, renderWithProviders } from '../test/utils';
import { SettlementBanner } from './SettlementBanner';

function settlement(overrides: Partial<SettlementOut> = {}): SettlementOut {
  return {
    period_key: '2026-03',
    primary_user_id: 'user_primary',
    secondary_user_id: 'user_secondary',
    primary_ratio: '0.555556',
    secondary_ratio: '0.444444',
    secondary_share_of_primary_paid_shared: '120.00',
    primary_share_of_secondary_paid_shared: '60.00',
    secondary_personal_on_primary_paid: '10.00',
    primary_personal_on_secondary_paid: '24.10',
    net_owed_by_secondary: '45.90',
    settlement_payments_received: '0.00',
    pending_review_count: 0,
    unsettled_claim_count: 2,
    settlement_due_date: '2026-04-01',
    snapshot: null,
    lines: [
      {
        source: 'claim',
        id: '5d2c9a10-7e3b-4f8a-b1c4-9a0e6d2f7c11',
        date: '2026-03-04',
        merchant: 'Ocado',
        amount: '-60.00',
        claim_type: 'shared_proportional',
        paid_by: 'user_secondary',
        primary_share: '33.33',
        secondary_share: '26.67',
        effect_on_secondary_owes: '-33.33',
      },
    ],
    ...overrides,
  };
}

const snapshot = {
  period_key: '2026-03',
  net_owed_by_secondary: '45.90',
  secondary_share_of_primary_paid_shared: '120.00',
  primary_share_of_secondary_paid_shared: '60.00',
  secondary_personal_on_primary_paid: '10.00',
  primary_personal_on_secondary_paid: '24.10',
  settlement_payments_received: '0.00',
  line_count: 1,
  snapshot_at: '2026-04-01T08:00:00Z',
};

const names = { primary: 'Alex', secondary: 'Sam' };

describe('settlementHeadline', () => {
  it('phrases a positive net as the secondary user owing the primary user', () => {
    expect(settlementHeadline('45.90', names, '£')).toBe('Sam owes Alex £45.90');
  });

  it('phrases a negative net the other way round with the absolute amount', () => {
    expect(settlementHeadline('-12.00', names, '£')).toBe('Alex owes Sam £12.00');
  });

  it('says settled up at zero (including negative zero and sub-penny noise)', () => {
    expect(settlementHeadline('0.00', names, '£')).toBe('Settled up');
    expect(settlementHeadline('-0.00', names, '£')).toBe('Settled up');
    expect(settlementHeadline('0.001', names, '£')).toBe('Settled up');
  });
});

describe('snapshotDiffers', () => {
  it('is false without a snapshot or within rounding, true beyond a penny', () => {
    expect(snapshotDiffers({ net_owed_by_secondary: '45.90', snapshot: null })).toBe(false);
    expect(snapshotDiffers({ net_owed_by_secondary: '45.90', snapshot })).toBe(false);
    expect(snapshotDiffers({ net_owed_by_secondary: '45.904', snapshot })).toBe(false);
    expect(snapshotDiffers({ net_owed_by_secondary: '46.00', snapshot })).toBe(true);
  });
});

describe('<SettlementBanner />', () => {
  it('renders the headline, components, split ratio, due date and warning from the API', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') {
        return jsonResponse(settlement({ pending_review_count: 3 }));
      }
      return undefined;
    });

    renderWithProviders(<SettlementBanner period="2026-03" />);

    expect(await screen.findByTestId('settlement-headline')).toHaveTextContent('Sam owes Alex £45.90');
    expect(screen.getByText('Settle by 1 Apr 2026')).toBeInTheDocument();
    expect(screen.getByText(/55\.6% Alex \/ 44\.4% Sam/)).toBeInTheDocument();
    expect(screen.getByText(/3 transactions are still pending review/)).toBeInTheDocument();
    expect(screen.getByText("Sam's share of shared items Alex paid")).toBeInTheDocument();
    expect(screen.getByText("Alex's personal items on Sam's cards")).toBeInTheDocument();
    expect(screen.getByText('£24.10')).toBeInTheDocument();
    expect(screen.queryByTestId('settlement-snapshot')).not.toBeInTheDocument();
  });

  it('renders the reverse phrasing for a negative net and "Settled up" for zero', async () => {
    let net = '-12.00';
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') {
        return jsonResponse(settlement({ net_owed_by_secondary: net }));
      }
      return undefined;
    });

    const view = renderWithProviders(<SettlementBanner period="2026-03" />);
    expect(await screen.findByTestId('settlement-headline')).toHaveTextContent('Alex owes Sam £12.00');

    view.unmount();
    net = '0.00';
    renderWithProviders(<SettlementBanner period="2026-03" />);
    expect(await screen.findByTestId('settlement-headline')).toHaveTextContent('Settled up');
  });

  it('shows the figure recorded at close and warns only when the live figure has drifted', async () => {
    let net = '45.90';
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') {
        return jsonResponse(settlement({ net_owed_by_secondary: net, snapshot }));
      }
      return undefined;
    });

    const view = renderWithProviders(<SettlementBanner period="2026-03" />);
    const recorded = await screen.findByTestId('settlement-snapshot');
    expect(recorded).toHaveTextContent('Recorded at close: Sam owes Alex £45.90 (1 Apr 2026)');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();

    view.unmount();
    net = '52.00';
    renderWithProviders(<SettlementBanner period="2026-03" />);
    expect(await screen.findByRole('note')).toHaveTextContent(/live figure differs/i);
  });

  it('expands the lines and marks claims settled after confirmation, refetching once', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') return jsonResponse(settlement());
      if (method === 'POST' && url === '/api/settlement/2026-03/mark-settled') {
        return jsonResponse({ settled_claims: 2 });
      }
      return undefined;
    });

    renderWithProviders(<SettlementBanner period="2026-03" />);
    await screen.findByTestId('settlement-headline');

    await user.click(screen.getByRole('button', { name: /show 1 line/i }));
    expect(screen.getByText('Ocado')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mark claims settled' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/settlement/2026-03/mark-settled')).toBe(true),
    );
    expect(await screen.findByText('2 claims marked as settled.')).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.headers.Authorization).toBe('Bearer primary-token');

    const gets = () => calls.filter((c) => c.method === 'GET' && c.url === '/api/settlement/2026-03').length;
    await waitFor(() => expect(gets()).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(gets()).toBe(2);
  });

  it('leaves the refetch to the parent when onChanged is provided', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') return jsonResponse(settlement());
      if (method === 'POST' && url === '/api/settlement/2026-03/mark-settled') {
        return jsonResponse({ settled_claims: 2 });
      }
      return undefined;
    });

    renderWithProviders(<SettlementBanner period="2026-03" onChanged={onChanged} />);
    await screen.findByTestId('settlement-headline');
    await user.click(screen.getByRole('button', { name: 'Mark claims settled' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls.filter((c) => c.method === 'GET').length).toBe(1);
  });
});
