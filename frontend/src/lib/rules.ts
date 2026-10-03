import { isApiError, type ApplyRulesResponse, type ClaimType, type Rule, type RulesOut, type RulesUpdate } from '../api';
import { categoryLabel, claimTypeLabel, plural } from './format';
import { parseWhole } from './household';

/**
 * The Rules form: the deterministic rules and the card-payment patterns as
 * rows with stable keys (so a row keeps its input focus when moved), plus the
 * transfer-matching numbers as typed.
 */

export interface RuleRow {
  key: number;
  pattern: string;
  category: string;
  claim_type: ClaimType;
  /** Blank means none. */
  merchant: string;
  /** Not edited here, but kept so a saved value survives a round trip. */
  subcategory: string | null;
  is_internal_transfer: boolean;
  /** Blank means none; only sent while `is_internal_transfer` is on. */
  transfer_to_account: string;
  /** Smallest amount the rule applies to, as typed; blank means no lower bound. */
  amount_min: string;
  /** Largest amount the rule applies to, as typed; blank means no upper bound. */
  amount_max: string;
}

export interface PatternRow {
  key: number;
  value: string;
}

export interface RulesForm {
  rules: RuleRow[];
  patterns: PatternRow[];
  match_window_days: string;
  amount_tolerance: string;
}

let sequence = 0;

/** A fresh key for a row; keys only need to be unique within the page's life. */
export function nextRowKey(): number {
  sequence += 1;
  return sequence;
}

export const WINDOW_MIN = 0;
export const WINDOW_MAX = 60;

export const BLANK_PATTERN_MESSAGE = 'Enter a pattern.';
export const MISSING_ACCOUNT_MESSAGE = 'Choose the account the money goes to.';
export const WINDOW_MESSAGE = `Enter a whole number of days between ${WINDOW_MIN} and ${WINDOW_MAX}.`;
export const TOLERANCE_MESSAGE = 'Enter an amount of 0 or more, e.g. 0.01.';
export const AMOUNT_BOUND_MESSAGE = 'Enter an amount of 0 or more with at most 2 decimals, e.g. 40.00, or leave it blank.';
export const AMOUNT_ORDER_MESSAGE = 'The largest amount must not be less than the smallest.';
export const TRY_AMOUNT_MESSAGE = 'Enter an amount with at most 2 decimals, e.g. 40.00, or leave it blank.';

/**
 * A rule's amount bound as typed ("40", "£40.5", " 1,250.00 ") in the wire's
 * shape ("40.00", "40.50", "1250.00"); null when blank, undefined when it is not
 * an amount of 0 or more with at most two decimals. The sign is never typed: the
 * bounds apply to the line's amount whichever way the money went.
 */
export function parseAmountBound(raw: string): string | null | undefined {
  const trimmed = raw.trim().replace(/^£\s*/, '').replace(/,/g, '');
  if (!trimmed) return null;
  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(trimmed) ?? /^()\.(\d{1,2})$/.exec(trimmed);
  if (!m) return undefined;
  const whole = (m[1] || '0').replace(/^0+(?=\d)/, '');
  return `${whole}.${(m[2] ?? '').padEnd(2, '0')}`;
}

/** The tester's optional amount: either sign, at most two decimals; null when blank, undefined when unusable. */
export function parseTryAmount(raw: string): string | null | undefined {
  const trimmed = raw.trim();
  const negative = /^[-−]/.test(trimmed);
  const bound = parseAmountBound(negative ? trimmed.slice(1) : trimmed);
  if (bound === null) return negative ? undefined : null;
  if (bound === undefined) return undefined;
  return negative ? `-${bound}` : bound;
}

export function ruleRowFrom(rule: Rule): RuleRow {
  return {
    key: nextRowKey(),
    pattern: rule.pattern,
    category: rule.category,
    claim_type: rule.claim_type,
    merchant: rule.merchant ?? '',
    subcategory: rule.subcategory,
    is_internal_transfer: rule.is_internal_transfer,
    transfer_to_account: rule.transfer_to_account ?? '',
    amount_min: rule.amount_min ?? '',
    amount_max: rule.amount_max ?? '',
  };
}

