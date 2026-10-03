import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { MemoryOut } from '../api';
import { jsonResponse, mockFetch, renderWithProviders } from '../test/utils';
import { MemoryPage } from './MemoryPage';

const PRET: MemoryOut = {
  id: 'm-1',
  raw_pattern: 'PRET A MANGER',
  normalized_merchant: 'Pret',
  category: 'Dining',
  default_claim_type: 'shared_equal',
  review_count: 12,
  last_updated: '2026-09-30T12:00:00Z',
  transaction_count: 48,
  total_spent: '312.40',
};

const PIZZA: MemoryOut = {
  ...PRET,
  id: 'm-2',
  raw_pattern: 'PIZZA & CO',
  normalized_merchant: 'Pizza & Co',
  review_count: 1,
  transaction_count: 1,
  total_spent: '-4.50',
};

function mockMemory(entries: MemoryOut[]) {
  return mockFetch(({ method, url }) => {
    if (method === 'GET' && url.startsWith('/api/memory?')) return jsonResponse(entries);
    if (method === 'DELETE' && url.startsWith('/api/memory/')) return new Response(null, { status: 204 });
    return undefined;
  });
}

describe('MemoryPage', () => {
  it('links the review count to the merchant\'s transactions and shows the net spend', async () => {
    mockMemory([PRET, PIZZA]);
    renderWithProviders(<MemoryPage />, { route: '/memory' });

    const link = await screen.findByRole('link', { name: "12 reviews: show Pret's transactions" });
    expect(link).toHaveAttribute('href', '/transactions?q=Pret');
    expect(link).toHaveTextContent('12');
    expect(screen.getByRole('link', { name: "1 review: show Pizza & Co's transactions" })).toHaveAttribute(
      'href',
      '/transactions?q=Pizza%20%26%20Co',
    );

    expect(screen.getByRole('columnheader', { name: 'Total spent' })).toBeInTheDocument();
    const pretRow = screen.getByText('PRET A MANGER').closest('tr') as HTMLElement;
    expect(within(pretRow).getByText('£312.40')).toBeInTheDocument();
    expect(within(pretRow).getByText('48 lines')).toBeInTheDocument();
    const pizzaRow = screen.getByText('PIZZA & CO').closest('tr') as HTMLElement;
    expect(within(pizzaRow).getByText('1 line')).toBeInTheDocument();
  });

  it('no longer shows a pinned split and explains that it is decided per card', async () => {
    mockMemory([PRET]);
    renderWithProviders(<MemoryPage />, { route: '/memory' });
    await screen.findByText('PRET A MANGER');

    expect(screen.queryByRole('columnheader', { name: /claim type/i })).not.toBeInTheDocument();
    expect(screen.queryByText('50/50')).not.toBeInTheDocument();
    expect(
      screen.getByText(/whether a line is shared is decided per card, from how you have filed that merchant on the same card/),
    ).toBeInTheDocument();
  });

  it('asks before forgetting a merchant and says its transactions stay', async () => {
    const { calls } = mockMemory([PRET]);
    renderWithProviders(<MemoryPage />, { route: '/memory' });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Delete Pret' }));
    const question = 'Forget Pret? Its transactions stay as they are; the next Pret line gets a fresh suggestion.';
    const prompt = screen.getByRole('group', { name: question });
    expect(within(prompt).getByText(question)).toBeVisible();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    await user.click(within(prompt).getByRole('button', { name: 'Confirm' }));
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/memory/m-1')).toBe(true);
    expect(await screen.findByText('Nothing learnt yet')).toBeInTheDocument();
  });
});
