import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmButton } from './ConfirmButton';

describe('<ConfirmButton />', () => {
  it('moves focus into the prompt when armed and back to the trigger on Cancel', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmButton confirmLabel="Reopen this period?" onConfirm={onConfirm}>Reopen period</ConfirmButton>);

    await user.click(screen.getByRole('button', { name: 'Reopen period' }));
    expect(screen.getByRole('group', { name: 'Reopen this period?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Reopen period' })).toHaveFocus();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('lands on Cancel for a destructive prompt, so a repeated Enter cannot confirm it', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmButton tone="danger" confirmLabel="Delete this rule?" onConfirm={onConfirm}>
        Delete
      </ConfirmButton>,
    );

    screen.getByRole('button', { name: 'Delete' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus();
  });

  it('returns focus to the trigger after the action finishes while it is still on screen', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => undefined);
    render(<ConfirmButton confirmLabel="Run it?" onConfirm={onConfirm}>Run</ConfirmButton>);

    await user.click(screen.getByRole('button', { name: 'Run' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Run' })).toHaveFocus();
  });
});
