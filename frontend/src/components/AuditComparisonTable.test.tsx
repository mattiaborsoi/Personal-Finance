import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockFetch, renderWithProviders } from '../test/utils';
import { AuditAnomalies } from './AuditAnomalies';
import { AuditComparisonTable } from './AuditComparisonTable';

describe('<AuditComparisonTable />', () => {
  it('renders "new" for a category without a baseline and a signed percentage otherwise', () => {
    mockFetch(() => undefined);
    renderWithProviders(
      <AuditComparisonTable
        rows={[
          { category: 'Groceries', current: '-320.00', baseline_average: '-300.00', change_pct: 6.67 },
          { category: 'Travel', current: '-80.00', baseline_average: '0.00', change_pct: null },
          { category: 'Dining', current: '-40.00', baseline_average: '-50.00', change_pct: '-20' },
        ]}
      />,
    );

    const rowFor = (name: string) => within(screen.getByText(name).closest('tr') as HTMLElement);
    expect(rowFor('Groceries').getByText('+7%')).toHaveClass('text-critical-ink');
    expect(rowFor('Travel').getByText('new')).toBeInTheDocument();
    expect(rowFor('Travel').queryByText('0%')).not.toBeInTheDocument();
    expect(rowFor('Dining').getByText('-20%')).toHaveClass('text-good-ink');
  });
});

describe('<AuditAnomalies />', () => {
  it('shows the median with its standard deviation when present, and a dash for a missing deviation', () => {
    mockFetch(() => undefined);
    renderWithProviders(
      <AuditAnomalies
        anomalies={[
          {
            transaction_id: null,
            merchant: 'Aquanorth Water',
            issue: 'Price deviation',
            current_amount: '-95.00',
            baseline_amount: '-68.20',
            baseline_stddev: '0.00',
            deviation: 0.39,
          },
          {
            transaction_id: null,
            merchant: 'New Merchant',
            issue: 'No history',
            current_amount: '-10.00',
            baseline_amount: null,
            baseline_stddev: null,
            deviation: null,
          },
        ]}
      />,
    );

    const water = screen.getByText('Aquanorth Water').closest('li') as HTMLElement;
    expect(water).toHaveTextContent('Now -£95.00 vs median -£68.20 ± £0.00');
    expect(within(water).getByTitle('Deviation from baseline')).toHaveTextContent('+39%');

    const fresh = screen.getByText('New Merchant').closest('li') as HTMLElement;
    expect(fresh).not.toHaveTextContent('±');
    expect(within(fresh).getByTitle('Deviation from baseline')).toHaveTextContent('—');
  });
});
