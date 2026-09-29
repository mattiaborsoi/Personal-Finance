import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { selectViewFigures } from '../lib/views';
import { metrics } from '../test/fixtures';
import { fixtureConfig, mockFetch, renderWithProviders } from '../test/utils';
import { CategoryBreakdown } from './CategoryBreakdown';

describe('<CategoryBreakdown />', () => {
  it('lists the household categories, partner claims included, largest first', () => {
    mockFetch(() => undefined);
    renderWithProviders(<CategoryBreakdown breakdown={selectViewFigures(metrics(), 'macro').breakdown} />);

    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['Groceries£650.00', 'Partner claims£300.00', 'Dining£250.00']);
    expect(screen.queryByTestId('refunds-note')).not.toBeInTheDocument();
  });

  it('puts the group’s emoji before a category and reads a grouped name as "Group › Name"', () => {
    mockFetch(() => undefined);
    const withGroups = metrics({
      macro: {
        ...metrics().macro,
        by_category: [
          { category: 'Groceries', amount: '650.00' },
          { category: 'Bills:Water', amount: '40.00' },
          { category: 'Uncategorized', amount: '10.00' },
        ],
      },
    });
    renderWithProviders(<CategoryBreakdown breakdown={selectViewFigures(withGroups, 'macro').breakdown} />, {
      config: { ...fixtureConfig, category_emojis: { Groceries: '🛒', Bills: '💡' } },
    });

    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['🛒Groceries£650.00', '💡Bills › Water£40.00', 'Uncategorised£10.00']);
  });

  it('notes refunds under the household breakdown without deducting them from the headline', () => {
    mockFetch(() => undefined);
    const withRefunds = metrics({ macro: { ...metrics().macro, refunds: '83.00' } });
    renderWithProviders(<CategoryBreakdown breakdown={selectViewFigures(withRefunds, 'macro').breakdown} />);

    expect(screen.getByTestId('refunds-note')).toHaveTextContent('Refunds received £83.00, not deducted from the headline');
    // The headline figure the view reports is untouched by the refunds.
    expect(selectViewFigures(withRefunds, 'macro').headline).toBe('1200.00');
  });

  it('says nothing about refunds on the personal view, which has none to report', () => {
    mockFetch(() => undefined);
    const withRefunds = metrics({ macro: { ...metrics().macro, refunds: '83.00' } });
    renderWithProviders(<CategoryBreakdown breakdown={selectViewFigures(withRefunds, 'micro').breakdown} />);

    expect(screen.queryByTestId('refunds-note')).not.toBeInTheDocument();
  });
});
