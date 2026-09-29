import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../test/utils';
import { ClaimTypeHelp } from './ClaimTypeHelp';

const TIP = 'settl.tip.claim-types';

describe('<ClaimTypeHelp />', () => {
  it('stays closed behind its toggle and explains every claim type with an example when opened', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ClaimTypeHelp />);

    const toggle = screen.getByRole('button', { name: 'What do the claim types mean?' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'What the claim types mean' })).not.toBeInTheDocument();

    await user.click(toggle);
    const panel = screen.getByRole('region', { name: 'What the claim types mean' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(panel).getByText("The card holder's own spending. Nothing to settle, unless someone else pays that card's bill.")).toBeInTheDocument();
    expect(within(panel).getByText("Only Alex's, whoever paid. If Sam paid, Alex pays Sam back in full.")).toBeInTheDocument();
    expect(panel).toHaveTextContent(`£20 of Alex's on Sam's card is "Alex's personal item": Alex pays Sam back £20.`);

    await user.click(within(panel).getByRole('button', { name: 'Close the explanation' }));
    expect(screen.queryByRole('region', { name: 'What the claim types mean' })).not.toBeInTheDocument();
  });

  it('opens by itself the first time as a tip, and "Got it" puts it away for good', async () => {
    const user = userEvent.setup();
    localStorage.removeItem(TIP);
    const { unmount } = renderWithProviders(<ClaimTypeHelp tipKey="claim-types" />);

    const panel = screen.getByRole('region', { name: 'What the claim types mean' });
    expect(panel).toHaveTextContent('Before you start: the claim type decides who pays for a line.');
    await user.click(within(panel).getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('region', { name: 'What the claim types mean' })).not.toBeInTheDocument();
    expect(localStorage.getItem(TIP)).toBe('seen');

    unmount();
    renderWithProviders(<ClaimTypeHelp tipKey="claim-types" />);
    expect(screen.queryByRole('region', { name: 'What the claim types mean' })).not.toBeInTheDocument();
  });
});
