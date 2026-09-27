import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { household } from '../test/fixtures';
import {
  amountForInput,
  buildHouseholdUpdate,
  fieldForError,
  householdFormChanged,
  householdFormFrom,
  parseHouseholdForm,
  splitPreview,
  splitPreviewText,
} from './household';

const refusal = (message: string, detail: unknown = message) => new ApiError(422, detail, message);

describe('household form', () => {
  it('shows whole amounts without pence and keeps pence when there are some', () => {
    expect(amountForInput('100000.00')).toBe('100000');
    expect(amountForInput('1250.50')).toBe('1250.50');
    expect(amountForInput('abc')).toBe('abc');
  });

  it('previews the split from the incomes on the form, or 50–50', () => {
    const form = householdFormFrom(household());
    expect(splitPreviewText(splitPreview(form)!, { primary: 'Alex', secondary: 'Sam' })).toBe('Alex 55.6% · Sam 44.4%');
    // Other income counts towards the share.
    const withBonus = { ...form, secondary: { ...form.secondary, additional_income_pa: '20000' } };
    expect(splitPreviewText(splitPreview(withBonus)!, { primary: 'Alex', secondary: 'Sam' })).toBe('Alex 50.0% · Sam 50.0%');
    expect(splitPreview({ ...form, split_strategy: 'equal_50_50' })).toEqual({ primary: 50, secondary: 50 });
    const noIncome = { ...form, primary: { ...form.primary, base_salary_pa: '' }, secondary: { ...form.secondary, base_salary_pa: '0' } };
    expect(splitPreview(noIncome)).toBeNull();
    expect(parseHouseholdForm(noIncome).problems.split_strategy).toBeDefined();
    expect(parseHouseholdForm({ ...noIncome, split_strategy: 'equal_50_50' }).problems).toEqual({});
  });

  it('builds a body of only what changed, with incomes as two-decimal strings', () => {
    const saved = household();
    const form = householdFormFrom(saved);
    expect(buildHouseholdUpdate(form, parseHouseholdForm(form), saved)).toEqual({});

    const edited = {
      ...form,
      primary: { ...form.primary, display_name: '  Alexandra ', base_salary_pa: '100,000' },
      secondary: { ...form.secondary, additional_income_pa: '£1,500.5' },
      base_currency: 'eur',
      rounding_decimals: '2',
    };
    expect(buildHouseholdUpdate(edited, parseHouseholdForm(edited), saved)).toEqual({
      users: { primary: { display_name: 'Alexandra' }, secondary: { additional_income_pa: '1500.50' } },
      base_currency: 'EUR',
    });
  });

  it('counts an unsendable edit as a change, so it can be discarded', () => {
    const saved = household();
    const form = householdFormFrom(saved);
    expect(householdFormChanged(form, saved)).toBe(false);
    const blank = { ...form, primary: { ...form.primary, display_name: '' } };
    expect(buildHouseholdUpdate(blank, parseHouseholdForm(blank), saved)).toEqual({});
    expect(householdFormChanged(blank, saved)).toBe(true);
  });

  it('finds the field a 422 names, by its loc or its words', () => {
    expect(fieldForError(refusal('x', [{ loc: ['body', 'users', 'secondary', 'base_salary_pa'], msg: 'bad' }]))).toBe(
      'secondary.base_salary_pa',
    );
    expect(fieldForError(refusal('x', [{ loc: ['body', 'rounding_decimals'], msg: 'bad' }]))).toBe('rounding_decimals');
    expect(fieldForError(refusal('base_currency must be a three-letter code'))).toBe('base_currency');
    expect(fieldForError(refusal('currency_symbol must be 1 to 3 characters'))).toBe('currency_symbol');
    expect(fieldForError(refusal('rounding_decimals must be between 0 and 6'))).toBe('rounding_decimals');
    expect(fieldForError(refusal('settlement_day_of_month must be between 1 and 28'))).toBe('settlement_day_of_month');
    expect(fieldForError(refusal('salary_proportional needs a positive combined income'))).toBe('split_strategy');
    // Whose name or income is known only from what was sent.
    expect(fieldForError(refusal('display_name must not be empty'), { users: { secondary: { display_name: ' ' } } })).toBe(
      'secondary.display_name',
    );
    expect(fieldForError(refusal('incomes cannot be negative'), { users: { primary: { additional_income_pa: '-1.00' } } })).toBe(
      'primary.additional_income_pa',
    );
    expect(fieldForError(refusal('incomes cannot be negative'), { users: { primary: { base_salary_pa: '-1.00' } } })).toBe(
      'primary.base_salary_pa',
    );
    // Both people sent, or nothing to go on: not placed.
    expect(
      fieldForError(refusal('display_name must not be empty'), {
        users: { primary: { display_name: 'A' }, secondary: { display_name: 'B' } },
      }),
    ).toBeNull();
    expect(fieldForError(refusal('something else entirely'))).toBeNull();
    expect(fieldForError(new Error('network'))).toBeNull();
  });
});
