import { isApiError, type HouseholdOut, type HouseholdUpdate, type HouseholdUser, type HouseholdUserUpdate, type Money, type SplitStrategy } from '../api';
import { normaliseAmountInput } from './money';

/**
 * The Household form: names, incomes, the split, settlement and currency, as
 * typed. Amounts and whole numbers are strings on the form and parsed on the
 * way out, so a half-typed value never turns into a false 0.
 */

export type Person = 'primary' | 'secondary';
export const PEOPLE: readonly Person[] = ['primary', 'secondary'];

export interface PersonFields {
  display_name: string;
  base_salary_pa: string;
  additional_income_pa: string;
}

export interface HouseholdForm {
  primary: PersonFields;
  secondary: PersonFields;
  split_strategy: SplitStrategy;
  settlement_day_of_month: string;
  rounding_decimals: string;
  base_currency: string;
  currency_symbol: string;
}

type PersonField = keyof PersonFields;
type TopField = 'split_strategy' | 'settlement_day_of_month' | 'rounding_decimals' | 'base_currency' | 'currency_symbol';

/** A field on the form, e.g. "secondary.base_salary_pa" or "currency_symbol". */
export type HouseholdField = `${Person}.${PersonField}` | TopField;
export type HouseholdProblems = Partial<Record<HouseholdField, string>>;

export const SETTLEMENT_DAY_MIN = 1;
/** Every month has a 28th, so the settlement never lands on a day that does not exist. */
export const SETTLEMENT_DAY_MAX = 28;
export const ROUNDING_MIN = 0;
export const ROUNDING_MAX = 6;

export const BLANK_NAME_MESSAGE = 'Enter a name.';
export const BAD_AMOUNT_MESSAGE = 'Enter an amount of 0 or more.';
export const NO_INCOME_MESSAGE = 'Enter an income for at least one person, or split 50–50.';
export const SETTLEMENT_DAY_MESSAGE = `Enter a day between ${SETTLEMENT_DAY_MIN} and ${SETTLEMENT_DAY_MAX}.`;
export const ROUNDING_MESSAGE = `Enter a whole number between ${ROUNDING_MIN} and ${ROUNDING_MAX}.`;
export const CURRENCY_CODE_MESSAGE = 'Use the three-letter code, e.g. GBP.';
export const CURRENCY_SYMBOL_MESSAGE = 'Use 1 to 3 characters, e.g. £.';

/** "100000.00" reads as "100000" in an input; a fractional amount keeps its pence. */
export function amountForInput(value: Money): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function personFrom(user: HouseholdUser): PersonFields {
  return {
    display_name: user.display_name,
    base_salary_pa: amountForInput(user.base_salary_pa),
    additional_income_pa: amountForInput(user.additional_income_pa),
  };
}

export function householdFormFrom(saved: HouseholdOut): HouseholdForm {
  return {
    primary: personFrom(saved.users.primary),
    secondary: personFrom(saved.users.secondary),
    split_strategy: saved.split_strategy,
    settlement_day_of_month: String(saved.settlement_day_of_month),
    rounding_decimals: String(saved.rounding_decimals),
    base_currency: saved.base_currency,
    currency_symbol: saved.currency_symbol,
  };
}

/**
 * True when the form differs from the saved household in anything on screen,
 * whether or not it could be sent: a cleared name is still something Discard can put back.
 */
export function householdFormChanged(form: HouseholdForm, saved: HouseholdOut): boolean {
  const base = householdFormFrom(saved);
  const samePerson = (a: PersonFields, b: PersonFields) =>
    a.display_name === b.display_name && a.base_salary_pa === b.base_salary_pa && a.additional_income_pa === b.additional_income_pa;
  return !(
    samePerson(form.primary, base.primary) &&
    samePerson(form.secondary, base.secondary) &&
    form.split_strategy === base.split_strategy &&
    form.settlement_day_of_month === base.settlement_day_of_month &&
    form.rounding_decimals === base.rounding_decimals &&
    form.base_currency === base.base_currency &&
    form.currency_symbol === base.currency_symbol
  );
}

/** A typed income as a two-decimal string; blank counts as nothing. Null when unparsable or negative. */
export function parseIncome(raw: string): Money | null {
  if (!raw.trim()) return '0.00';
  const normalised = normaliseAmountInput(raw);
  if (normalised === null || Number(normalised) < 0) return null;
  return normalised;
}

