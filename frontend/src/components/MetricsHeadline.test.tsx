import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { MetricsOut } from '../api';
import { magnitude, selectViewFigures, type RefundsMode } from '../lib/views';
import { metrics as metricsFixture } from '../test/fixtures';
import { mockFetch, renderWithProviders } from '../test/utils';
import { MetricsHeadline } from './MetricsHeadline';

const metrics: MetricsOut = metricsFixture();

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

  it('never signs the household view', () => {
    mockFetch(() => undefined);
    renderWithProviders(<MetricsHeadline figures={selectViewFigures(metrics, 'macro')} hint="" />);
    // No refunds in the fixture: net and gross agree, and the hero figure is the one in proportional numerals.
    expect(screen.getByText('£1,200.00', { selector: '.\\!normal-nums' })).not.toHaveClass('text-good-ink');
    expect(figureFor('Partner claims')).toHaveTextContent('£300.00');
    expect(figureFor('Gross spend')).toHaveTextContent('£1,200.00');
  });
});

describe('<MetricsHeadline /> household extras', () => {
  it('says how the headline moved against last month', () => {
    mockFetch(() => undefined);
    renderWithProviders(
      <MetricsHeadline
        figures={selectViewFigures(metrics, 'macro')}
        hint=""
        change={{ delta: 120, fraction: 0.12, previousLabel: 'February 2026' }}
      />,
    );
    expect(screen.getByTestId('headline-change')).toHaveTextContent('up £120.00 (12%) on February 2026');
  });

  it('switches between net and gross, and lists what each person paid and bears', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    const withRefunds = { ...metrics, macro: { ...metrics.macro, refunds: '83.00' } };
    function Harness() {
      const [mode, setMode] = useState<RefundsMode>('net');
      return (
        <MetricsHeadline
          figures={selectViewFigures(withRefunds, 'macro', mode)}
          hint=""
          refunds={{ mode, onChange: setMode }}
          people={[
            { user_id: 'user_primary', paid: '900.00', bears: '640.00' },
            { user_id: 'user_secondary', paid: '300.00', bears: '560.00' },
          ]}
        />
      );
    }
    renderWithProviders(<Harness />);

    expect(screen.getByText('£1,117.00')).toBeInTheDocument();
    expect(figureFor('Gross spend')).toHaveTextContent('£1,200.00');
    await user.click(screen.getByRole('button', { name: 'Gross' }));
    expect(screen.getByText('£1,200.00', { selector: '.\\!normal-nums' })).toBeInTheDocument();
    expect(figureFor('Net of refunds')).toHaveTextContent('£1,117.00');

    const people = screen.getByTestId('per-person');
    expect(people).toHaveTextContent('Alexpaid £900.00, bears £640.00');
    expect(people).toHaveTextContent('Sampaid £300.00, bears £560.00');
  });
});

describe('magnitude', () => {
  it('strips a leading sign only', () => {
    expect(magnitude('-617.27')).toBe('617.27');
    expect(magnitude('+12.00')).toBe('12.00');
    expect(magnitude('12.00')).toBe('12.00');
  });
});
