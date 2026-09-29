import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PERIOD_CLOSED_MESSAGE } from '../api';
import { ID_OCADO, ID_PART_A, ID_PART_B, ID_UBER, part, transaction } from '../test/fixtures';
import { categoryValue, claimTypeValue, fixtureConfig, jsonResponse, mockFetch, pickCategory, pickClaimType, type RecordedCall, renderWithProviders } from '../test/utils';
import { ApprovalQueue } from './ApprovalQueue';

const uber = {
  id: ID_UBER,
  cleaned_merchant: 'Uber',
  raw_description: 'UBER *TRIP',
  amount: '-12.00',
  category: 'Transport:Taxi',
};

const rows = [transaction({ id: ID_OCADO, cleaned_merchant: 'Ocado' }), transaction(uber)];

function rowFor(merchant: string): HTMLElement {
  const cell = screen.getByRole('button', { name: merchant });
  const row = cell.closest('tr');
  if (!row) throw new Error(`No row for ${merchant}`);
  return row;
}

describe('<ApprovalQueue />', () => {
  it('lists pending transactions with the source badge and confidence', async () => {
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" />);

    expect(await screen.findByRole('button', { name: 'Ocado' })).toBeInTheDocument();
    expect(calls[0].url).toBe('/api/transactions?period=2026-03&status=pending_review&limit=200&offset=0');
    expect(calls[0].headers.Authorization).toBe('Bearer primary-token');
    expect(within(rowFor('Ocado')).getByText('LLM')).toBeInTheDocument();
    expect(within(rowFor('Ocado')).getByText('62%')).toBeInTheDocument();
    expect(screen.getByText('2 transactions pending review')).toBeInTheDocument();
    // Every column is named, so the transfer box has a heading.
    expect(screen.getByRole('columnheader', { name: 'Transfer' })).toHaveAttribute('title', 'Internal transfer: money moving between your own accounts');
  });

  it('scrolls a wide queue inside a positioned wrapper so it cannot widen the page on a phone', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" />);
    await screen.findByRole('button', { name: 'Ocado' });

    // The rows' screen-reader-only labels are absolutely positioned, so the scroller must be their
    // containing block (relative) for its overflow clip to apply to them; the card never grows either.
    expect(screen.getByRole('table').parentElement).toHaveClass('relative', 'overflow-x-auto');
    expect(screen.getByRole('region', { name: 'Approval queue' })).toHaveClass('min-w-0');
    // The row controls are named with aria-label, so no visually hidden label can escape the clip.
    expect(screen.getByRole('button', { name: 'Category for Ocado' })).toHaveAttribute('aria-label', 'Category for Ocado');
  });

  it('names every row control after its merchant for screen readers, keeping the visible label short', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" />);
    await screen.findByRole('button', { name: 'Ocado' });

    const approve = screen.getByRole('button', { name: 'Approve Ocado' });
    expect(approve).toHaveTextContent('Approve');
    expect(screen.getByRole('button', { name: 'Approve Uber' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Ocado' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Mark Ocado as a transfer' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Split Ocado' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Transfer' })).toBeInTheDocument();
    // The category button carries its full name as a tooltip, since long names can be clipped.
    expect(screen.getByLabelText('Category for Uber')).toHaveAttribute('title', 'Transport › Taxi');
    expect(screen.getByRole('radiogroup', { name: 'Claim type for Uber' })).toBeInTheDocument();
  });

  it('offers no empty "Uncategorised" or "Not set" option that the backend would ignore', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" />);
    await screen.findByRole('button', { name: 'Ocado' });

    const user = userEvent.setup();
    const category = screen.getByRole('button', { name: 'Category for Ocado' });
    // The literal backend value is what is selected, labelled in British English.
    expect(categoryValue(category)).toBe('Uncategorized');
    expect(category).toHaveTextContent('Uncategorised');
    await user.click(category);
    const values = within(screen.getByRole('listbox', { name: 'Categories' }))
      .getAllByRole('option')
      .map((o) => o.dataset.value);
    expect(values).not.toContain('');
    expect(values).toContain('Uncategorized');
    await user.keyboard('{Escape}');

    const claim = screen.getByRole('radiogroup', { name: 'Claim type for Ocado' });
    const claims = within(claim)
      .getAllByRole('radio')
      .map((r) => r.dataset.value);
    expect(claims).not.toContain('');
    expect(claims).toHaveLength(5);
  });

  it('sends corrected fields with remember:true when a dropdown was changed', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      if (method === 'POST' && url === `/api/transactions/${ID_OCADO}/approve`) {
        return jsonResponse(transaction({ id: ID_OCADO, review_status: 'manual_approved', category: 'Groceries' }));
      }
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" />);
    await screen.findByRole('button', { name: 'Ocado' });

    await pickCategory(user, screen.getByLabelText('Category for Ocado'), 'Groceries');
    await pickClaimType(user, screen.getByLabelText('Claim type for Ocado'), 'shared_equal');
    await user.click(screen.getByRole('button', { name: 'Approve Ocado' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const approve = calls.find((c) => c.method === 'POST');
    expect(approve?.url).toBe(`/api/transactions/${ID_OCADO}/approve`);
    expect(approve?.body).toEqual({ category: 'Groceries', claim_type: 'shared_equal', remember: true });

    // Optimistically removed from the queue; the other row remains.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Ocado' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Uber' })).toBeInTheDocument();
  });

  it('sends only remember:true for a plain approve', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      if (method === 'POST' && url === `/api/transactions/${ID_UBER}/approve`) {
        return jsonResponse(transaction({ id: ID_UBER, review_status: 'manual_approved' }));
      }
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" />);
    await screen.findByRole('button', { name: 'Uber' });
    await user.click(screen.getByRole('button', { name: 'Approve Uber' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ remember: true });
    // The focused Approve button left with its row: focus moves to the queue heading and the result is announced.
    expect(screen.getByRole('heading', { name: 'Approval queue' })).toHaveFocus();
    expect(await screen.findByText('Approved Uber')).toHaveAttribute('role', 'status');
  });

  it('restores the row with the user’s edits and a closed-period message when approval returns 409', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      if (method === 'POST') return jsonResponse({ detail: 'period 2026-03 is closed' }, 409);
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" />);
    await screen.findByRole('button', { name: 'Uber' });

    await pickCategory(user, screen.getByLabelText('Category for Uber'), 'Dining');
    await pickClaimType(user, screen.getByLabelText('Claim type for Uber'), 'shared_equal');
    await user.click(screen.getByRole('button', { name: 'Approve Uber' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(PERIOD_CLOSED_MESSAGE);
    expect(screen.getByRole('button', { name: 'Uber' })).toBeInTheDocument();
    // The restored row still shows what the user chose, not the original classification.
    expect(categoryValue(screen.getByLabelText('Category for Uber'))).toBe('Dining');
    expect(claimTypeValue(screen.getByLabelText('Claim type for Uber'))).toBe('shared_equal');
  });

  it('ticks the transfer box as soon as a line is filed under Transfers › Internal', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      if (method === 'PATCH' && url === `/api/transactions/${ID_UBER}`) {
        return jsonResponse(transaction({ ...uber, is_internal_transfer: true, claim_type: 'personal' }));
      }
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" />, {
      config: { ...fixtureConfig, categories: [...fixtureConfig.categories, 'Transfers:Internal'] },
    });
    await screen.findByRole('button', { name: 'Uber' });
    await pickCategory(user, screen.getByLabelText('Category for Uber'), 'Transfers:Internal');

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ is_internal_transfer: true });
    expect(await screen.findByLabelText('Mark Uber as a transfer')).toBeChecked();
    // The category choice itself still waits for Approve.
    expect(categoryValue(screen.getByLabelText('Category for Uber'))).toBe('Transfers:Internal');
  });

  it('marks a line as a transfer with the same PATCH as the transactions page and keeps it in the queue', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      if (method === 'PATCH' && url === `/api/transactions/${ID_UBER}`) {
        // The server turns a transfer's claim type into "personal" (nobody is owed for it).
        return jsonResponse(transaction({ ...uber, is_internal_transfer: true, claim_type: 'personal' }));
      }
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" onChanged={onChanged} />);
    await screen.findByRole('button', { name: 'Uber' });
    // An unsaved category choice must survive the toggle.
    await pickCategory(user, screen.getByLabelText('Category for Uber'), 'Dining');
    await user.click(screen.getByLabelText('Mark Uber as a transfer'));

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toBe(`/api/transactions/${ID_UBER}`);
    expect(patch?.body).toEqual({ is_internal_transfer: true });
    // Marking a transfer is not an approval, so nothing is posted and the row stays.
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await waitFor(() => expect(screen.getByLabelText('Mark Uber as a transfer')).toBeChecked());
    expect(screen.getByRole('button', { name: 'Uber' })).toBeInTheDocument();
    expect(screen.getByText('2 transactions pending review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Split Uber' })).toBeDisabled();
    expect(claimTypeValue(screen.getByLabelText('Claim type for Uber'))).toBe('personal');
    expect(categoryValue(screen.getByLabelText('Category for Uber'))).toBe('Dining');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('leaves the transfer toggle unchecked and explains when the PATCH is refused', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      if (method === 'PATCH') return jsonResponse({ detail: 'period 2026-03 is closed' }, 409);
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" />);
    await screen.findByRole('button', { name: 'Ocado' });
    await user.click(screen.getByLabelText('Mark Ocado as a transfer'));

    expect(await screen.findByRole('alert')).toHaveTextContent(PERIOD_CLOSED_MESSAGE);
    expect(screen.getByLabelText('Mark Ocado as a transfer')).not.toBeChecked();
    expect(screen.getByLabelText('Mark Ocado as a transfer')).toBeEnabled();
  });

  it('approves everything selected via the batch endpoint', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      if (method === 'POST' && url === '/api/transactions/approve-batch') {
        return jsonResponse({ approved: 2, items: [] });
      }
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" />);
    await screen.findByRole('button', { name: 'Ocado' });

    await user.click(screen.getByLabelText('Select all pending transactions'));
    await user.click(screen.getByRole('button', { name: 'Approve selected (2)' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/transactions/approve-batch')).toBe(true));
    expect(calls.find((c) => c.url === '/api/transactions/approve-batch')?.body).toEqual({
      ids: [ID_OCADO, ID_UBER],
      remember: true,
    });
    expect(await screen.findByText('Nothing to review. All caught up.')).toBeInTheDocument();
    expect(await screen.findByText('2 transactions approved')).toHaveAttribute('role', 'status');
  });

  it('disables every approval control and explains why when the period is closed', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" closed />);
    await screen.findByRole('button', { name: 'Ocado' });

    // The queue's own (empty) announcement region is a status too; the notice is the one with text.
    expect(screen.getAllByRole('status').some((el) => /this period is closed/i.test(el.textContent ?? ''))).toBe(true);
    screen.getAllByRole('button', { name: /^Approve (Ocado|Uber)$/ }).forEach((b) => expect(b).toBeDisabled());
    screen.getAllByRole('button', { name: /^Split / }).forEach((b) => expect(b).toBeDisabled());
    screen.getAllByRole('checkbox', { name: /as a transfer$/ }).forEach((c) => expect(c).toBeDisabled());
    expect(screen.getByRole('button', { name: /approve selected/i })).toBeDisabled();
    expect(screen.getByLabelText('Category for Ocado')).toBeDisabled();
    expect(screen.getByLabelText('Select all pending transactions')).toBeDisabled();
  });

  it('splits a pending transaction from the queue, seeded from the row’s draft, and removes it once saved', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const saved = transaction({
      id: ID_OCADO,
      cleaned_merchant: 'Ocado',
      review_status: 'manual_approved',
      is_split: true,
      parts: [
        part({ id: ID_PART_A, split_index: 0, amount: '-30.00', category: 'Groceries', claim_type: 'shared_equal' }),
        part({ id: ID_PART_B, split_index: 1, amount: '-15.90', category: 'Dining', claim_type: 'personal' }),
      ],
    });
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      if (method === 'PUT' && url === `/api/transactions/${ID_OCADO}/split`) return jsonResponse(saved);
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" onChanged={onChanged} />);
    await screen.findByRole('button', { name: 'Ocado' });

    // The row's unsaved dropdown choices become the first part's defaults.
    await pickCategory(user, screen.getByLabelText('Category for Ocado'), 'Groceries');
    await pickClaimType(user, screen.getByLabelText('Claim type for Ocado'), 'shared_equal');
    await user.click(within(rowFor('Ocado')).getByRole('button', { name: 'Split Ocado' }));

    const dialog = await screen.findByRole('dialog', { name: 'Split Ocado' });
    expect(categoryValue(within(dialog).getByLabelText('Category for part 1'))).toBe('Groceries');
    expect(claimTypeValue(within(dialog).getByLabelText('Claim type for part 1'))).toBe('shared_equal');

    await user.clear(within(dialog).getByLabelText('Amount for part 1'));
    await user.type(within(dialog).getByLabelText('Amount for part 1'), '30');
    await user.type(within(dialog).getByLabelText('Amount for part 2'), '15.90');
    await pickCategory(user, within(dialog).getByLabelText('Category for part 2'), 'Dining');
    await user.click(within(dialog).getByRole('button', { name: 'Save split' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe(`/api/transactions/${ID_OCADO}/split`);
    expect(put?.body).toEqual({
      parts: [
        { amount: '-30.00', category: 'Groceries', claim_type: 'shared_equal' },
        { amount: '-15.90', category: 'Dining', claim_type: 'personal' },
      ],
    });
    // No separate approve call: splitting approves.
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    // The row is gone (it is approved now), the dialog closed, and the dashboard told to refresh.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Ocado' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Uber' })).toBeInTheDocument();
    expect(screen.getByText('1 transaction pending review')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Split saved and approved')).toHaveAttribute('role', 'status');
    expect(screen.getByRole('heading', { name: 'Approval queue' })).toHaveFocus();
  });

  it('keeps the row and the dialog open when the split is refused', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      if (method === 'PUT') return jsonResponse({ detail: 'period 2026-03 is closed' }, 409);
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" />);
    await screen.findByRole('button', { name: 'Uber' });
    await user.click(within(rowFor('Uber')).getByRole('button', { name: 'Split Uber' }));

    const dialog = await screen.findByRole('dialog', { name: 'Split Uber' });
    await user.clear(within(dialog).getByLabelText('Amount for part 1'));
    await user.type(within(dialog).getByLabelText('Amount for part 1'), '8');
    await user.type(within(dialog).getByLabelText('Amount for part 2'), '4');
    await user.click(within(dialog).getByRole('button', { name: 'Save split' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(PERIOD_CLOSED_MESSAGE);
    expect(screen.getByRole('button', { name: 'Uber' })).toBeInTheDocument();
    expect(screen.getByText('2 transactions pending review')).toBeInTheDocument();
  });
});

describe('<ApprovalQueue /> account filter', () => {
  const onHsbc = transaction({ ...uber, account_id: 'acc_checking_hsbc' });
  const mixed = [transaction({ id: ID_OCADO, cleaned_merchant: 'Ocado' }), onHsbc];

  function mockQueue() {
    return mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: mixed, total: 2 });
      if (method === 'POST' && url === '/api/transactions/approve-batch') return jsonResponse({ approved: 1, remembered: 0 });
      return undefined;
    });
  }

  it('offers each account with its count and shows only the chosen one', async () => {
    mockQueue();
    const onAccountChange = vi.fn();
    renderWithProviders(<ApprovalQueue period="2026-03" account="acc_checking_hsbc" onAccountChange={onAccountChange} />);

    expect(await screen.findByRole('button', { name: 'Uber' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ocado' })).not.toBeInTheDocument();
    expect(screen.getByText('1 transaction pending review on HSBC Premier ··4471, of 2 this month')).toBeInTheDocument();
    const filter = screen.getByLabelText('Show lines from');
    expect(within(filter).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All accounts (2)',
      'Amex Platinum ··7715 (1)',
      'HSBC Premier ··4471 (1)',
    ]);
    await userEvent.setup().selectOptions(filter, '');
    expect(onAccountChange).toHaveBeenCalledWith('');
  });

  it('selects and approves only the lines on show', async () => {
    const user = userEvent.setup();
    const { calls } = mockQueue();
    renderWithProviders(<ApprovalQueue period="2026-03" account="acc_checking_hsbc" onAccountChange={vi.fn()} />);
    await screen.findByRole('button', { name: 'Uber' });

    await user.click(screen.getByRole('checkbox', { name: 'Select all pending transactions' }));
    await user.click(screen.getByRole('button', { name: 'Approve selected (1)' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/transactions/approve-batch')).toBe(true));
    const batch = calls.find((c) => c.url === '/api/transactions/approve-batch');
    expect(batch?.body).toEqual({ ids: [ID_UBER], remember: true });
  });

  it('says when the chosen account has nothing left and offers every account again', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) =>
      method === 'GET' && url.startsWith('/api/transactions?')
        ? jsonResponse({ items: [transaction({ id: ID_OCADO, cleaned_merchant: 'Ocado' })], total: 1 })
        : undefined,
    );
    const onAccountChange = vi.fn();
    renderWithProviders(<ApprovalQueue period="2026-03" account="acc_checking_hsbc" onAccountChange={onAccountChange} />);

    expect(await screen.findByText('Nothing waiting on HSBC Premier ··4471.')).toBeInTheDocument();
    expect(screen.getByText('1 line from other accounts still waits this month.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show all accounts' }));
    expect(onAccountChange).toHaveBeenCalledWith('');
  });

  it('hides the filter when every line is on one account', async () => {
    mockFetch(({ method, url }) =>
      method === 'GET' && url.startsWith('/api/transactions?') ? jsonResponse({ items: rows, total: 2 }) : undefined,
    );
    renderWithProviders(<ApprovalQueue period="2026-03" onAccountChange={vi.fn()} />);
    await screen.findByRole('button', { name: 'Ocado' });
    expect(screen.queryByLabelText('Show lines from')).not.toBeInTheDocument();
  });
});

describe('renaming and noting a line on Review', () => {
  function patchCalls(calls: RecordedCall[]) {
    return calls.filter((c) => c.method === 'PATCH');
  }

  it('renames the merchant in place, saves on Enter and keeps the line in the queue', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      if (method === 'PATCH' && url === `/api/transactions/${ID_OCADO}`) {
        return jsonResponse(transaction({ id: ID_OCADO, cleaned_merchant: 'Ocado Retail' }));
      }
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" />);
    await user.click(await screen.findByRole('button', { name: 'Rename Ocado' }));
    const input = screen.getByRole('textbox', { name: 'New name for Ocado' });
    expect(input).toHaveValue('Ocado');
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, 'Ocado Retail{Enter}');

    await waitFor(() => expect(patchCalls(calls)).toHaveLength(1));
    expect(patchCalls(calls)[0]).toMatchObject({ url: `/api/transactions/${ID_OCADO}`, body: { cleaned_merchant: 'Ocado Retail' } });
    expect(await screen.findByRole('button', { name: 'Ocado Retail' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename Ocado Retail' })).toHaveFocus());
    // Renaming is not approving: nothing was posted and the line is still waiting.
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(screen.getByText('2 transactions pending review')).toBeInTheDocument();
    // Clicking the name still shows the full raw line.
    const name = screen.getByRole('button', { name: 'Ocado Retail' });
    expect(name).toHaveAttribute('aria-expanded', 'false');
    await user.click(name);
    expect(name).toHaveAttribute('aria-expanded', 'true');
  });

  it('cancels a rename on Escape without a request', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" />);
    await user.click(await screen.findByRole('button', { name: 'Rename Uber' }));
    await user.type(screen.getByRole('textbox', { name: 'New name for Uber' }), ' Eats{Escape}');

    expect(screen.getByRole('button', { name: 'Uber' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename Uber' })).toHaveFocus();
    expect(patchCalls(calls)).toEqual([]);
  });

  it('adds a note with PATCH straight away, shows it under the description and keeps the line pending', async () => {
    const user = userEvent.setup();
    const note = 'Birthday present for Sam';
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      if (method === 'PATCH' && url === `/api/transactions/${ID_OCADO}`) {
        return jsonResponse(transaction({ id: ID_OCADO, cleaned_merchant: 'Ocado', note }));
      }
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" />);
    await screen.findByRole('button', { name: 'Ocado' });
    // A category draft is not sent with the note, and survives it.
    await pickCategory(user, screen.getByLabelText('Category for Ocado'), 'Groceries');
    await user.click(screen.getByRole('button', { name: 'Add a note to Ocado' }));
    const input = screen.getByRole('textbox', { name: 'Note on Ocado' });
    expect(input).toHaveFocus();
    await user.type(input, `  ${note}  {Enter}`);

    await waitFor(() => expect(patchCalls(calls)).toHaveLength(1));
    expect(patchCalls(calls)[0].body).toEqual({ note });
    const shown = await screen.findByTitle(note);
    expect(shown).toHaveTextContent(note);
    expect(shown).toHaveClass('w-0', 'min-w-full');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit the note on Ocado' })).toHaveFocus());
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(categoryValue(screen.getByLabelText('Category for Ocado'))).toBe('Groceries');
    expect(screen.getByText('2 transactions pending review')).toBeInTheDocument();
  });

  it('edits and clears a note, saving on blur', async () => {
    const user = userEvent.setup();
    const noted = [transaction({ id: ID_OCADO, cleaned_merchant: 'Ocado', note: 'Old note' }), transaction(uber)];
    let saved: string | null = 'Old note';
    const { calls } = mockFetch(({ method, url, body }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: noted, total: 2 });
      if (method === 'PATCH' && url === `/api/transactions/${ID_OCADO}`) {
        saved = (body as { note: string }).note || null;
        return jsonResponse(transaction({ id: ID_OCADO, cleaned_merchant: 'Ocado', note: saved }));
      }
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" />);
    expect(await screen.findByTitle('Old note')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit the note on Ocado' }));
    const input = screen.getByRole('textbox', { name: 'Note on Ocado' });
    expect(input).toHaveValue('Old note');
    await user.clear(input);
    await user.type(input, 'New note');
    await user.click(screen.getByRole('heading', { name: 'Approval queue' }));

    await waitFor(() => expect(patchCalls(calls)).toHaveLength(1));
    expect(patchCalls(calls)[0].body).toEqual({ note: 'New note' });
    expect(await screen.findByTitle('New note')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit the note on Ocado' }));
    await user.clear(screen.getByRole('textbox', { name: 'Note on Ocado' }));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(patchCalls(calls)).toHaveLength(2));
    expect(patchCalls(calls)[1].body).toEqual({ note: '' });
    expect(await screen.findByRole('button', { name: 'Add a note to Ocado' })).toBeInTheDocument();
    expect(screen.queryByTitle('New note')).not.toBeInTheDocument();
  });

  it('shows a refused note under the row', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      if (method === 'PATCH') return jsonResponse({ detail: 'note must be at most 500 characters (got 501)' }, 422);
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" />);
    await user.click(await screen.findByRole('button', { name: 'Add a note to Uber' }));
    await user.type(screen.getByRole('textbox', { name: 'Note on Uber' }), 'Too long{Enter}');

    expect(await within(rowFor('Uber').nextElementSibling as HTMLElement).findByRole('alert')).toHaveTextContent(
      'note must be at most 500 characters (got 501)',
    );
    expect(screen.getByRole('button', { name: 'Add a note to Uber' })).toBeInTheDocument();
  });

  it('disables the rename and the note in a closed period', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" closed />);
    await screen.findByRole('button', { name: 'Ocado' });
    expect(screen.getByRole('button', { name: 'Rename Ocado' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add a note to Ocado' })).toBeDisabled();
  });
});
