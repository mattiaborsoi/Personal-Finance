import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { selectViewFigures, type Breakdown } from '../lib/views';
import { metrics } from '../test/fixtures';
import { fixtureConfig, mockFetch, renderWithProviders } from '../test/utils';
import { CategoryBreakdown, TOP_GROUPS } from './CategoryBreakdown';

describe('<CategoryBreakdown />', () => {
  it('lists the household categories largest first, with partner claims as their own segment, not a category', () => {
    mockFetch(() => undefined);
    renderWithProviders(<CategoryBreakdown breakdown={selectViewFigures(metrics(), 'macro').breakdown} />);

    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['Groceries54%£650.00', 'Dining21%£250.00', 'Partner claims25%£300.00']);
    expect(screen.getByTestId('claims-segment')).toBeInTheDocument();
    expect(screen.queryByTestId('refunds-note')).not.toBeInTheDocument();
  });

  it('groups sub-categories under their group with a total, and expands to show them', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    const withGroups = metrics({
      macro: {
        ...metrics().macro,
        partner_claims_burn: '0.00',
        by_category: [
          { category: 'Groceries', amount: '650.00' },
          { category: 'Bills:Water', amount: '40.00' },
          { category: 'Bills:Energy', amount: '90.00' },
          { category: 'Uncategorized', amount: '10.00' },
        ],
      },
    });
    renderWithProviders(<CategoryBreakdown breakdown={selectViewFigures(withGroups, 'macro').breakdown} />, {
      config: { ...fixtureConfig, category_emojis: { Groceries: '🛒', Bills: '💡' } },
    });

    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['🛒Groceries82%£650.00', '💡Bills216%£130.00', 'Uncategorised1%£10.00']);
    const bills = screen.getByRole('button', { name: /Bills/ });
    expect(bills).toHaveAttribute('aria-expanded', 'false');
    await user.click(bills);
    const sub = within(bills.closest('li') as HTMLElement).getAllByRole('listitem').map((li) => li.textContent);
    expect(sub).toEqual(['Energy£90.00', 'Water£40.00']);
  });

  it('shows the top groups with "Show all" for the rest', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    const rows = Array.from({ length: TOP_GROUPS + 3 }, (_, i) => ({ category: `Cat${i}`, amount: `${100 - i}.00` }));
    const breakdown: Breakdown = { kind: 'category', rows };
    renderWithProviders(<CategoryBreakdown breakdown={breakdown} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(TOP_GROUPS);
    await user.click(screen.getByRole('button', { name: `Show all ${TOP_GROUPS + 3}` }));
    expect(screen.getAllByRole('listitem')).toHaveLength(TOP_GROUPS + 3);
    await user.click(screen.getByRole('button', { name: `Show top ${TOP_GROUPS}` }));
    expect(screen.getAllByRole('listitem')).toHaveLength(TOP_GROUPS);
  });

  it('keeps the smallest bar a visible mark, never a hairline', () => {
    mockFetch(() => undefined);
    const breakdown: Breakdown = {
      kind: 'category',
      rows: [
        { category: 'Groceries', amount: '1000.00' },
        { category: 'Coffee', amount: '3.00' },
      ],
    };
    renderWithProviders(<CategoryBreakdown breakdown={breakdown} />);
    const bars = screen.getAllByRole('listitem').map((li) => (li.querySelector('[style]') as HTMLElement).style.width);
    expect(bars).toEqual(['100%', '5%']);
  });

  it('notes refunds under the household breakdown', () => {
    mockFetch(() => undefined);
    const withRefunds = metrics({ macro: { ...metrics().macro, refunds: '83.00' } });
    renderWithProviders(<CategoryBreakdown breakdown={selectViewFigures(withRefunds, 'macro').breakdown} />);

    expect(screen.getByTestId('refunds-note')).toHaveTextContent('Refunds received this month: £83.00');
  });

  it('says nothing about refunds on the My share view, which has none to report', () => {
    mockFetch(() => undefined);
    const withRefunds = metrics({ macro: { ...metrics().macro, refunds: '83.00' } });
    renderWithProviders(<CategoryBreakdown breakdown={selectViewFigures(withRefunds, 'micro').breakdown} />);

    expect(screen.queryByTestId('refunds-note')).not.toBeInTheDocument();
  });

  it('lists only the accounts that moved, with in and out under the name and the net beside it', () => {
    mockFetch(() => undefined);
    const breakdown: Breakdown = {
      kind: 'account',
      rows: [
        { account_id: 'acc_checking_hsbc', credits: '517.27', debits: '617.27', net: '-100.00' },
        { account_id: 'acc_checking_barclays', credits: '0.00', debits: '0.00', net: '0.00' },
      ],
    };
    renderWithProviders(<CategoryBreakdown breakdown={breakdown} />);

    const list = screen.getByRole('list', { name: 'By account' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('HSBC Premier ··4471');
    expect(items[0]).toHaveTextContent('In £517.27 · Out £617.27');
    expect(within(items[0]).getByText('-£100.00')).toHaveClass('text-critical-ink');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