/** A new rule with the given category and claim type, ready to type a pattern into. */
export function blankRule(category: string, claimType: ClaimType): RuleRow {
  return {
    key: nextRowKey(),
    pattern: '',
    category,
    claim_type: claimType,
    merchant: '',
    subcategory: null,
    is_internal_transfer: false,
    transfer_to_account: '',
    amount_min: '',
    amount_max: '',
  };
}

export function blankPattern(): PatternRow {
  return { key: nextRowKey(), value: '' };
}

export function rulesFormFrom(saved: RulesOut): RulesForm {
  return {
    rules: saved.rules.map(ruleRowFrom),
    patterns: saved.payment_patterns.map((value) => ({ key: nextRowKey(), value })),
    match_window_days: String(saved.match_window_days),
    amount_tolerance: saved.amount_tolerance,
  };
}

/**
 * The row in the wire's shape: trimmed, blanks as null, and no target account
 * unless it is a transfer. An amount bound is only sent when set (an absent one
 * is an open side, and a list sent replaces the saved one).
 */
export function toRule(row: RuleRow): Rule {
  const amountMin = parseAmountBound(row.amount_min);
  const amountMax = parseAmountBound(row.amount_max);
  return {
    pattern: row.pattern.trim(),
    category: row.category,
    claim_type: row.claim_type,
    merchant: row.merchant.trim() || null,
    subcategory: row.subcategory,
    is_internal_transfer: row.is_internal_transfer,
    transfer_to_account: row.is_internal_transfer ? row.transfer_to_account || null : null,
    ...(amountMin ? { amount_min: amountMin } : {}),
    ...(amountMax ? { amount_max: amountMax } : {}),
  };
}

export function rulesOf(form: RulesForm): Rule[] {
  return form.rules.map(toRule);
}

export function patternsOf(form: RulesForm): string[] {
  return form.patterns.map((row) => row.value.trim());
}

/** A tolerance as typed, trimmed; null when blank, unparsable or negative. It is sent as a decimal string, unrounded. */
export function parseTolerance(raw: string): string | null {
  const trimmed = raw.trim();
  return /^\d+(\.\d+)?$/.test(trimmed) ? trimmed : null;
}

/** The control in a rule's row that a problem is about. */
export type RuleField = 'pattern' | 'category' | 'claim_type' | 'merchant' | 'transfer_to_account' | 'amount_min' | 'amount_max';

const RULE_FIELDS: readonly RuleField[] = [
  'pattern',
  'category',
  'claim_type',
  'merchant',
  'transfer_to_account',
  'amount_min',
  'amount_max',
];

export interface RuleProblem {
  message: string;
  field: RuleField;
}

export interface RulesProblems {
  /** By row index. */
  rules: Record<number, RuleProblem>;
  patterns: Record<number, string>;
  match_window_days?: string;
  amount_tolerance?: string;
}

/** What cannot be sent: blank patterns, a transfer without an account, numbers outside their range. Regexes are the server's to judge. */
export function validateRulesForm(form: RulesForm): RulesProblems {
  const problems: RulesProblems = { rules: {}, patterns: {} };
  form.rules.forEach((row, index) => {
    const min = parseAmountBound(row.amount_min);
    const max = parseAmountBound(row.amount_max);
    if (!row.pattern.trim()) problems.rules[index] = { message: BLANK_PATTERN_MESSAGE, field: 'pattern' };
    else if (row.is_internal_transfer && !row.transfer_to_account) {
      problems.rules[index] = { message: MISSING_ACCOUNT_MESSAGE, field: 'transfer_to_account' };
    } else if (min === undefined) problems.rules[index] = { message: AMOUNT_BOUND_MESSAGE, field: 'amount_min' };
    else if (max === undefined) problems.rules[index] = { message: AMOUNT_BOUND_MESSAGE, field: 'amount_max' };
    else if (min !== null && max !== null && Number(max) < Number(min)) {
      problems.rules[index] = { message: AMOUNT_ORDER_MESSAGE, field: 'amount_max' };
    }
  });
  form.patterns.forEach((row, index) => {
    if (!row.value.trim()) problems.patterns[index] = BLANK_PATTERN_MESSAGE;
  });
  if (parseWhole(form.match_window_days, WINDOW_MIN, WINDOW_MAX) === null) problems.match_window_days = WINDOW_MESSAGE;
  if (parseTolerance(form.amount_tolerance) === null) problems.amount_tolerance = TOLERANCE_MESSAGE;
  return problems;
}

