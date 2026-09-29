import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SettlementOut } from '../api';
import { settlement, settlementBalance } from '../test/fixtures';
import { jsonResponse, mockFetch, primarySession, renderWithProviders, secondarySession } from '../test/utils';
import { SettlementNetLine } from './SettlementNetLine';

function serve(body: SettlementOut) {
  mockFetch(({ method, url }) => {
    if (method === 'GET' && url === '/api/settlement/2026-03') return jsonResponse(body);
    return undefined;
  });
}

describe('<SettlementNetLine />', () => {
  it('leads with the outstanding balance from the partner’s side, then the month so far', async () => {
    serve(settlement({ balance: settlementBalance({ carried_in: '266.50', balance_out: '312.40' }) }));
    renderWithProviders(<SettlementNetLine period="2026-03" />, { session: secondarySession });

    expect(await screen.findByTestId('settlement-net-line')).toHaveTextContent('You owe Alex £312.40');
    expect(screen.getByTestId('settlement-month-so-far')).toHaveTextContent('March 2026 so far: +£45.90 on what you owe');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says the primary owes "you" when the balance runs the other way', async () => {
    serve(settlement({ balance: settlementBalance({ net: '-12.00', balance_out: '-12.00' }) }));
    renderWithProviders(<SettlementNetLine period="2026-03" />, { session: secondarySession });

    expect(await screen.findByTestId('settlement-net-line')).toHaveTextContent('Alex owes you £12.00');
    expect(screen.getByTestId('settlement-month-so-far')).toHaveTextContent('March 2026 so far: -£12.00');
  });

  it('speaks to the primary user from their side', async () => {
    serve(settlement());
    renderWithProviders(<SettlementNetLine period="2026-03" />, { session: primarySession });
    expect(await screen.findByTestId('settlement-net-line')).toHaveTextContent('Sam owes you £45.90');
    expect(screen.getByTestId('settlement-month-so-far')).toHaveTextContent('on what Sam owes');
  });

  it('says settled up once payments clear the balance, with a caution while lines are under review', async () => {
    serve(
      settlement({
        pending_review_count: 2,
        balance: settlementBalance({ payments_ledger: '45.90', balance_out: '0.00' }),
      }),
    );
    renderWithProviders(<SettlementNetLine period="2026-03" />, { session: secondarySession });

    expect(await screen.findByTestId('settlement-net-line')).toHaveTextContent('Settled up');
    expect(screen.getByText(/still under review/)).toBeInTheDocument();
  });

  it('says nothing is approved yet instead of "Settled up" when only pending lines exist', async () => {
    serve(
      settlement({
        net_owed_by_secondary: '0.00',
        pending_review_count: 4,
        unsettled_claim_count: 0,
        lines: [],
        balance: settlementBalance({ net: '0.00', balance_out: '0.00' }),
      }),
    );
    renderWithProviders(<SettlementNetLine period="2026-03" />, { session: secondarySession });

    expect(await screen.findByTestId('settlement-net-line')).toHaveTextContent('Nothing approved yet');
    expect(screen.getByText('4 lines are waiting for review, so there is no figure yet.')).toBeInTheDocument();
    expect(screen.queryByText('Settled up')).not.toBeInTheDocument();
  });
});
