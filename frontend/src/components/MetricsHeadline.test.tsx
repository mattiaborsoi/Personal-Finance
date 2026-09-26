import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MetricsOut } from '../api';
import { magnitude, selectViewFigures } from '../lib/views';
import { mockFetch, renderWithProviders } from '../test/utils';
import { MetricsHeadline } from './MetricsHeadline';

const metrics: MetricsOut = {
  period_key: '2026-03',
  macro: { household_burn: '1200.00', primary_accounts_burn: '900.00', partner_claims_burn: '300.00', by_category: [] },
  micro: { true_net_expense: '800.00', from_transactions: '650.00', from_partner_claims: '150.00', by_category: [] },
  liquidity: {
    credits: '517.27',
    debits: '617.27',
    net_cash_flow: '-100.00',
    by_account: [{ account_id: 'acc_checking_hsbc', credits: '517.27', debits: '617.27', net: '-100.00' }],
  },
};

function figureFor(label: string): HTMLElement {
  const dt = screen.getByText(label);
  const dd = dt.nextElementSibling;
  if (!dd) throw new Error(`No value for ${label}`);
  return dd as HTMLElement;
}

describe('<MetricsHeadline /> liquidity view', () => {
  it('signs and colours only the headline; credits and debits are plain magnitudes', () => {
    mockFetch(() => undefined);
    renderWithProviders(<MetricsHeadline figures={selectViewFigures(metrics, 'liquidity')} hint="Money in minus out" signed />);

    expect(screen.getByText('-£100.00')).toHaveClass('text-critical-ink');

    const debits = figureFor('Debits (out)');
    expect(debits).toHaveTextContent('£617.27');
    expect(debits).not.toHaveTextContent('+');
    expect(debits.querySelector('.text-good-ink')).toBeNull();
    expect(debits.querySelector('.text-critical-ink')).toBeNull();

    const credits = figureFor('Credits (in)');
    expect(credits).toHaveTextContent('£517.27');
    expect(credits).not.toHaveTextContent('+');
    expect(credits.querySelector('.text-good-ink')).toBeNull();
  });

  it('keeps sub-figures unsigned even when the API sends a signed debit total', () => {
    mockFetch(() => undefined);
    const signedDebits: MetricsOut = { ...metrics, liquidity: { ...metrics.liquidity, debits: '-617.27' } };
    renderWithProviders(<MetricsHeadline figures={selectViewFigures(signedDebits, 'liquidity')} hint="" signed />);

    expect(figureFor('Debits (out)')).toHaveTextContent('£617.27');
    expect(figureFor('Debits (out)')).not.toHaveTextContent('-');
  });

  it('never signs the macro view', () => {
    mockFetch(() => undefined);
    renderWithProviders(<MetricsHeadline figures={selectViewFigures(metrics, 'macro')} hint="" />);
    expect(screen.getByText('£1,200.00')).not.toHaveClass('text-good-ink');
    expect(figureFor('Partner claims')).toHaveTextContent('£300.00');
  });
});

describe('magnitude', () => {
  it('strips a leading sign only', () => {
    expect(magnitude('-617.27')).toBe('617.27');
    expect(magnitude('+12.00')).toBe('12.00');
    expect(magnitude('12.00')).toBe('12.00');
  });
});