/** A whole number inside its range, or null. */
export function parseWhole(raw: string, min: number, max: number): number | null {
  if (!/^\s*\d+\s*$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

interface ParsedPerson {
  display_name: string;
  base_salary_pa: Money | null;
  additional_income_pa: Money | null;
}

export interface ParsedHousehold {
  primary: ParsedPerson;
  secondary: ParsedPerson;
  settlement_day_of_month: number | null;
  rounding_decimals: number | null;
  base_currency: string;
  currency_symbol: string;
  /** Fields that cannot be sent, with why. Empty means the form is valid. */
  problems: HouseholdProblems;
}

function parsePerson(fields: PersonFields): ParsedPerson {
  return {
    display_name: fields.display_name.trim(),
    base_salary_pa: parseIncome(fields.base_salary_pa),
    additional_income_pa: parseIncome(fields.additional_income_pa),
  };
}

/** The person's income for the year; NaN while either amount is unparsable. */
export function incomeOf(fields: PersonFields): number {
  const salary = parseIncome(fields.base_salary_pa);
  const other = parseIncome(fields.additional_income_pa);
  if (salary === null || other === null) return Number.NaN;
  return Number(salary) + Number(other);
}

export function parseHouseholdForm(form: HouseholdForm): ParsedHousehold {
  const problems: HouseholdProblems = {};
  const parsed: ParsedHousehold = {
    primary: parsePerson(form.primary),
    secondary: parsePerson(form.secondary),
    settlement_day_of_month: parseWhole(form.settlement_day_of_month, SETTLEMENT_DAY_MIN, SETTLEMENT_DAY_MAX),
    rounding_decimals: parseWhole(form.rounding_decimals, ROUNDING_MIN, ROUNDING_MAX),
    base_currency: form.base_currency.trim().toUpperCase(),
    currency_symbol: form.currency_symbol.trim(),
    problems,
  };
  for (const person of PEOPLE) {
    if (!parsed[person].display_name) problems[`${person}.display_name`] = BLANK_NAME_MESSAGE;
    if (parsed[person].base_salary_pa === null) problems[`${person}.base_salary_pa`] = BAD_AMOUNT_MESSAGE;
    if (parsed[person].additional_income_pa === null) problems[`${person}.additional_income_pa`] = BAD_AMOUNT_MESSAGE;
  }
  if (form.split_strategy === 'salary_proportional') {
    const total = incomeOf(form.primary) + incomeOf(form.secondary);
    if (Number.isFinite(total) && total <= 0) problems.split_strategy = NO_INCOME_MESSAGE;
  }
  if (parsed.settlement_day_of_month === null) problems.settlement_day_of_month = SETTLEMENT_DAY_MESSAGE;
  if (parsed.rounding_decimals === null) problems.rounding_decimals = ROUNDING_MESSAGE;
  if (!/^[A-Z]{3}$/.test(parsed.base_currency)) problems.base_currency = CURRENCY_CODE_MESSAGE;
  const symbolLength = [...parsed.currency_symbol].length;
  if (symbolLength < 1 || symbolLength > 3) problems.currency_symbol = CURRENCY_SYMBOL_MESSAGE;
  return parsed;
}

export interface SplitPreview {
  /** Percentages; they sum to 100. */
  primary: number;
  secondary: number;
}

/** What the strategy on the form gives from the incomes on the form; null while proportional has nothing to go on. */
export function splitPreview(form: HouseholdForm): SplitPreview | null {
  if (form.split_strategy === 'equal_50_50') return { primary: 50, secondary: 50 };
  const primary = incomeOf(form.primary);
  const secondary = incomeOf(form.secondary);
  const total = primary + secondary;
  if (!Number.isFinite(total) || total <= 0) return null;
  return { primary: (primary / total) * 100, secondary: (secondary / total) * 100 };
}

/** "Alex 55.6 % · Sam 44.4 %". */
export function splitPreviewText(preview: SplitPreview, names: { primary: string; secondary: string }): string {
  return `${names.primary} ${preview.primary.toFixed(1)} % · ${names.secondary} ${preview.secondary.toFixed(1)} %`;
}

function sameAmount(a: Money | null, b: Money): boolean {
  return a !== null && Number(a) === Number(b);
}

/** Only what differs from the saved household; an empty object means nothing changed. Invalid fields are left out. */
export function buildHouseholdUpdate(form: HouseholdForm, parsed: ParsedHousehold, saved: HouseholdOut): HouseholdUpdate {
  const body: HouseholdUpdate = {};
  for (const person of PEOPLE) {
    const typed = parsed[person];
    const current = saved.users[person];
    const update: HouseholdUserUpdate = {};
    if (typed.display_name && typed.display_name !== current.display_name) update.display_name = typed.display_name;
    if (typed.base_salary_pa !== null && !sameAmount(typed.base_salary_pa, current.base_salary_pa)) {
      update.base_salary_pa = typed.base_salary_pa;
    }
    if (typed.additional_income_pa !== null && !sameAmount(typed.additional_income_pa, current.additional_income_pa)) {
      update.additional_income_pa = typed.additional_income_pa;
    }
    if (Object.keys(update).length > 0) {
      body.users = { ...body.users, [person]: update };
    }
  }
  if (form.split_strategy !== saved.split_strategy) body.split_strategy = form.split_strategy;
  if (parsed.settlement_day_of_month !== null && parsed.settlement_day_of_month !== saved.settlement_day_of_month) {
    body.settlement_day_of_month = parsed.settlement_day_of_month;
  }
  if (parsed.rounding_decimals !== null && parsed.rounding_decimals !== saved.rounding_decimals) {
    body.rounding_decimals = parsed.rounding_decimals;
  }
  if (parsed.base_currency && parsed.base_currency !== saved.base_currency) body.base_currency = parsed.base_currency;
  if (parsed.currency_symbol && parsed.currency_symbol !== saved.currency_symbol) body.currency_symbol = parsed.currency_symbol;
  return body;
}

const TOP_FIELDS: readonly TopField[] = [
  'split_strategy',
  'settlement_day_of_month',
  'rounding_decimals',
  'base_currency',
  'currency_symbol',
];
const PERSON_FIELDS: readonly PersonField[] = ['display_name', 'base_salary_pa', 'additional_income_pa'];

/** A FastAPI `loc` such as ["body", "users", "secondary", "base_salary_pa"] as a field on the form. */
function fieldFromLoc(loc: unknown): HouseholdField | null {
  if (!Array.isArray(loc)) return null;
  const parts = loc.filter((part): part is string => typeof part === 'string' && part !== 'body');
  if (parts[0] === 'users') parts.shift();
  const [first, second] = parts;
  if (TOP_FIELDS.includes(first as TopField)) return first as TopField;
  if (PEOPLE.includes(first as Person) && PERSON_FIELDS.includes(second as PersonField)) {
    return `${first as Person}.${second as PersonField}`;
  }
  return null;
}

/** The one person whose name (or income) the update carried; null when neither or both did. */
function onlyPersonSent(sent: HouseholdUpdate, kind: PersonField): Person | null {
  const candidates = PEOPLE.filter((person) => {
    const user = sent.users?.[person];
    if (!user) return false;
    if (kind === 'display_name') return user.display_name !== undefined;
    return user.base_salary_pa !== undefined || user.additional_income_pa !== undefined;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Which field a plain-English refusal is about, from the words it uses. The
 * server's household messages ("display_name must not be empty", "incomes cannot
 * be negative") do not say whose, so when only one person's value was sent it is
 * theirs. Null when the message names no field.
 */
function fieldFromMessage(message: string, sent: HouseholdUpdate): HouseholdField | null {
  if (/currency_symbol|currency symbol|\bsymbol\b/i.test(message)) return 'currency_symbol';
  if (/base_currency|currency code|\bcurrency\b/i.test(message)) return 'base_currency';
  if (/rounding/i.test(message)) return 'rounding_decimals';
  if (/settlement_day|settlement day|day of (the )?month|day_of_month/i.test(message)) return 'settlement_day_of_month';
  if (/split_strategy|split strategy|proportion|combined income|no income|zero income/i.test(message)) return 'split_strategy';
  const kind: PersonField | null = /additional_income|additional income|other income/i.test(message)
    ? 'additional_income_pa'
    : /base_salary|salary|income/i.test(message)
      ? 'base_salary_pa'
      : /display_name|display name|\bname\b/i.test(message)
        ? 'display_name'
        : null;
  if (!kind) return null;
  const named: Person | null = /secondary|partner/i.test(message) ? 'secondary' : /primary/i.test(message) ? 'primary' : null;
  const person = named ?? onlyPersonSent(sent, kind);
  if (!person) return null;
  // "incomes cannot be negative" is about whichever income went, when only the other one did.
  if (kind === 'base_salary_pa' && !named) {
    const user = sent.users?.[person];
    if (user?.base_salary_pa === undefined && user?.additional_income_pa !== undefined) return `${person}.additional_income_pa`;
  }
  return `${person}.${kind}`;
}

/**
 * The field a 422 is about, so the server's words can sit next to it: from a
 * FastAPI validation `loc` when there is one, else from the words in the message
 * (with `sent`, the body that was refused, to tell whose name or income it means).
 */
export function fieldForError(err: unknown, sent: HouseholdUpdate = {}): HouseholdField | null {
  if (!isApiError(err)) return null;
  if (Array.isArray(err.detail)) {
    for (const item of err.detail) {
      const field = item && typeof item === 'object' ? fieldFromLoc((item as { loc?: unknown }).loc) : null;
      if (field) return field;
    }
    return null;
  }
  return fieldFromMessage(err.message, sent);
}
