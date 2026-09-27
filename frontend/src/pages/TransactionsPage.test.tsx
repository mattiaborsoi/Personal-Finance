import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PeriodOut } from '../api';
import { TransactionRow } from '../components/TransactionRow';
import { ID_OCADO, ID_PART_A, ID_PART_B, ID_UBER, part, transaction } from '../test/fixtures';
import { jsonResponse, mockFetch, renderWithProviders, type RecordedCall } from '../test/utils';
import { TransactionsPage } from './TransactionsPage';

const rows = [
  transaction({ id: ID_OCADO, cleaned_merchant: 'Ocado', review_status: 'auto_approved' }),
  transaction({ id: ID_UBER, cleaned_merchant: 'Uber', raw_description: 'UBER *TRIP', amount: '-12.00' }),
];

const splitOcado = transaction({
  id: ID_OCADO,
  cleaned_merchant: 'Ocado',
  review_status: 'manual_approved',
  is_split: true,
  parts: [
    part({ id: ID_PART_A, split_index: 0, amount: '-30.00', category: 'Groceries', claim_type: 'shared_proportional' }),
    part({
      id: ID_PART_B,
      split_index: 1,
      amount: '-15.90',
      category: 'Dining',
      claim_type: 'personal',
      is_claimable: false,
      allocated_primary_amount: '-15.90',
      allocated_secondary_amount: '0.00',
    }),
  ],
});
const splitRows = [splitOcado, rows[1]];

const periods: PeriodOut[] = [
  {
    period_key: '2026-03',
    start_date: '2026-03-01',
    end_date: '2026-03-31',
    is_closed: true,
    closed_at: '2026-04-01T08:00:00Z',
    transaction_count: 2,
    pending_review_count: 0,
  },
];

