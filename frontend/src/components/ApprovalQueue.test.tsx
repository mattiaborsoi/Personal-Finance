import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PERIOD_CLOSED_MESSAGE } from '../api';
import { ID_OCADO, ID_PART_A, ID_PART_B, ID_UBER, part, transaction } from '../test/fixtures';
import { jsonResponse, mockFetch, renderWithProviders } from '../test/utils';
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
    // The category select carries its full name as a tooltip, since long names can be clipped.
    expect(screen.getByLabelText('Category for Uber')).toHaveAttribute('title', 'Transport:Taxi');
  });

  it('offers no empty "Uncategorised" or "Not set" option that the backend would ignore', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" />);
    await screen.findByRole('button', { name: 'Ocado' });

    const category = screen.getByLabelText('Category for Ocado') as HTMLSelectElement;
    const options = Array.from(category.options).map((o) => o.value);
    expect(options).not.toContain('');
    expect(options).toContain('Uncategorized');
    // The literal backend value is what is selected, labelled in British English.
    expect(category.value).toBe('Uncategorized');
    expect(category.selectedOptions[0].textContent).toBe('Uncategorised');

    const claim = screen.getByLabelText('Claim type for Ocado') as HTMLSelectElement;
    expect(Array.from(claim.options).map((o) => o.value)).not.toContain('');
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

    await user.selectOptions(screen.getByLabelText('Category for Ocado'), 'Groceries');
    await user.selectOptions(screen.getByLabelText('Claim type for Ocado'), 'shared_equal');
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

    await user.selectOptions(screen.getByLabelText('Category for Uber'), 'Dining');
    await user.selectOptions(screen.getByLabelText('Claim type for Uber'), 'shared_equal');
    await user.click(screen.getByRole('button', { name: 'Approve Uber' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(PERIOD_CLOSED_MESSAGE);
    expect(screen.getByRole('button', { name: 'Uber' })).toBeInTheDocument();
    // The restored row still shows what the user chose, not the original classification.
    expect((screen.getByLabelText('Category for Uber') as HTMLSelectElement).value).toBe('Dining');
    expect((screen.getByLabelText('Claim type for Uber') as HTMLSelectElement).value).toBe('shared_equal');
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
    await user.selectOptions(screen.getByLabelText('Category for Uber'), 'Dining');
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
    expect((screen.getByLabelText('Claim type for Uber') as HTMLSelectElement).value).toBe('personal');
    expect((screen.getByLabelText('Category for Uber') as HTMLSelectElement).value).toBe('Dining');
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
  });

  it('disables every approval control and explains why when the period is closed', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) return jsonResponse({ items: rows, total: 2 });
      return undefined;
    });

    renderWithProviders(<ApprovalQueue period="2026-03" closed />);
    await screen.findByRole('button', { name: 'Ocado' });

    expect(screen.getByRole('status')).toHaveTextContent(/this period is closed/i);
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
    await user.selectOptions(screen.getByLabelText('Category for Ocado'), 'Groceries');
    await user.selectOptions(screen.getByLabelText('Claim type for Ocado'), 'shared_equal');
    await user.click(within(rowFor('Ocado')).getByRole('button', { name: 'Split Ocado' }));

    const dialog = await screen.findByRole('dialog', { name: 'Split Ocado' });
    expect((within(dialog).getByLabelText('Category for part 1') as HTMLSelectElement).value).toBe('Groceries');
    expect((within(dialog).getByLabelText('Claim type for part 1') as HTMLSelectElement).value).toBe('shared_equal');

    await user.clear(within(dialog).getByLabelText('Amount for part 1'));
    await user.type(within(dialog).getByLabelText('Amount for part 1'), '30');
    await user.type(within(dialog).getByLabelText('Amount for part 2'), '15.90');
    await user.selectOptions(within(dialog).getByLabelText('Category for part 2'), 'Dining');
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
