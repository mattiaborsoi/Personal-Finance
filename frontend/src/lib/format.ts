import { UNCATEGORIZED, type AccountConfig, type ClaimType } from '../api';

/**
 * Options for a category dropdown: the configured list, guaranteed to contain
 * "Uncategorized", plus the row's own value when it is not configured (so an
 * old or renamed category is still shown rather than silently changed).
 */
export function categoryOptions(configured: string[], current: string | null | undefined): string[] {
  const options = configured.includes(UNCATEGORIZED) ? [...configured] : [...configured, UNCATEGORIZED];
  return current && !options.includes(current) ? [current, ...options] : options;
}

/** "Uncategorized" is the backend literal; the UI spells it the British way. */
export function categoryLabel(category: string): string {
  return category === UNCATEGORIZED ? 'Uncategorised' : category;
}

/**
 * Parses a numeric-ish value; NaN for null, undefined and the empty string
 * (which `Number()` would silently read as 0).
 */
function toFiniteNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return Number.NaN;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** A split ratio may arrive as a fraction (0.5556) or a percentage (55.56). NaN when absent. */
export function ratioToPercent(ratio: string | number | null | undefined): number {
  const n = toFiniteNumber(ratio);
  if (Number.isNaN(n)) return Number.NaN;
  return Math.abs(n) <= 1 ? n * 100 : n;
}

/** "12.3%"; an em dash when there is no value. */
export function formatPercent(value: number | string | null | undefined, digits = 1): string {
  const n = toFiniteNumber(value);
  if (Number.isNaN(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

/** Signed percentage with a leading + for increases; an em dash when there is no value. */
export function formatSignedPercent(value: number | string | null | undefined, digits = 1): string {
  const n = toFiniteNumber(value);
  if (Number.isNaN(n)) return '—';
  const text = `${Math.abs(n).toFixed(digits)}%`;
  if (n > 0) return `+${text}`;
  if (n < 0) return `-${text}`;
  return text;
}

/** Deviation from the auditor is a fraction (0.35 = 35 % above baseline). NaN when absent. */
export function deviationToPercent(value: number | string | null | undefined): number {
  const n = toFiniteNumber(value);
  if (Number.isNaN(n)) return Number.NaN;
  return Math.abs(n) <= 5 ? n * 100 : n;
}

/** 0.87 -> "87%"; 87 -> "87%". */
export function formatConfidence(value: number | string | null | undefined): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '';
  const pct = n <= 1 ? n * 100 : n;
  return `${Math.round(pct)}%`;
}

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  checking: 'Current',
  credit: 'Credit card',
  credit_supplementary: 'Supplementary card',
  investment_cash: 'Investment',
  savings: 'Savings',
};

export function accountTypeLabel(type: string): string {
  return ACCOUNT_TYPE_LABELS[type] ?? type.replace(/_/g, ' ');
}

/**
 * "HSBC Premier ··4471" style label: the configured `label` when there is one,
 * otherwise institution and account type ("HSBC Current ··4471"); the raw id when
 * the account is unknown.
 */
export function accountLabel(accounts: AccountConfig[], accountId: string | null | undefined): string {
  if (!accountId) return '—';
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return accountId;
  const name = account.label?.trim() || `${account.institution} ${accountTypeLabel(account.account_type)}`;
  return `${name} ··${account.identifier_last4}`;
}

export function claimTypeLabel(
  claimType: ClaimType | string | null | undefined,
  names: { primary: string; secondary: string },
): string {
  switch (claimType) {
    case 'shared_proportional':
      return 'Split by income';
    case 'shared_equal':
      return '50/50';
    case 'primary_personal':
      return `${names.primary}'s personal item`;
    case 'secondary_personal':
      return `${names.secondary}'s personal item`;
    case 'personal':
      return 'Personal (not shared)';
    case null:
    case undefined:
    case '':
      return '—';
    default:
      return String(claimType).replace(/_/g, ' ');
  }
}

export function reviewStatusLabel(status: string): string {
  switch (status) {
    case 'pending_review':
      return 'Pending review';
    case 'auto_approved':
      return 'Auto-approved';
    case 'manual_approved':
      return 'Approved';
    default:
      return status.replace(/_/g, ' ');
  }
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** "Alex Smith" -> "AS"; "sam" -> "S"; blank -> "?". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '');
  return letters.join('') || '?';
}

/** Small, stable, non-cryptographic hash so a name always maps to the same colour slot. */
export function stableHash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(h);
}