export function hasRulesProblems(problems: RulesProblems): boolean {
  return (
    Object.keys(problems.rules).length > 0 ||
    Object.keys(problems.patterns).length > 0 ||
    problems.match_window_days !== undefined ||
    problems.amount_tolerance !== undefined
  );
}

/** A rule with its keys in a fixed order, so two lists compare as JSON. */
function canonical(rule: Rule): string {
  return JSON.stringify([
    rule.pattern,
    rule.category,
    rule.claim_type,
    rule.merchant ?? null,
    rule.subcategory ?? null,
    rule.is_internal_transfer,
    rule.transfer_to_account ?? null,
    rule.amount_min ?? null,
    rule.amount_max ?? null,
  ]);
}

export function sameRules(a: Rule[], b: Rule[]): boolean {
  return a.length === b.length && a.every((rule, i) => canonical(rule) === canonical(b[i]));
}

/** Only the lists and numbers that differ from what is saved; an empty object means nothing changed. */
export function buildRulesUpdate(form: RulesForm, saved: RulesOut): RulesUpdate {
  const body: RulesUpdate = {};
  const rules = rulesOf(form);
  if (!sameRules(rules, saved.rules)) body.rules = rules;
  const patterns = patternsOf(form);
  if (JSON.stringify(patterns) !== JSON.stringify(saved.payment_patterns)) body.payment_patterns = patterns;
  const days = parseWhole(form.match_window_days, WINDOW_MIN, WINDOW_MAX);
  if (days !== null && days !== saved.match_window_days) body.match_window_days = days;
  const tolerance = parseTolerance(form.amount_tolerance);
  if (tolerance !== null && Number(tolerance) !== Number(saved.amount_tolerance)) body.amount_tolerance = tolerance;
  return body;
}

/** Everything the form shows, without the row keys, so two forms compare as JSON. */
function formSnapshot(form: RulesForm): string {
  return JSON.stringify([
    form.rules.map((row) => [
      row.pattern,
      row.category,
      row.claim_type,
      row.merchant,
      row.subcategory,
      row.is_internal_transfer,
      row.transfer_to_account,
      row.amount_min,
      row.amount_max,
    ]),
    form.patterns.map((row) => row.value),
    form.match_window_days,
    form.amount_tolerance,
  ]);
}

/**
 * True when the form differs from what is saved in anything on screen, whether
 * or not it could be sent: a half-typed number or a blank pattern is still
 * something Discard can put back.
 */
export function rulesFormChanged(form: RulesForm, saved: RulesOut): boolean {
  return formSnapshot(form) !== formSnapshot(rulesFormFrom(saved));
}

/** "Matches rule 3 → Bills:Water, Split by income", for the tester; `index` counts from 0 as the server does. */
export function matchText(index: number, rule: Rule, names: { primary: string; secondary: string }): string {
  return `Matches rule ${index + 1} → ${categoryLabel(rule.category)}, ${claimTypeLabel(rule.claim_type, names)}`;
}

/**
 * Which control of a rule the server's words are about, after the "rule N:"
 * prefix: "category 'Foo' is not in the configured taxonomy", "unknown claim_type",
 * "transfer_to_account 'acc_x' is not an account", "merchant is longer than …",
 * "amount_max must not be less than amount_min".
 * Anything else (an invalid regex, a blank or long pattern) is the pattern's.
 */
export function ruleFieldFor(message: string): RuleField {
  const text = message.replace(/^\s*rule\s+\d+\s*:\s*/i, '');
  if (/^transfer_to_account\b/i.test(text)) return 'transfer_to_account';
  if (/^(unknown\s+)?claim_type\b/i.test(text)) return 'claim_type';
  if (/^category\b/i.test(text)) return 'category';
  if (/^merchant\b/i.test(text)) return 'merchant';
  if (/^amount_min\b/i.test(text)) return 'amount_min';
  if (/^amount_max\b/i.test(text)) return 'amount_max';
  return 'pattern';
}

