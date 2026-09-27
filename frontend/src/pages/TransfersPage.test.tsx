import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { TransferBufferOut } from '../api';
import { amountsCancelOut } from '../lib/transfers';
import { jsonResponse, mockFetch, renderWithProviders } from '../test/utils';
import { TransfersPage } from './TransfersPage';

const ID_A = 'aaaaaaaa-1a1a-4a1a-8a1a-a1a1a1a1a1a1';
const ID_B = 'bbbbbbbb-2b2b-4b2b-8b2b-b2b2b2b2b2b2';
const ID_C = 'cccccccc-3c3c-4c3c-8c3c-c3c3c3c3c3c3';

function row(overrides: Partial<TransferBufferOut>): TransferBufferOut {
  return {
    id: ID_A,
    transaction_id: '99999999-9d9d-4d9d-8d9d-d9d9d9d9d9d9',
    account_id: 'acc_checking_hsbc',
    amount: '-45.90',
    transaction_date: '2026-03-04',
    match_status: 'unmatched',
    resolved_at: null,
    description: 'Payment to Amex',
    ...overrides,
  };
}

const rows = [
  row({ id: ID_A, amount: '-45.90', description: 'Payment to Amex' }),
  row({ id: ID_B, amount: '45.90', account_id: 'acc_cc_amex', description: 'Payment received' }),
  row({ id: ID_C, amount: '-12.00', description: 'Something else' }),
];

describe('amountsCancelOut', () => {
  it('accepts a penny of rounding and nothing more', () => {
    expect(amountsCancelOut({ amount: '-45.90' }, { amount: '45.90' })).toBe(true);
    expect(amountsCancelOut({ amount: '-45.90' }, { amount: '45.91' })).toBe(true);
    expect(amountsCancelOut({ amount: '-45.90' }, { amount: '45.92' })).toBe(false);
    expect(amountsCancelOut({ amount: '-45.90' }, { amount: '-12.00' })).toBe(false);
  });
});

describe('<TransfersPage /> manual match', () => {
  it('matches straight away when the two amounts cancel out', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/transfers/unmatched') return jsonResponse(rows);
      if (method === 'POST' && url === '/api/transfers/match') return jsonResponse([rows[0], rows[1]]);
      return undefined;
    });

    renderWithProviders(<TransfersPage />);
    await user.click(await screen.findByLabelText('Select transfer Payment to Amex for manual match'));
    await user.click(screen.getByLabelText('Select transfer Payment received for manual match'));
    await user.click(screen.getByRole('button', { name: 'Match selected (2/2)' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ buffer_id_a: ID_A, buffer_id_b: ID_B });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await screen.findByText('The two entries were linked as one transfer.')).toBeInTheDocument();
  });

  it('asks for explicit confirmation when the amounts differ, and only then matches', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/transfers/unmatched') return jsonResponse(rows);
      if (method === 'POST' && url === '/api/transfers/match') return jsonResponse([rows[0], rows[2]]);
      return undefined;
    });

    renderWithProviders(<TransfersPage />);
    await user.click(await screen.findByLabelText('Select transfer Payment to Amex for manual match'));
    await user.click(screen.getByLabelText('Select transfer Something else for manual match'));
    await user.click(screen.getByRole('button', { name: 'Match selected (2/2)' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Amounts differ: -£45.90 and -£12.00 do not cancel out. Match anyway?');
    expect(dialog).toHaveAccessibleDescription(/do not cancel out/);
    // Focus moves into the confirmation so it is announced; Cancel is the safe default.
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    // Cancelling keeps the selection, sends nothing and returns focus to the trigger.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Match selected (2/2)' })).toHaveFocus();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Match selected (2/2)' }));
    await user.click(await screen.findByRole('button', { name: 'Match anyway' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ buffer_id_a: ID_A, buffer_id_b: ID_C });
  });
});
