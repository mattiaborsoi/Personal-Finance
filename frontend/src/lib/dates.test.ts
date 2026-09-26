import { describe, expect, it } from 'vitest';
import { FUTURE_DATE_MESSAGE, MISSING_DATE_MESSAGE, claimDateProblem, isDateProblem } from './claims';
import { currentPeriodKey, defaultPeriodKey, formatDate, periodKeyForDate, periodLabel } from './dates';

const september = new Date(2026, 8, 25); // local time, so no timezone surprises
const keys = (...list: string[]) => list.map((period_key) => ({ period_key }));

describe('defaultPeriodKey', () => {
  it('prefers the current month when it is on record, wherever it sits in the list', () => {
    expect(defaultPeriodKey(keys('2026-10', '2026-09', '2026-08'), september)).toBe('2026-09');
    expect(defaultPeriodKey(keys('2026-08', '2026-09'), september)).toBe('2026-09');
  });

  it('otherwise picks the newest period that is not in the future', () => {
    expect(defaultPeriodKey(keys('2026-11', '2026-10', '2026-07', '2026-06'), september)).toBe('2026-07');
    expect(defaultPeriodKey(keys('2026-06', '2026-07'), september)).toBe('2026-07');
  });

  it('falls back to the first listed period when everything is in the future', () => {
    expect(defaultPeriodKey(keys('2026-11', '2026-10'), september)).toBe('2026-11');
  });

  it('is null when nothing is listed', () => {
    expect(defaultPeriodKey([], september)).toBeNull();
  });
});

describe('periodKeyForDate', () => {
  it('takes the month of a YYYY-MM-DD date', () => {
    expect(periodKeyForDate('2026-03-07')).toBe('2026-03');
  });

  it('falls back to the current month for blank or malformed input', () => {
    expect(periodKeyForDate('', september)).toBe('2026-09');
    expect(periodKeyForDate(null, september)).toBe('2026-09');
    expect(periodKeyForDate('garbage', september)).toBe('2026-09');
    expect(currentPeriodKey(september)).toBe('2026-09');
  });
});

describe('claimDateProblem', () => {
  it('rejects dates after today and blanks, accepts today and the past', () => {
    expect(claimDateProblem('2026-09-26', '2026-09-25')).toBe(FUTURE_DATE_MESSAGE);
    expect(claimDateProblem('2027-01-01', '2026-09-25')).toBe(FUTURE_DATE_MESSAGE);
    expect(claimDateProblem('2026-09-25', '2026-09-25')).toBeNull();
    expect(claimDateProblem('2026-03-05', '2026-09-25')).toBeNull();
    expect(claimDateProblem('', '2026-09-25')).toBe(MISSING_DATE_MESSAGE);
    expect(isDateProblem(FUTURE_DATE_MESSAGE)).toBe(true);
    expect(isDateProblem('Enter an amount greater than zero.')).toBe(false);
    expect(isDateProblem(null)).toBe(false);
  });
});

describe('labels', () => {
  it('formats periods and dates the British way', () => {
    expect(periodLabel('2026-03')).toBe('March 2026');
    expect(formatDate('2026-04-01')).toBe('1 Apr 2026');
    expect(formatDate(null)).toBe('—');
  });
});
