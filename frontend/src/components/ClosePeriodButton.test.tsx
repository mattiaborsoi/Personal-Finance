import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { period } from '../test/fixtures';
import { jsonResponse, mockFetch, renderWithProviders } from '../test/utils';
import { ClosePeriodButton } from './ClosePeriodButton';

describe('<ClosePeriodButton />', () => {
  it('announces a blocked close, focuses Cancel rather than Force close, and returns focus on Cancel', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'POST' && url.includes('/periods/2026-03/close')) {
        return jsonResponse({ detail: '3 transactions are still pending review.' }, 409);
      }
      return undefined;
    });
    const onChanged = vi.fn();
    renderWithProviders(<ClosePeriodButton period={period()} periodKey="2026-03" onChanged={onChanged} />);

    await user.click(screen.getByRole('button', { name: 'Close period' }));
    // The question says what closing does, for the month on show.
    expect(
      screen.getByText("Close March 2026? Its lines lock and the month's summary and settlement are recorded. You can reopen it later."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('3 transactions are still pending review.');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Force close' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close period' })).toHaveFocus());
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(onChanged).not.toHaveBeenCalled();
  });
});