describe('<TransactionsPage />', () => {
  it('drops a row that becomes an internal transfer while transfers are hidden', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse([]);
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      if (method === 'PATCH' && url === `/api/transactions/${ID_OCADO}`) {
        return jsonResponse(transaction({ id: ID_OCADO, is_internal_transfer: true, claim_type: 'personal' }));
      }
      return undefined;
    });

    renderWithProviders(<TransactionsPage />, { route: '/transactions?include_transfers=false' });
    await screen.findByRole('button', { name: 'Ocado' });
    expect(screen.getByText('2 transactions match')).toBeInTheDocument();
    // The icon-only ⇆ header still names its column, and each toggle names its merchant.
    expect(screen.getByRole('columnheader', { name: 'Transfer' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Mark Uber as a transfer' })).not.toBeChecked();

    await user.click(screen.getByLabelText('Mark Ocado as a transfer'));

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ is_internal_transfer: true });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Ocado' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Uber' })).toBeInTheDocument();
    expect(screen.getByText('1 transaction match')).toBeInTheDocument();
  });

  it('keeps the row in place when transfers are included', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse([]);
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      if (method === 'PATCH') return jsonResponse(transaction({ id: ID_OCADO, is_internal_transfer: true }));
      return undefined;
    });

    renderWithProviders(<TransactionsPage />, { route: '/transactions' });
    await screen.findByRole('button', { name: 'Ocado' });
    await user.click(screen.getByLabelText('Mark Ocado as a transfer'));

    await waitFor(() => expect(screen.getByLabelText('Mark Ocado as a transfer')).toBeChecked());
    expect(screen.getByRole('button', { name: 'Ocado' })).toBeInTheDocument();
    expect(screen.getByText('2 transactions match')).toBeInTheDocument();
  });

  it('shows the search text from the URL and sends only the literal "Uncategorized" as a category', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse([]);
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      return undefined;
    });

    renderWithProviders(<TransactionsPage />, { route: '/transactions?q=ocado' });
    await screen.findByRole('button', { name: 'Ocado' });

    expect(screen.getByLabelText('Search')).toHaveValue('ocado');
    const category = screen.getByLabelText('Category for Ocado') as HTMLSelectElement;
    expect(Array.from(category.options).map((o) => o.value)).not.toContain('');
    expect(category.value).toBe('Uncategorized');
  });

  it('makes rows in a closed period read-only and says so', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse(periods);
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      return undefined;
    });

    renderWithProviders(<TransactionsPage />, { route: '/transactions?period=2026-03' });
    await screen.findByRole('button', { name: 'Ocado' });

    expect(await screen.findByText(/March 2026 is closed/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Category for Ocado')).toBeDisabled());
    expect(screen.getByLabelText('Mark Ocado as a transfer')).toBeDisabled();
    screen.getAllByRole('button', { name: /^Delete (Ocado|Uber)$/ }).forEach((b) => expect(b).toBeDisabled());
    screen.getAllByRole('button', { name: /^Split / }).forEach((b) => expect(b).toBeDisabled());
    expect(screen.getAllByText('Period closed').length).toBe(2);
  });

  it('shows a split transaction as a badge with one editable row per part', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse([]);
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: splitRows, total: 2 });
      return undefined;
    });

    renderWithProviders(<TransactionsPage />, { route: '/transactions' });
    await screen.findByRole('button', { name: 'Ocado' });

    expect(screen.getByText('Split into 2 parts')).toBeInTheDocument();
    // The parent's own category and claim type are no longer editable; each part's are.
    expect(screen.queryByLabelText('Category for Ocado')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Claim type for Ocado')).not.toBeInTheDocument();
    expect((screen.getByLabelText('Category for Ocado part 1') as HTMLSelectElement).value).toBe('Groceries');
    expect((screen.getByLabelText('Claim type for Ocado part 1') as HTMLSelectElement).value).toBe('shared_proportional');
    expect((screen.getByLabelText('Category for Ocado part 2') as HTMLSelectElement).value).toBe('Dining');
    expect((screen.getByLabelText('Claim type for Ocado part 2') as HTMLSelectElement).value).toBe('personal');
    expect(screen.getByText('-£30.00')).toBeInTheDocument();
    expect(screen.getByText('-£15.90')).toBeInTheDocument();
    expect(screen.getByLabelText('Mark Ocado as a transfer')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit split for Ocado' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Unsplit Ocado' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Split Ocado' })).not.toBeInTheDocument();
    // The other, unsplit row keeps its inline controls and Split action.
    expect(screen.getByLabelText('Category for Uber')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Split Uber' })).toBeEnabled();
  });

  it('PATCHes a part by its own id and shows the returned classification', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse([]);
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: splitRows, total: 2 });
      if (method === 'PATCH' && url === `/api/transactions/${ID_PART_A}`) {
        return jsonResponse(
          transaction({
            id: ID_PART_A,
            split_parent_id: ID_OCADO,
            amount: '-30.00',
            category: 'Bills:Water',
            claim_type: 'shared_proportional',
            review_status: 'manual_approved',
          }),
        );
      }
      return undefined;
    });

    renderWithProviders(<TransactionsPage />, { route: '/transactions' });
    await screen.findByRole('button', { name: 'Ocado' });
    await user.selectOptions(screen.getByLabelText('Category for Ocado part 1'), 'Bills:Water');

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toBe(`/api/transactions/${ID_PART_A}`);
    expect(patch?.body).toEqual({ category: 'Bills:Water' });
    await waitFor(() =>
      expect((screen.getByLabelText('Category for Ocado part 1') as HTMLSelectElement).value).toBe('Bills:Water'),
    );
    // The parent is still one split row, and part 2 is untouched.
    expect(screen.getByText('Split into 2 parts')).toBeInTheDocument();
    expect((screen.getByLabelText('Category for Ocado part 2') as HTMLSelectElement).value).toBe('Dining');
  });

  it('shows a part’s error under that part when its PATCH is refused', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse([]);
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: splitRows, total: 2 });
      if (method === 'PATCH') return jsonResponse({ detail: 'period 2026-03 is closed' }, 409);
      return undefined;
    });

    renderWithProviders(<TransactionsPage />, { route: '/transactions' });
    await screen.findByRole('button', { name: 'Ocado' });
    await user.selectOptions(screen.getByLabelText('Claim type for Ocado part 2'), 'shared_equal');

    expect(await screen.findByRole('alert')).toHaveTextContent('This period is closed. It needs reopening from the dashboard before it can change.');
    // Nothing was applied locally.
    expect((screen.getByLabelText('Claim type for Ocado part 2') as HTMLSelectElement).value).toBe('personal');
  });

  it('unsplits after confirmation and brings the inline selects back', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse([]);
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: splitRows, total: 2 });
      if (method === 'DELETE' && url === `/api/transactions/${ID_OCADO}/split`) {
        return jsonResponse(
          transaction({ id: ID_OCADO, cleaned_merchant: 'Ocado', review_status: 'manual_approved', category: 'Groceries' }),
        );
      }
      return undefined;
    });

    renderWithProviders(<TransactionsPage />, { route: '/transactions' });
    await screen.findByRole('button', { name: 'Ocado' });
    await user.click(screen.getByRole('button', { name: 'Unsplit Ocado' }));
    await user.click(within(screen.getByRole('group', { name: 'Remove this split?' })).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')?.url).toBe(`/api/transactions/${ID_OCADO}/split`);
    expect(await screen.findByLabelText('Category for Ocado')).toBeEnabled();
    expect((screen.getByLabelText('Category for Ocado') as HTMLSelectElement).value).toBe('Groceries');
    expect(screen.queryByText('Split into 2 parts')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Category for Ocado part 1')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Mark Ocado as a transfer')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Split Ocado' })).toBeEnabled();
    expect(screen.getByText('2 transactions match')).toBeInTheDocument();
  });

  it('splits a transaction from its row and shows the saved parts in place', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse([]);
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      if (method === 'PUT' && url === `/api/transactions/${ID_OCADO}/split`) return jsonResponse(splitOcado);
      return undefined;
    });

    renderWithProviders(<TransactionsPage />, { route: '/transactions' });
    await screen.findByRole('button', { name: 'Ocado' });
    await user.click(screen.getByRole('button', { name: 'Split Ocado' }));

    const dialog = await screen.findByRole('dialog', { name: 'Split Ocado' });
    await user.clear(within(dialog).getByLabelText('Amount for part 1'));
    await user.type(within(dialog).getByLabelText('Amount for part 1'), '30');
    await user.type(within(dialog).getByLabelText('Amount for part 2'), '15.90');
    await user.selectOptions(within(dialog).getByLabelText('Category for part 1'), 'Groceries');
    await user.selectOptions(within(dialog).getByLabelText('Category for part 2'), 'Dining');
    await user.click(within(dialog).getByRole('button', { name: 'Save split' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      parts: [
        { amount: '-30.00', category: 'Groceries', claim_type: 'shared_proportional' },
        { amount: '-15.90', category: 'Dining', claim_type: 'personal' },
      ],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('Split into 2 parts')).toBeInTheDocument();
    expect((screen.getByLabelText('Category for Ocado part 2') as HTMLSelectElement).value).toBe('Dining');
    expect(screen.getByText('2 transactions match')).toBeInTheDocument();
  });

  it('disables Split for an internal transfer', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse([]);
      if (method === 'GET' && url.startsWith('/api/transactions?')) {
        return jsonResponse({ items: [transaction({ id: ID_UBER, cleaned_merchant: 'Uber', is_internal_transfer: true })], total: 1 });
      }
      return undefined;
    });

    renderWithProviders(<TransactionsPage />, { route: '/transactions' });
    await screen.findByRole('button', { name: 'Uber' });

    expect(screen.getByRole('button', { name: 'Split Uber' })).toBeDisabled();
  });

  it('shows the closed-period sentence inline when a PATCH is refused with 409', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse([]);
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      if (method === 'PATCH') return jsonResponse({ detail: 'period 2026-03 is closed' }, 409);
      return undefined;
    });

    renderWithProviders(<TransactionsPage />, { route: '/transactions' });
    await screen.findByRole('button', { name: 'Ocado' });
    await user.selectOptions(screen.getByLabelText('Category for Ocado'), 'Groceries');

    expect(await screen.findByRole('alert')).toHaveTextContent('This period is closed. It needs reopening from the dashboard before it can change.');
  });
});

