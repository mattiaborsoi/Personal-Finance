import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ID_OCADO, ID_PART_A, ID_PART_B, part, transaction } from '../test/fixtures';
import { categoryValue, claimTypeValue, jsonResponse, mockFetch, pickCategory, pickClaimType, renderWithProviders } from '../test/utils';
import { SplitDialog } from './SplitDialog';

const tx = transaction({
  id: ID_OCADO,
  cleaned_merchant: 'Ocado',
  amount: '-45.90',
  category: 'Groceries',
  claim_type: 'shared_proportional',
});

const splitParent = transaction({
  id: ID_OCADO,
  cleaned_merchant: 'Ocado',
  review_status: 'manual_approved',
  is_split: true,
  parts: [
    part({ id: ID_PART_A, split_index: 0, amount: '-30.00', category: 'Groceries', claim_type: 'shared_proportional' }),
    part({ id: ID_PART_B, split_index: 1, amount: '-15.90', category: 'Dining', claim_type: 'personal' }),
  ],
});

function amountFor(n: number): HTMLInputElement {
  return screen.getByLabelText(`Amount for part ${n}`) as HTMLInputElement;
}

function remainderLine(): HTMLElement {
  return within(screen.getByRole('dialog')).getByRole('status');
}

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Save split' });
}

describe('<SplitDialog />', () => {
  it('closes only the category menu on Escape, not the dialog around it', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mockFetch(() => undefined);
    renderWithProviders(<SplitDialog transaction={tx} onClose={onClose} onSaved={vi.fn()} />);

    const picker = screen.getByRole('button', { name: 'Category for part 2' });
    await user.click(picker);
    expect(screen.getByRole('combobox', { name: 'Search categories' })).toHaveFocus();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(picker).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens with the total in part 1, focus on its amount, and Save disabled while part 2 is empty', () => {
    mockFetch(() => undefined);
    renderWithProviders(<SplitDialog transaction={tx} onClose={vi.fn()} onSaved={vi.fn()} />);

    const dialog = screen.getByRole('dialog', { name: 'Split Ocado' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent('4 Mar 2026');
    expect(dialog).toHaveTextContent('-£45.90');
    expect(amountFor(1)).toHaveFocus();
    expect(amountFor(1)).toHaveValue('45.90');
    expect(amountFor(2)).toHaveValue('');
    expect(categoryValue(screen.getByLabelText('Category for part 1'))).toBe('Groceries');
    expect(claimTypeValue(screen.getByLabelText('Claim type for part 1'))).toBe('shared_proportional');
    expect(categoryValue(screen.getByLabelText('Category for part 2'))).toBe('Groceries');
    expect(claimTypeValue(screen.getByLabelText('Claim type for part 2'))).toBe('personal');
    expect(remainderLine()).toHaveTextContent('£0.00 left to allocate');
    expect(saveButton()).toBeDisabled();
    screen.getAllByRole('button', { name: /^Remove part/ }).forEach((b) => expect(b).toBeDisabled());
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('updates the remainder as amounts change and enables Save only when they add up exactly', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    renderWithProviders(<SplitDialog transaction={tx} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.clear(amountFor(1));
    await user.type(amountFor(1), '40');
    expect(remainderLine()).toHaveTextContent('£5.90 still to allocate');
    expect(saveButton()).toBeDisabled();

    await user.type(amountFor(2), '10');
    expect(remainderLine()).toHaveTextContent('£4.10 over the total');
    expect(saveButton()).toBeDisabled();

    await user.clear(amountFor(2));
    await user.type(amountFor(2), '5.90');
    expect(remainderLine()).toHaveTextContent('£0.00 left to allocate');
    expect(saveButton()).toBeEnabled();

    // A part that adds up but is not a number is still refused.
    await user.clear(amountFor(2));
    await user.type(amountFor(2), 'abc');
    expect(amountFor(2)).toHaveAttribute('aria-invalid', 'true');
    expect(saveButton()).toBeDisabled();
  });

  it('explains an unreadable amount next to the field', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    renderWithProviders(<SplitDialog transaction={tx} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.type(amountFor(2), 'abc');
    expect(amountFor(2)).toHaveAttribute('aria-invalid', 'true');
    expect(amountFor(2)).toHaveAccessibleDescription('Enter an amount above 0, like 12.50');
    expect(amountFor(1)).not.toHaveAttribute('aria-invalid');
    expect(saveButton()).toBeDisabled();
  });

  it('fills a row from the remainder', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    renderWithProviders(<SplitDialog transaction={tx} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.clear(amountFor(1));
    await user.type(amountFor(1), '40');
    await user.click(screen.getByRole('button', { name: 'Use remainder for part 2' }));

    expect(amountFor(2)).toHaveValue('5.90');
    expect(remainderLine()).toHaveTextContent('£0.00 left to allocate');
    expect(screen.queryByRole('button', { name: /Use remainder/ })).not.toBeInTheDocument();

    // Over-allocated: the remainder is negative, so only a row that stays positive offers it.
    await user.clear(amountFor(2));
    await user.type(amountFor(2), '10');
    expect(remainderLine()).toHaveTextContent('£4.10 over the total');
    await user.click(screen.getByRole('button', { name: 'Use remainder for part 1' }));
    expect(amountFor(1)).toHaveValue('35.90');
    expect(saveButton()).toBeEnabled();
  });

  it('sends signed two-decimal amounts with each part’s category and claim type', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'PUT' && url === `/api/transactions/${ID_OCADO}/split`) return jsonResponse(splitParent);
      return undefined;
    });
    renderWithProviders(<SplitDialog transaction={tx} onClose={vi.fn()} onSaved={onSaved} />);

    await user.clear(amountFor(1));
    await user.type(amountFor(1), '30');
    await user.type(amountFor(2), '15.9');
    await pickCategory(user, screen.getByLabelText('Category for part 2'), 'Dining');
    await pickClaimType(user, screen.getByLabelText('Claim type for part 2'), 'secondary_personal');
    await user.click(saveButton());

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe(`/api/transactions/${ID_OCADO}/split`);
    expect(put?.headers.Authorization).toBe('Bearer primary-token');
    expect(put?.body).toEqual({
      parts: [
        { amount: '-30.00', category: 'Groceries', claim_type: 'shared_proportional' },
        { amount: '-15.90', category: 'Dining', claim_type: 'secondary_personal' },
      ],
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: ID_OCADO, is_split: true })));
  });

  it('keeps the parent’s sign for money in', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method }) => {
      if (method === 'PUT') return jsonResponse(transaction({ amount: '100.00', is_split: true }));
      return undefined;
    });
    renderWithProviders(
      <SplitDialog transaction={transaction({ amount: '100.00' })} onClose={vi.fn()} onSaved={vi.fn()} />,
    );

    await user.clear(amountFor(1));
    await user.type(amountFor(1), '60');
    await user.type(amountFor(2), '40');
    await user.click(saveButton());

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const body = calls.find((c) => c.method === 'PUT')?.body as { parts: Array<{ amount: string }> };
    expect(body.parts.map((p) => p.amount)).toEqual(['60.00', '40.00']);
  });

  it('shows the server’s complaint and stays open when the split is refused', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    mockFetch(({ method }) => {
      if (method === 'PUT') {
        return jsonResponse(
          { detail: [{ loc: ['body', 'parts'], msg: 'amounts must sum to the parent amount', type: 'value_error' }] },
          422,
        );
      }
      return undefined;
    });
    renderWithProviders(<SplitDialog transaction={tx} onClose={vi.fn()} onSaved={onSaved} />);

    await user.clear(amountFor(1));
    await user.type(amountFor(1), '30');
    await user.type(amountFor(2), '15.90');
    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('parts: amounts must sum to the parent amount');
    expect(screen.getByRole('dialog', { name: 'Split Ocado' })).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(saveButton()).toBeEnabled();
  });

  it('explains a closed period in plain words on 409', async () => {
    const user = userEvent.setup();
    mockFetch(({ method }) => (method === 'PUT' ? jsonResponse({ detail: 'period 2026-03 is closed' }, 409) : undefined));
    renderWithProviders(<SplitDialog transaction={splitParent} onClose={vi.fn()} onSaved={vi.fn()} />);

    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('This period is closed. It needs reopening from the dashboard before it can change.');
  });

  it('closes on Escape, on Cancel and on the close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mockFetch(() => undefined);
    renderWithProviders(<SplitDialog transaction={tx} onClose={onClose} onSaved={vi.fn()} />);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('prefills the rows from an existing split', () => {
    mockFetch(() => undefined);
    renderWithProviders(<SplitDialog transaction={splitParent} onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(amountFor(1)).toHaveValue('30.00');
    expect(amountFor(2)).toHaveValue('15.90');
    expect(categoryValue(screen.getByLabelText('Category for part 2'))).toBe('Dining');
    expect(claimTypeValue(screen.getByLabelText('Claim type for part 2'))).toBe('personal');
    expect(remainderLine()).toHaveTextContent('£0.00 left to allocate');
    expect(saveButton()).toBeEnabled();
  });

  it('seeds part 1 from the given defaults', () => {
    mockFetch(() => undefined);
    renderWithProviders(
      <SplitDialog
        transaction={tx}
        defaults={{ category: 'Dining', claim_type: 'shared_equal' }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(categoryValue(screen.getByLabelText('Category for part 1'))).toBe('Dining');
    expect(claimTypeValue(screen.getByLabelText('Claim type for part 1'))).toBe('shared_equal');
    expect(categoryValue(screen.getByLabelText('Category for part 2'))).toBe('Dining');
  });

  it('adds and removes parts between two and twenty', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    renderWithProviders(<SplitDialog transaction={tx} onClose={vi.fn()} onSaved={vi.fn()} />);

    const add = screen.getByRole('button', { name: 'Add part' });
    await user.click(add);
    expect(screen.getAllByLabelText(/^Amount for part/)).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Remove part 3' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Remove part 3' }));
    expect(screen.getAllByLabelText(/^Amount for part/)).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Remove part 2' })).toBeDisabled();

    for (let n = 2; n < 20; n += 1) await user.click(add);
    expect(screen.getAllByLabelText(/^Amount for part/)).toHaveLength(20);
    expect(add).toBeDisabled();
  });
});
