import type { Money } from '../api';

/** Parses a decimal-string money value; NaN when it cannot be parsed. */
export function toNumber(value: Money | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return Number.NaN;
  return typeof value === 'number' ? value : Number(value);
}

/** UK grouping and decimals for every figure (the app is en-GB throughout). */
const AMOUNT = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const COUNT = new Intl.NumberFormat('en-GB');

/** A whole-number count with thousands grouping: `formatCount(12345)` -> `12,345`. */
export function formatCount(n: number): string {
  return COUNT.format(n);
}

/**
 * Formats money for display: `formatMoney("-12.34", "£")` -> `-£12.34`,
 * `formatMoney("1234.5", "£")` -> `£1,234.50`. Non-numeric input renders as an em dash.
 */
export function formatMoney(value: Money | number | null | undefined, symbol: string): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '—';
  const rounded = Math.round(Math.abs(n) * 100) / 100;
  const negative = n < 0 && rounded !== 0;
  return `${negative ? '-' : ''}${symbol}${AMOUNT.format(rounded)}`;
}

/** Like formatMoney but with an explicit leading `+` for positive values. */
export function formatSignedMoney(value: Money | number | null | undefined, symbol: string): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '—';
  const formatted = formatMoney(n, symbol);
  return n > 0 ? `+${formatted}` : formatted;
}

/** Tailwind text colour for a money value by sign (status tokens, never a series colour). */
export function moneyTone(value: Money | number | null | undefined): string {
  const n = toNumber(value);
  if (!Number.isFinite(n) || n === 0) return 'text-ink-2';
  return n < 0 ? 'text-critical-ink' : 'text-good-ink';
}

/** Normalises a user-typed amount to a two-decimal string, or null if invalid. */
export function normaliseAmountInput(raw: string): string | null {
  const cleaned = raw.replace(/[^\d.-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return (Math.round(n * 100) / 100).toFixed(2);
}