function patches(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === 'PATCH');
}

describe('renaming a merchant inline', () => {
  it('saves the new name on Enter and keeps the statement description underneath', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse([]);
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      if (method === 'PATCH' && url === `/api/transactions/${ID_OCADO}`) {
        return jsonResponse(transaction({ id: ID_OCADO, cleaned_merchant: 'Ocado Retail', review_status: 'auto_approved' }));
      }
      return undefined;
    });

    renderWithProviders(<TransactionsPage />, { route: '/transactions' });
    await user.click(await screen.findByRole('button', { name: 'Rename Ocado' }));

    const input = screen.getByRole('textbox', { name: 'New name for Ocado' });
    expect(input).toHaveValue('Ocado');
    expect(input).toHaveFocus();
    // The name is swapped for the field; the raw line stays where it was.
    expect(screen.queryByRole('button', { name: 'Ocado' })).not.toBeInTheDocument();
    expect(screen.getByText('OCADO RETAIL LTD LONDON')).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, '  Ocado Retail {Enter}');

    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0].url).toBe(`/api/transactions/${ID_OCADO}`);
    expect(patches(calls)[0].body).toEqual({ cleaned_merchant: 'Ocado Retail' });
    expect(await screen.findByRole('button', { name: 'Ocado Retail' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /New name for/ })).not.toBeInTheDocument();
    expect(screen.getByText('OCADO RETAIL LTD LONDON')).toBeInTheDocument();
    // Focus comes back to the pencil, and the blur of the removed field saved nothing more.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename Ocado Retail' })).toHaveFocus());
    expect(patches(calls)).toHaveLength(1);
  });

  it('cancels on Escape without a request', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse([]);
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      return undefined;
    });

    renderWithProviders(<TransactionsPage />, { route: '/transactions' });
    await user.click(await screen.findByRole('button', { name: 'Rename Ocado' }));
    await user.type(screen.getByRole('textbox', { name: 'New name for Ocado' }), 'Waitrose{Escape}');

    expect(screen.queryByRole('textbox', { name: 'New name for Ocado' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ocado' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename Ocado' })).toHaveFocus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(patches(calls)).toEqual([]);
  });

  it('saves on blur, and sends nothing for a blank or unchanged name', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse([]);
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      if (method === 'PATCH' && url === `/api/transactions/${ID_UBER}`) {
        return jsonResponse(transaction({ id: ID_UBER, cleaned_merchant: 'Uber Eats', raw_description: 'UBER *TRIP', amount: '-12.00' }));
      }
      return undefined;
    });

    renderWithProviders(<TransactionsPage />, { route: '/transactions' });

    // Unchanged, then blank: both just close the field.
    await user.click(await screen.findByRole('button', { name: 'Rename Uber' }));
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Rename Uber' }));
    await user.clear(screen.getByRole('textbox', { name: 'New name for Uber' }));
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Uber' })).toBeInTheDocument();
    expect(patches(calls)).toEqual([]);

    // A changed name is saved when focus moves on.
    await user.click(screen.getByRole('button', { name: 'Rename Uber' }));
    await user.clear(screen.getByRole('textbox', { name: 'New name for Uber' }));
    await user.type(screen.getByRole('textbox', { name: 'New name for Uber' }), 'Uber Eats');
    await user.click(screen.getByLabelText('Search'));

    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0].body).toEqual({ cleaned_merchant: 'Uber Eats' });
    expect(await screen.findByRole('button', { name: 'Uber Eats' })).toBeInTheDocument();
  });

  it('shows the refusal under the row and keeps the old name', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse([]);
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      if (method === 'PATCH') return jsonResponse({ detail: 'period 2026-03 is closed' }, 409);
      return undefined;
    });

    renderWithProviders(<TransactionsPage />, { route: '/transactions' });
    await user.click(await screen.findByRole('button', { name: 'Rename Ocado' }));
    await user.type(screen.getByRole('textbox', { name: 'New name for Ocado' }), ' Retail{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent('This period is closed. It needs reopening from the dashboard before it can change.');
    expect(screen.getByRole('button', { name: 'Ocado' })).toBeInTheDocument();
  });

  it('offers the rename on a split parent only, never on its parts', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse([]);
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: splitRows, total: 2 });
      return undefined;
    });

    renderWithProviders(<TransactionsPage />, { route: '/transactions' });
    await screen.findByRole('button', { name: 'Ocado' });

    expect(screen.getByLabelText('Category for Ocado part 2')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Rename / }).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Rename Ocado',
      'Rename Uber',
    ]);
  });

  it('gives a row that is itself a split part no rename button', () => {
    mockFetch(() => undefined);
    renderWithProviders(
      <table>
        <tbody>
          <TransactionRow
            transaction={transaction({ id: ID_PART_A, split_parent_id: ID_OCADO, cleaned_merchant: 'Ocado' })}
            onPatch={vi.fn()}
            onDelete={vi.fn()}
            onSplit={vi.fn()}
            onUnsplit={vi.fn()}
            onPatchPart={vi.fn()}
          />
        </tbody>
      </table>,
    );

    expect(screen.getByRole('button', { name: 'Ocado' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename Ocado' })).not.toBeInTheDocument();
  });

  it('disables the rename in a closed period', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse(periods);
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      return undefined;
    });

    renderWithProviders(<TransactionsPage />, { route: '/transactions?period=2026-03' });
    await screen.findByText(/March 2026 is closed/);

    const rename = screen.getByRole('button', { name: 'Rename Ocado' });
    expect(rename).toBeDisabled();
    expect(rename).toHaveAttribute('title', 'This period is closed');
  });
});
