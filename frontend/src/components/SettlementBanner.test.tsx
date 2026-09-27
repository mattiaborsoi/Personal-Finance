import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SettlementOut } from '../api';
import { awaitingFirstApproval, settlementHeadline, snapshotDiffers } from '../lib/settlement';
import { period, settlement } from '../test/fixtures';
import { jsonResponse, mockFetch, renderWithProviders } from '../test/utils';
import { SettlementBanner } from './SettlementBanner';

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

/** A period whose every line is still pending: zero sums, no lines, nothing to settle. */
function nothingApproved(overrides: Partial<SettlementOut> = {}): SettlementOut {
  return settlement({
    secondary_share_of_primary_paid_shared: '0.00',
    primary_share_of_secondary_paid_shared: '0.00',
    secondary_personal_on_primary_paid: '0.00',
    primary_personal_on_secondary_paid: '0.00',
    net_owed_by_secondary: '0.00',
    pending_review_count: 3,
    unsettled_claim_count: 0,
    lines: [],
    ...overrides,
  });
}

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

describe('awaitingFirstApproval', () => {
  it('is true only while lines are pending and nothing is approved or claimed', () => {
    const pending = nothingApproved();
    expect(awaitingFirstApproval(pending, period({ transaction_count: 3, pending_review_count: 3 }))).toBe(true);
    // One approved line that never reaches `lines` (borne by its payer) still counts as approved.
    expect(awaitingFirstApproval(pending, period({ transaction_count: 4, pending_review_count: 3 }))).toBe(false);
    // A claim, settled or not, means there is a figure.
    expect(awaitingFirstApproval(nothingApproved({ unsettled_claim_count: 1 }), period({ transaction_count: 3, pending_review_count: 3 }))).toBe(false);
    expect(awaitingFirstApproval(settlement({ pending_review_count: 3 }), period({ transaction_count: 3, pending_review_count: 3 }))).toBe(false);
    // Nothing pending: whatever the figure is, it stands.
    expect(awaitingFirstApproval(nothingApproved({ pending_review_count: 0 }), period({ transaction_count: 0, pending_review_count: 0 }))).toBe(false);
  });

  it('falls back to the settlement lines when the period counts are unknown', () => {
    expect(awaitingFirstApproval(nothingApproved(), null)).toBe(true);
    expect(awaitingFirstApproval(nothingApproved({ lines: settlement().lines }), null)).toBe(false);
    expect(awaitingFirstApproval(nothingApproved({ lines: [{ ...settlement().lines[0], source: 'transaction' }] }), null)).toBe(false);
  });
});

describe('<SettlementBanner />', () => {
  it('stacks the action under the figure on a phone and keeps each chip whole', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') return jsonResponse(settlement());
      return undefined;
    });

    renderWithProviders(<SettlementBanner period="2026-03" />);

    const headline = await screen.findByTestId('settlement-headline');
    // Smaller on a phone, so the headline does not wrap one word per line.
    expect(headline).toHaveClass('text-2xl', 'sm:text-4xl');
    expect(screen.getByTestId('settlement-top')).toHaveClass('flex-col', 'sm:flex-row');
    expect(screen.getByRole('button', { name: 'Mark claims settled' })).toHaveClass('w-full', 'sm:w-auto');
    expect(screen.getByText('Settle by 1 Apr 2026').closest('li')).toHaveClass('whitespace-nowrap');
    for (const half of screen.getByText(/Split 55\.6% Alex/).closest('li')!.querySelectorAll('span > span')) {
      expect(half).toHaveClass('whitespace-nowrap');
    }
  });

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
    // The split chip breaks, on a phone, between its two halves only.
    expect(screen.getByText(/Split 55\.6% Alex \//).closest('li')).toHaveTextContent('Split 55.6% Alex / 44.4% Sam');
    expect(screen.getByText(/3 transactions are still pending review/)).toBeInTheDocument();
    expect(screen.getByText('Sam’s share of shared items Alex paid')).toBeInTheDocument();
    expect(screen.getByText('Alex’s personal items on Sam’s cards')).toBeInTheDocument();
    expect(screen.getByText('£24.10')).toBeInTheDocument();
    expect(screen.queryByTestId('settlement-snapshot')).not.toBeInTheDocument();
  });

  it('opens the lines panel from the button and from ?lines=open in the URL', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') return jsonResponse(settlement());
      return undefined;
    });

    const view = renderWithProviders(<SettlementBanner period="2026-03" />, { route: '/?period=2026-03' });
    const toggle = await screen.findByRole('button', { name: /^Show / });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: /^Hide / })).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('settlement-lines')).toBeInTheDocument();

    view.unmount();
    renderWithProviders(<SettlementBanner period="2026-03" />, { route: '/?period=2026-03&lines=open' });
    expect(await screen.findByRole('button', { name: /^Hide / })).toHaveAttribute('aria-expanded', 'true');
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

  it('says nothing is approved yet, not "Settled up", while every line is still pending', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') return jsonResponse(nothingApproved());
      return undefined;
    });

    renderWithProviders(
      <SettlementBanner period="2026-03" periodInfo={period({ transaction_count: 3, pending_review_count: 3 })} />,
    );

    expect(await screen.findByTestId('settlement-headline')).toHaveTextContent('Nothing approved yet');
    expect(screen.queryByText('Settled up')).not.toBeInTheDocument();
    expect(screen.getByTestId('settlement-awaiting')).toHaveTextContent('3 lines are waiting for review');
    // The queue has its own page now, on the same period.
    expect(screen.getByRole('link', { name: 'Review the queue' })).toHaveAttribute('href', '/review?period=2026-03');
    // The zero sums and the empty line list would only dress up a figure that does not exist.
    expect(screen.queryByText('Sam’s share of shared items Alex paid')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show 0 lines/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/still pending review/)).not.toBeInTheDocument();
  });

  it('keeps "Settled up" once something is approved, even with lines still pending', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') return jsonResponse(nothingApproved());
      return undefined;
    });

    renderWithProviders(
      <SettlementBanner period="2026-03" periodInfo={period({ transaction_count: 4, pending_review_count: 3 })} />,
    );

    expect(await screen.findByTestId('settlement-headline')).toHaveTextContent('Settled up');
    expect(screen.queryByTestId('settlement-awaiting')).not.toBeInTheDocument();
    expect(screen.getByText(/3 transactions are still pending review/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show 0 lines/i })).toBeInTheDocument();
  });

  it('uses a single pending line in the singular', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') {
        return jsonResponse(nothingApproved({ pending_review_count: 1 }));
      }
      return undefined;
    });

    renderWithProviders(<SettlementBanner period="2026-03" />);
    expect(await screen.findByTestId('settlement-awaiting')).toHaveTextContent('1 line is waiting for review');
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
