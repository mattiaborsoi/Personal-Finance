import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TransferBufferOut } from '../api';
import { mockFetch, renderWithProviders } from '../test/utils';
import { TransferTable } from './TransferTable';

const row: TransferBufferOut = {
  id: 'd1e2f3a4-5b6c-4d7e-8f9a-0b1c2d3e4f5a',
  transaction_id: null,
  account_id: 'acc_checking_hsbc',
  amount: '-250.00',
  transaction_date: '2026-03-04',
  match_status: 'unmatched',
  resolved_at: null,
  description: 'TO SAVINGS 1234',
};

describe('<TransferTable />', () => {
  it('asks before ignoring a transfer, and Cancel leaves it alone', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    const onIgnore = vi.fn(async () => undefined);
    renderWithProviders(
      <TransferTable rows={[row]} selected={[]} busy={new Set()} errors={{}} onToggle={vi.fn()} onIgnore={onIgnore} />,
    );

    await user.click(screen.getByRole('button', { name: 'Ignore TO SAVINGS 1234' }));
    expect(onIgnore).not.toHaveBeenCalled();
    const prompt = screen.getByRole('group', { name: 'Ignore this transfer? It won’t come back to this list.' });

    await user.click(within(prompt).getByRole('button', { name: 'Cancel' }));
    expect(onIgnore).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Ignore TO SAVINGS 1234' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Ignore TO SAVINGS 1234' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onIgnore).toHaveBeenCalledWith(row);
  });
});
