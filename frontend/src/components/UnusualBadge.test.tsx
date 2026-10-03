import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { transaction } from '../test/fixtures';
import { renderWithProviders } from '../test/utils';
import { TransactionRow } from './TransactionRow';
import { UnusualBadge, unusualLabel, unusualTitle } from './UnusualBadge';

const names = { primary: 'Alex', secondary: 'Sam' };
const odd = { usual_category: 'Dining', usual_claim_type: 'personal' as const, times: 1, total: 14 };

describe('<UnusualBadge />', () => {
  it('says how the merchant is usually filed, with the counts in the tooltip', () => {
    expect(unusualLabel(odd, names)).toBe('Usually Dining · Personal');
    expect(unusualTitle(odd, names)).toBe('Filed this way 1 of 14 times on this card; usually Dining, Personal (not shared).');
    expect(unusualLabel({ ...odd, usual_category: 'Bills:Water', usual_claim_type: 'shared_proportional' }, names)).toBe(
      'Usually Bills › Water · Split by income',
    );
    renderWithProviders(<UnusualBadge unusual={odd} />);
    expect(screen.getByTitle(unusualTitle(odd, names))).toHaveTextContent('Usually Dining · Personal');
  });

  it('renders nothing for a line filed as usual', () => {
    const { container } = renderWithProviders(<UnusualBadge unusual={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows on a transaction row that carries the flag', () => {
    renderWithProviders(
      <table>
        <tbody>
          <TransactionRow
            transaction={transaction({ category: 'Groceries', unusual: odd })}
            onPatch={async () => {}}
            onDelete={async () => {}}
            onSplit={() => {}}
            onUnsplit={async () => {}}
            onPatchPart={async () => {}}
          />
        </tbody>
      </table>,
    );
    expect(screen.getByText('Usually Dining · Personal')).toBeInTheDocument();
  });
});
