import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fixtureConfig, renderWithProviders } from '../test/utils';
import { TransactionFilters, type TransactionFilterValues } from './TransactionFilters';

const values: TransactionFilterValues = { period: '', status: '', account_id: '', category: '', claim_type: '', q: '', include_transfers: false, unusual: false };

describe('<TransactionFilters />', () => {
  it('groups the category filter under "emoji Group" headings, bare names on their own and Uncategorised last', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<TransactionFilters periods={[]} values={values} onChange={onChange} />, {
      config: {
        ...fixtureConfig,
        categories: ['Groceries', 'Bills:Water', 'Dining', 'Bills:Energy', 'Transport:Taxi', 'Uncategorized'],
        category_emojis: { Bills: '💡', Groceries: '🛒' },
      },
    });

    const select = screen.getByRole('combobox', { name: 'Category' });
    const groups = within(select).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('label'))).toEqual(['💡 Bills', 'Transport']);
    expect(within(groups[0]).getAllByRole('option').map((o) => o.textContent)).toEqual(['Water', 'Energy']);
    expect(within(select).getAllByRole('option').map((o) => [o.getAttribute('value'), o.textContent])).toEqual([
      ['', 'All categories'],
      ['Groceries', '🛒 Groceries'],
      ['Bills:Water', 'Water'],
      ['Bills:Energy', 'Energy'],
      ['Dining', 'Dining'],
      ['Transport:Taxi', 'Taxi'],
      ['Uncategorized', 'Uncategorised'],
    ]);

    // The value sent is still the stored name.
    await user.selectOptions(select, 'Bills:Energy');
    expect(onChange).toHaveBeenCalledWith({ ...values, category: 'Bills:Energy' });
  });
});

describe('<TransactionFilters /> unusual only', () => {
  it('offers an "Unusual only" switch that reports the change', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<TransactionFilters periods={[]} values={values} onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'Unusual only' });
    expect(box).not.toBeChecked();
    await user.click(box);
    expect(onChange).toHaveBeenCalledWith({ ...values, unusual: true });
  });
});
