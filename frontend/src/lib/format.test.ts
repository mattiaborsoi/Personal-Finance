import { describe, expect, it } from 'vitest';
import { fixtureConfig } from '../test/utils';
import {
  accountLabel,
  categoryLabel,
  categoryOptions,
  deviationToPercent,
  formatPercent,
  formatSignedPercent,
  ratioToPercent,
} from './format';

describe('formatPercent', () => {
  it('renders an em dash for null, undefined, empty and non-numeric input rather than "0%"', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(undefined)).toBe('—');
    expect(formatPercent('')).toBe('—');
    expect(formatPercent('abc')).toBe('—');
    expect(formatPercent(Number.NaN)).toBe('—');
  });

  it('formats numbers and numeric strings with the requested precision', () => {
    expect(formatPercent(55.56)).toBe('55.6%');
    expect(formatPercent('44.4444', 2)).toBe('44.44%');
    expect(formatPercent(0)).toBe('0.0%');
  });
});

describe('formatSignedPercent', () => {
  it('renders an em dash when there is no value', () => {
    expect(formatSignedPercent(null)).toBe('—');
    expect(formatSignedPercent(undefined)).toBe('—');
    expect(formatSignedPercent('')).toBe('—');
  });

  it('prefixes increases with + and decreases with -', () => {
    expect(formatSignedPercent(12.34, 0)).toBe('+12%');
    expect(formatSignedPercent('-5')).toBe('-5.0%');
    expect(formatSignedPercent(0)).toBe('0.0%');
  });
});

describe('deviationToPercent', () => {
  it('is NaN for a missing deviation instead of a false 0', () => {
    expect(Number.isNaN(deviationToPercent(null))).toBe(true);
    expect(Number.isNaN(deviationToPercent(undefined))).toBe(true);
    expect(Number.isNaN(deviationToPercent(''))).toBe(true);
  });

  it('scales fractions to percentages and leaves percentages alone', () => {
    expect(deviationToPercent(0.35)).toBeCloseTo(35);
    expect(deviationToPercent('-0.1')).toBeCloseTo(-10);
    expect(deviationToPercent(35)).toBe(35);
  });
});

describe('ratioToPercent', () => {
  it('accepts fractions and percentages', () => {
    expect(ratioToPercent('0.555556')).toBeCloseTo(55.5556);
    expect(ratioToPercent(55.56)).toBe(55.56);
    expect(Number.isNaN(ratioToPercent(null))).toBe(true);
  });
});

describe('accountLabel', () => {
  it('uses the configured label with the last four digits', () => {
    expect(accountLabel(fixtureConfig.accounts, 'acc_checking_hsbc')).toBe('HSBC Premier ··4471');
    expect(accountLabel(fixtureConfig.accounts, 'acc_cc_amex_supp')).toBe('Amex Platinum (supplementary) ··3348');
  });

  it('falls back to institution and account type when there is no label', () => {
    const unlabelled = fixtureConfig.accounts.map((a) => ({ ...a, label: null }));
    expect(accountLabel(unlabelled, 'acc_checking_hsbc')).toBe('HSBC Current ··4471');
    expect(accountLabel(unlabelled, 'acc_cc_amex_supp')).toBe('Amex Supplementary card ··3348');
    const blank = fixtureConfig.accounts.map((a) => ({ ...a, label: a.id === 'acc_cc_amex' ? '  ' : null }));
    expect(accountLabel(blank, 'acc_cc_amex')).toBe('Amex Credit card ··7715');
  });

  it('shows the raw id for an unknown account and a dash for none', () => {
    expect(accountLabel(fixtureConfig.accounts, 'acc_unknown')).toBe('acc_unknown');
    expect(accountLabel(fixtureConfig.accounts, null)).toBe('—');
  });
});

describe('categoryOptions', () => {
  it('always includes the backend literal "Uncategorized" and the row’s own value', () => {
    expect(categoryOptions(['Groceries', 'Uncategorized'], 'Groceries')).toEqual(['Groceries', 'Uncategorized']);
    expect(categoryOptions(['Groceries'], null)).toEqual(['Groceries', 'Uncategorized']);
    expect(categoryOptions(['Groceries', 'Uncategorized'], 'Old:Category')).toEqual([
      'Old:Category',
      'Groceries',
      'Uncategorized',
    ]);
  });

  it('labels the literal in British English without changing the value', () => {
    expect(categoryLabel('Uncategorized')).toBe('Uncategorised');
    expect(categoryLabel('Groceries')).toBe('Groceries');
  });

  it('reads a grouped name as "Group › Name"', () => {
    expect(categoryLabel('Bills:Water')).toBe('Bills › Water');
    expect(categoryLabel('Housing: Mortgage')).toBe('Housing › Mortgage');
    expect(categoryLabel('Transport:Taxi:Night')).toBe('Transport › Taxi › Night');
    // A leading colon is not a group.
    expect(categoryLabel(':Odd')).toBe(':Odd');
  });
});
