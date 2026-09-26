import { describe, expect, it } from 'vitest';
import { formatMoney, formatSignedMoney, normaliseAmountInput, toNumber } from './money';

describe('formatMoney', () => {
  it('shows negatives with the sign before the currency symbol', () => {
    expect(formatMoney('-12.34', '£')).toBe('-£12.34');
  });

  it('formats positive values with two decimals and thousands separators', () => {
    expect(formatMoney('1234.5', '£')).toBe('£1,234.50');
    expect(formatMoney('1000000', '£')).toBe('£1,000,000.00');
    expect(formatMoney(7, '$')).toBe('$7.00');
  });

  it('treats zero and negative zero as plain zero', () => {
    expect(formatMoney('0', '£')).toBe('£0.00');
    expect(formatMoney('-0.00', '£')).toBe('£0.00');
    expect(formatMoney(-0.001, '£')).toBe('£0.00');
  });

  it('uses the configured symbol rather than a hard-coded one', () => {
    expect(formatMoney('-45.90', '€')).toBe('-€45.90');
  });

  it('renders an em dash for unparseable input', () => {
    expect(formatMoney(null, '£')).toBe('—');
    expect(formatMoney('abc', '£')).toBe('—');
  });
});

describe('formatSignedMoney', () => {
  it('prefixes positive values with a plus', () => {
    expect(formatSignedMoney('10', '£')).toBe('+£10.00');
    expect(formatSignedMoney('-10', '£')).toBe('-£10.00');
    expect(formatSignedMoney('0', '£')).toBe('£0.00');
  });
});

describe('helpers', () => {
  it('parses decimal strings', () => {
    expect(toNumber('-45.90')).toBe(-45.9);
    expect(Number.isNaN(toNumber(''))).toBe(true);
  });

  it('normalises typed amounts to two decimals', () => {
    expect(normaliseAmountInput('12.5')).toBe('12.50');
    expect(normaliseAmountInput('£1,234')).toBe('1234.00');
    expect(normaliseAmountInput('')).toBeNull();
    expect(normaliseAmountInput('abc')).toBeNull();
  });
});
