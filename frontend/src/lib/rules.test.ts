import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { rule, rules } from '../test/fixtures';
import {
  blankRule,
  buildRulesUpdate,
  matchText,
  offendingItem,
  ruleFieldFor,
  rulesFormChanged,
  rulesFormFrom,
  toRule,
  validateRulesForm,
} from './rules';

const refusal = (message: string, detail: unknown = message) => new ApiError(422, detail, message);

describe('rules form', () => {
  it('sends a row trimmed, with blanks as null and no target account unless it is a transfer', () => {
    const row = { ...blankRule('Dining', 'personal'), pattern: '  (?i)OCADO ', merchant: '  ', transfer_to_account: 'acc_x' };
    expect(toRule(row)).toEqual({
      pattern: '(?i)OCADO',
      category: 'Dining',
      claim_type: 'personal',
      merchant: null,
      subcategory: null,
      is_internal_transfer: false,
      transfer_to_account: null,
    });
    expect(toRule({ ...row, is_internal_transfer: true }).transfer_to_account).toBe('acc_x');
  });

  it('builds a body of only the lists and numbers that changed', () => {
    const saved = rules();
    const form = rulesFormFrom(saved);
    expect(buildRulesUpdate(form, saved)).toEqual({});
    // A saved subcategory survives the round trip untouched.
    const withSub = rules({ rules: [rule({ subcategory: 'Water' })] });
    expect(buildRulesUpdate(rulesFormFrom(withSub), withSub)).toEqual({});

    expect(buildRulesUpdate({ ...form, amount_tolerance: '0.010' }, saved)).toEqual({});
    expect(buildRulesUpdate({ ...form, amount_tolerance: '0.5', match_window_days: '3' }, saved)).toEqual({
      amount_tolerance: '0.5',
      match_window_days: 3,
    });
    // Out of range is left out rather than sent.
    expect(buildRulesUpdate({ ...form, match_window_days: '61' }, saved)).toEqual({});
    expect(buildRulesUpdate({ ...form, patterns: form.patterns.slice(1) }, saved)).toEqual({
      payment_patterns: [saved.payment_patterns[1]],
    });
    expect(buildRulesUpdate({ ...form, rules: [...form.rules].reverse() }, saved)).toEqual({ rules: [...saved.rules].reverse() });
  });

  it('counts an unsendable edit as a change, so it can be discarded', () => {
    const saved = rules();
    const form = rulesFormFrom(saved);
    expect(rulesFormChanged(form, saved)).toBe(false);
    const outOfRange = { ...form, match_window_days: '99' };
    expect(buildRulesUpdate(outOfRange, saved)).toEqual({});
    expect(rulesFormChanged(outOfRange, saved)).toBe(true);
  });

  it('points out blank patterns, a transfer with no account and numbers out of range', () => {
    const form = rulesFormFrom(rules());
    form.rules[0] = { ...form.rules[0], pattern: ' ' };
    form.rules[1] = { ...form.rules[1], transfer_to_account: '' };
    form.patterns[1] = { ...form.patterns[1], value: '' };
    const problems = validateRulesForm({ ...form, match_window_days: '7.5', amount_tolerance: '-1' });
    expect(problems.rules[0].field).toBe('pattern');
    expect(problems.rules[1].field).toBe('transfer_to_account');
    expect(Object.keys(problems.patterns)).toEqual(['1']);
    expect(problems.match_window_days).toBeDefined();
    expect(problems.amount_tolerance).toBeDefined();
  });

  it('describes a match the way the claim-type menu does, counting rules from 1', () => {
    expect(matchText(2, rule(), { primary: 'Alex', secondary: 'Sam' })).toBe('Matches rule 3 → Bills:Water, Split by income');
    expect(matchText(0, rule({ category: 'Uncategorized', claim_type: 'secondary_personal' }), { primary: 'Alex', secondary: 'Sam' })).toBe(
      "Matches rule 1 → Uncategorised, Sam's personal item",
    );
  });

  it('places a 422 on the row, and the control, it names', () => {
    expect(offendingItem(refusal("rule 3: invalid regex '(': missing ), unterminated subpattern at position 0"))).toEqual({
      kind: 'rule',
      index: 2,
      field: 'pattern',
    });
    expect(offendingItem(refusal("rule 2: category 'Foo' is not in the configured taxonomy"))).toEqual({
      kind: 'rule',
      index: 1,
      field: 'category',
    });
    expect(offendingItem(refusal('rule 5: unknown claim_type'))).toEqual({ kind: 'rule', index: 4, field: 'claim_type' });
    expect(offendingItem(refusal("rule 4: transfer_to_account 'acc_x' is not an account"))).toEqual({
      kind: 'rule',
      index: 3,
      field: 'transfer_to_account',
    });
    expect(offendingItem(refusal("payment pattern 2: invalid regex '['"))).toEqual({ kind: 'pattern', index: 1 });
    expect(offendingItem(refusal('match_window_days must be between 0 and 60'))).toEqual({ kind: 'match_window_days' });
    expect(offendingItem(refusal('amount_tolerance must be between 0 and 10'))).toEqual({ kind: 'amount_tolerance' });
    // A FastAPI loc counts from 0.
    expect(offendingItem(refusal('x', [{ loc: ['body', 'rules', 0, 'claim_type'], msg: 'bad' }]))).toEqual({
      kind: 'rule',
      index: 0,
      field: 'claim_type',
    });
    expect(offendingItem(refusal('x', [{ loc: ['body', 'payment_patterns', 3], msg: 'bad' }]))).toEqual({ kind: 'pattern', index: 3 });
    expect(offendingItem(refusal('the taxonomy could not be applied'))).toBeNull();
  });

  it('reads which control of a rule the words are about', () => {
    expect(ruleFieldFor('rule 1: merchant is longer than 128 characters')).toBe('merchant');
    expect(ruleFieldFor('rule 1: pattern must not be empty')).toBe('pattern');
    expect(ruleFieldFor('rule 1: category must not be empty')).toBe('category');
    // The subcategory has no control here, so the row's pattern carries it.
    expect(ruleFieldFor('rule 1: subcategory is longer than 64 characters')).toBe('pattern');
  });
});
