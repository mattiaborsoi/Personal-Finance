import { describe, expect, it } from 'vitest';
import { metrics } from '../test/fixtures';
import { VIEWS, groupCategories, headlineChange, selectViewFigures, trendKeyFor, trendYDomain, yearChange } from './views';

describe('trendYDomain', () => {
  it('pins the axis to 0–100 when every value is zero or missing, so no £1–£4 ticks appear over nothing', () => {
    expect(trendYDomain([0, 0, 0, 0, 0, 0])).toEqual([0, 100]);
    expect(trendYDomain([Number.NaN, 0, -0])).toEqual([0, 100]);
    expect(trendYDomain([])).toEqual([0, 100]);
  });

  it('always starts at 0 for spend, so a small range never looks dramatic', () => {
    expect(trendYDomain([1010, 1020, 1015])).toEqual([0, 'auto']);
    expect(trendYDomain([0, 0, 12.5])).toEqual([0, 'auto']);
  });

  it('keeps 0 in view for a series that goes negative', () => {
    expect(trendYDomain([-100, -20])).toEqual(['auto', 0]);
    expect(trendYDomain([-100, 50])).toEqual(['auto', 'auto']);
  });
});

describe('views', () => {
  it('are named in plain words', () => {
    expect(VIEWS.map((v) => v.label)).toEqual(['Household', 'My share', 'Cash flow']);
  });
});

describe('headlineChange', () => {
  const trend = [
    { period_key: '2026-02', household_burn: '1000.00', household_net: '1000.00', true_net_expense: '600.00', net_cash_flow: '0.00' },
    { period_key: '2026-03', household_burn: '1120.00', household_net: '1120.00', true_net_expense: '600.00', net_cash_flow: '-50.00' },
  ];

  it('compares the month with the one before it in the loaded trend', () => {
    expect(headlineChange(trend, '2026-03', 'macro')).toEqual({ delta: 120, fraction: 0.12, previousLabel: 'February 2026' });
    expect(headlineChange(trend, '2026-03', 'micro')).toEqual({ delta: 0, fraction: 0, previousLabel: 'February 2026' });
  });

  it('has no percentage against a zero month, and nothing for the first month', () => {
    expect(headlineChange(trend, '2026-03', 'liquidity')).toEqual({ delta: -50, fraction: null, previousLabel: 'February 2026' });
    expect(headlineChange(trend, '2026-02', 'macro')).toBeNull();
    expect(headlineChange(trend, '2026-04', 'macro')).toBeNull();
  });
});

describe('groupCategories', () => {
  it('groups sub-categories under their top-level group with totals, largest first', () => {
    const groups = groupCategories([
      { category: 'Bills:Water', amount: '40.00' },
      { category: 'Groceries', amount: '650.00' },
      { category: 'Bills:Energy', amount: '90.00' },
      { category: 'Uncategorized', amount: '10.00' },
    ]);
    expect(groups.map((g) => [g.group, g.amount, g.rows.map((r) => r.category)])).toEqual([
      ['Groceries', 650, ['Groceries']],
      ['Bills', 130, ['Bills:Energy', 'Bills:Water']],
      ['Uncategorized', 10, ['Uncategorized']],
    ]);
  });
});

describe('selectViewFigures', () => {
  it('reads the household headline net of refunds by default, gross on request, with the other figure in a tile', () => {
    const withRefunds = metrics({ macro: { ...metrics().macro, refunds: '83.00', partner_claims_count: 2 } });
    const net = selectViewFigures(withRefunds, 'macro');
    expect(net.headline).toBe('1117.00');
    expect(net.headlineLabel).toBe('Household spend, net of refunds');
    expect(net.subFigures[0]).toEqual({ label: 'Gross spend', value: '1200.00', noteMoney: { label: 'Refunds', value: '83.00' } });
    expect(net.subFigures[2]).toEqual({ label: 'Partner claims', value: '300.00', note: '2 claims' });

    const gross = selectViewFigures(withRefunds, 'macro', 'gross');
    expect(gross.headline).toBe('1200.00');
    expect(gross.subFigures[0]).toEqual({ label: 'Net of refunds', value: '1117.00', noteMoney: { label: 'Refunds', value: '83.00' } });
  });

  it('keeps partner claims out of the category rows and carries them as their own segment', () => {
    const macro = selectViewFigures(metrics(), 'macro').breakdown;
    const micro = selectViewFigures(metrics(), 'micro').breakdown;
    expect(macro.kind === 'category' && macro.rows.map((r) => r.category)).toEqual(['Groceries', 'Dining']);
    expect(macro.kind === 'category' && macro.claims).toEqual({ amount: '300.00', count: null });
    expect(micro.kind === 'category' && micro.rows.map((r) => r.category)).toEqual(['Groceries']);
    expect(micro.kind === 'category' && micro.claims).toEqual({ amount: '150.00', count: null });
  });
});

describe('trendKeyFor', () => {
  it('follows the net/gross switch for Household only', () => {
    expect(trendKeyFor('macro')).toBe('household_net');
    expect(trendKeyFor('macro', 'gross')).toBe('household_burn');
    expect(trendKeyFor('micro', 'net')).toBe('true_net_expense');
  });
});

describe('yearChange', () => {
  const point = (period_key: string, v: string) => ({
    period_key, household_burn: v, household_net: v, true_net_expense: v, net_cash_flow: v,
  });
  const totals = {} as never;

  it('compares a whole year with the year before', () => {
    const months = Array.from({ length: 12 }, (_, i) => point(`2025-${String(i + 1).padStart(2, '0')}`, '10.00'));
    const change = yearChange({ year: 2025, totals, months, previous: point('2024', '100.00') }, 'macro');
    expect(change).toEqual({ delta: 20, fraction: 0.2, previousLabel: '2024' });
  });

  it('names the months for part of a year, and is null without a year before', () => {
    expect(yearChange({ year: 2026, totals, months: [point('2026-01', '5.00')], previous: point('2025', '5.00') }, 'macro')?.previousLabel).toBe(
      'January 2025',
    );
    expect(yearChange({ year: 2026, totals, months: [point('2026-01', '5.00')], previous: null }, 'macro')).toBeNull();
  });
});
