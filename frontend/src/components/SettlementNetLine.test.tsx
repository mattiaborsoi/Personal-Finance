import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { settlement } from '../test/fixtures';
import { jsonResponse, mockFetch, renderWithProviders } from '../test/utils';
import { SettlementNetLine } from './SettlementNetLine';

describe('<SettlementNetLine />', () => {
  it('shows who owes whom, with a caution while lines are still under review', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') return jsonResponse(settlement({ pending_review_count: 2 }));
      return undefined;
    });

    renderWithProviders(<SettlementNetLine period="2026-03" />);

    expect(await screen.findByTestId('settlement-net-line')).toHaveTextContent('Sam owes Alex £45.90');
    expect(screen.getByText(/still under review/)).toBeInTheDocument();
  });

  it('says nothing is approved yet instead of "Settled up" when only pending lines exist', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') {
        return jsonResponse(settlement({ net_owed_by_secondary: '0.00', pending_review_count: 4, unsettled_claim_count: 0, lines: [] }));
      }
      return undefined;
    });

    renderWithProviders(<SettlementNetLine period="2026-03" />);

    expect(await screen.findByTestId('settlement-net-line')).toHaveTextContent('Nothing approved yet');
    expect(screen.getByText('4 lines are waiting for review, so there is no figure yet.')).toBeInTheDocument();
    expect(screen.queryByText('Settled up')).not.toBeInTheDocument();
  });
});
