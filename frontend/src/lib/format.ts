import { UNCATEGORIZED, type AccountConfig, type AccountType, type ClaimType } from '../api';

/**
 * Options for a category dropdown: the configured list, guaranteed to contain
 * "Uncategorized", plus the row's own value when it is not configured (so an
 * old or renamed category is still shown rather than silently changed).
 */
export function categoryOptions(configured: string[], current: string | null | undefined): string[] {
  const options = configured.includes(UNCATEGORIZED) ? [...configured] : [...configured, UNCATEGORIZED];
  return current && !options.includes(current) ? [current, ...options] : options;
}

/** Between a category's group and its name on screen ("Bills › Water"). */
export const CATEGORY_SEPARATOR = ' › ';

/**
 * How a category reads on screen: "Bills:Water" -> "Bills › Water", a bare
 * name as it is, and "Uncategorized" (the backend literal) the British way.
 */
export function categoryLabel(category: string): string {
  if (category === UNCATEGORIZED) return 'Uncategorised';
  if (category.indexOf(':') <= 0) return category;
  return category
    .split(':')
    .map((part) => part.trim())
    .join(CATEGORY_SEPARATOR);
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

/** Every account type the backend accepts, in the order the type picker offers them. */
export const ACCOUNT_TYPES: AccountType[] = ['checking', 'savings', 'credit', 'credit_supplementary', 'investment_cash'];

/** Short form, used after the institution inside row chips ("HSBC Current ··4471"). */
const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  checking: 'Current',
  credit: 'Credit card',
  credit_supplementary: 'Supplementary card',
  investment_cash: 'Investment',
  savings: 'Savings',
};

/** Full form, used on its own in the Accounts table and the type picker. */
const ACCOUNT_TYPE_NAMES: Record<string, string> = {
  ...ACCOUNT_TYPE_LABELS,
  checking: 'Current account',
};

export function accountTypeLabel(type: string): string {
  return ACCOUNT_TYPE_LABELS[type] ?? type.replace(/_/g, ' ');
}

export function accountTypeName(type: string): string {
  return ACCOUNT_TYPE_NAMES[type] ?? type.replace(/_/g, ' ');
}

/** The account's `label` when there is one, otherwise institution and account type ("HSBC Current"). */
export function accountName(account: { label?: string | null; institution: string; account_type: string }): string {
  return account.label?.trim() || `${account.institution} ${accountTypeLabel(account.account_type)}`;
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
  return `${accountName(account)} ··${account.identifier_last4}`;
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

type Person = 'primary' | 'secondary';

/** Who paid a line and whose card it was on, when known (a row knows; the explainer does not). */
export interface ClaimContext {
  /** Whoever pays the card's bill (its `billed_to`, else its holder). */
  payer?: Person;
  /** The card holder, who "Personal" belongs to. */
  holder?: Person;
}

/** Which of the two users an account is held by and billed to, for {@link claimTypeEffect}. */
export function claimContextForAccount(
  account: Pick<AccountConfig, 'owner' | 'billed_to'> | undefined,
  users: { primary: { id: string } },
): ClaimContext {
  if (!account) return {};
  const who = (id: string): Person => (id === users.primary.id ? 'primary' : 'secondary');
  return { holder: who(account.owner), payer: who(account.billed_to || account.owner) };
}

/**
 * What a claim type does to the settlement, in one or two short sentences. With a
 * context it is exact for that line; without one it states the general rule.
 */
export function claimTypeEffect(
  claimType: ClaimType | string | null | undefined,
  names: { primary: string; secondary: string },
  context: ClaimContext = {},
): string {
  const other = (who: Person): Person => (who === 'primary' ? 'secondary' : 'primary');
  const { payer, holder } = context;
  switch (claimType) {
    case 'shared_proportional':
      return 'Shared by both of you, split in proportion to income.';
    case 'shared_equal':
      return 'Shared by both of you, half each.';
    case 'personal':
      if (!holder) return "The card holder's own spending. Nothing to settle, unless someone else pays that card's bill.";
      if (payer && payer !== holder) {
        return `${names[holder]}'s own spending. ${names[payer]} pays this card's bill, so ${names[holder]} pays ${names[payer]} back in full.`;
      }
      return `${names[holder]}'s own spending on ${names[holder]}'s card. Nothing to settle.`;
    case 'primary_personal':
    case 'secondary_personal': {
      const who: Person = claimType === 'primary_personal' ? 'primary' : 'secondary';
      const them = other(who);
      if (!payer) return `Only ${names[who]}'s, whoever paid. If ${names[them]} paid, ${names[who]} pays ${names[them]} back in full.`;
      if (payer === who) return `Only ${names[who]}'s, and ${names[who]} paid. Nothing to settle.`;
      return `Only ${names[who]}'s, but ${names[them]} paid. ${names[who]} pays ${names[them]} back in full.`;
    }
    default:
      return '';
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