/** A row (0-based) or one of the two numbers that a 422 is about. */
export type OffendingItem =
  | { kind: 'rule'; index: number; field: RuleField }
  | { kind: 'pattern'; index: number }
  | { kind: 'match_window_days' | 'amount_tolerance' };

/**
 * What a 422 is about: "rule 3: invalid regex …" and "payment pattern 2: …"
 * count from 1 as people do; a FastAPI `loc` such as ["body", "rules", 2, "pattern"]
 * counts from 0; "match_window_days must be …" names a number. Null when the
 * message names nothing on the form.
 */
export function offendingItem(err: unknown): OffendingItem | null {
  if (!isApiError(err)) return null;
  if (Array.isArray(err.detail)) {
    for (const item of err.detail) {
      const loc = item && typeof item === 'object' ? (item as { loc?: unknown }).loc : undefined;
      if (!Array.isArray(loc)) continue;
      const at = loc.findIndex((part) => part === 'rules' || part === 'payment_patterns');
      if (at >= 0 && typeof loc[at + 1] === 'number') {
        const index = loc[at + 1] as number;
        if (loc[at] === 'payment_patterns') return { kind: 'pattern', index };
        const named = loc[at + 2];
        const field = RULE_FIELDS.includes(named as RuleField) ? (named as RuleField) : 'pattern';
        return { kind: 'rule', index, field };
      }
      if (loc.includes('match_window_days')) return { kind: 'match_window_days' };
      if (loc.includes('amount_tolerance')) return { kind: 'amount_tolerance' };
    }
    return null;
  }
  const row = /^\s*(rule|payment pattern)\s+(\d+)\s*:/i.exec(err.message);
  if (row) {
    const index = Number(row[2]) - 1;
    return row[1].toLowerCase() === 'rule' ? { kind: 'rule', index, field: ruleFieldFor(err.message) } : { kind: 'pattern', index };
  }
  if (/match_window_days|match window/i.test(err.message)) return { kind: 'match_window_days' };
  if (/amount_tolerance|amount tolerance/i.test(err.message)) return { kind: 'amount_tolerance' };
  return null;
}

/** The server's refusal placed on the form; null when it names nothing there. */
export function problemsForError(err: unknown, message: string): RulesProblems | null {
  const item = offendingItem(err);
  if (!item) return null;
  const problems: RulesProblems = { rules: {}, patterns: {} };
  if (item.kind === 'rule') problems.rules[item.index] = { message, field: item.field };
  else if (item.kind === 'pattern') problems.patterns[item.index] = message;
  else problems[item.kind] = message;
  return problems;
}

// ---------------------------------------------------------------------------
// Apply to waiting lines
// ---------------------------------------------------------------------------

export const NOTHING_TO_APPLY_MESSAGE = 'No waiting line matches your rules, so nothing would change.';

/** What a dry run of "Apply to waiting lines" found, in one sentence. */
export function applyPreviewSentence(result: ApplyRulesResponse): string {
  if (result.matched === 0) return NOTHING_TO_APPLY_MESSAGE;
  const verb = result.matched === 1 ? 'matches' : 'match';
  const change = result.changed === 0 ? 'none would change' : `${result.changed} would change`;
  return `${plural(result.matched, 'waiting line')} ${verb} your rules; ${change} (${result.approved} approved).`;
}

/** What a run of "Apply to waiting lines" did, announced on the Rules tab. */
export function appliedSentence(result: ApplyRulesResponse): string {
  if (result.approved === 0) return NOTHING_TO_APPLY_MESSAGE;
  const refiled = result.changed === 0 ? 'none refiled' : `${result.changed} refiled`;
  return `Rules applied: ${plural(result.approved, 'waiting line')} approved, ${refiled}.`;
}

/** After a save, when the saved rules match lines already waiting for review. */
export function waitingMatchMessage(count: number): string {
  const rest = count === 1 ? 'matches them but keeps its earlier guess' : 'match them but keep their earlier guess';
  return `${plural(count, 'line')} already waiting for review ${rest} until you apply the rules.`;
}
