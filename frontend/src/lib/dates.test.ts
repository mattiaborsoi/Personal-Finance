import { describe, expect, it } from 'vitest';
import {
  FUTURE_DATE_MESSAGE,
  MISSING_DATE_MESSAGE,
  TOO_OLD_DATE_MESSAGE,
  claimDateProblem,
  earliestClaimDate,
  isDateProblem,
  isLargeClaim,
} from './claims';
import {
  currentPeriodKey,
  defaultPeriodKey,
  formatDate,
  joinWithAnd,
  monthName,
  monthsAgoIso,
  monthsPhrase,
  periodKeyForDate,
  periodLabel,
  periodRangeLabel,
} from './dates';

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

describe('monthsAgoIso', () => {
  it('keeps the day when the target month has it and clamps to the month end otherwise', () => {
    expect(monthsAgoIso(12, september)).toBe('2025-09-25');
    expect(monthsAgoIso(12, new Date(2024, 1, 29))).toBe('2023-02-28');
    expect(monthsAgoIso(1, new Date(2026, 2, 31))).toBe('2026-02-28');
    expect(monthsAgoIso(3, new Date(2026, 0, 15))).toBe('2025-10-15');
    expect(earliestClaimDate(september)).toBe('2025-09-25');
  });
});

describe('claimDateProblem', () => {
  it('rejects dates after today and blanks, accepts today and the past', () => {
    expect(claimDateProblem('2026-09-26', '2026-09-25', '2025-09-25')).toBe(FUTURE_DATE_MESSAGE);
    expect(claimDateProblem('2027-01-01', '2026-09-25', '2025-09-25')).toBe(FUTURE_DATE_MESSAGE);
    expect(claimDateProblem('2026-09-25', '2026-09-25', '2025-09-25')).toBeNull();
    expect(claimDateProblem('2026-03-05', '2026-09-25', '2025-09-25')).toBeNull();
    expect(claimDateProblem('', '2026-09-25', '2025-09-25')).toBe(MISSING_DATE_MESSAGE);
    expect(isDateProblem(FUTURE_DATE_MESSAGE)).toBe(true);
    expect(isDateProblem('Enter an amount greater than zero.')).toBe(false);
    expect(isDateProblem(null)).toBe(false);
  });

  it('rejects dates more than 12 months old, accepting exactly 12 months', () => {
    expect(claimDateProblem('2025-09-24', '2026-09-25', '2025-09-25')).toBe(TOO_OLD_DATE_MESSAGE);
    expect(claimDateProblem('2020-01-01', '2026-09-25', '2025-09-25')).toBe(TOO_OLD_DATE_MESSAGE);
    expect(claimDateProblem('2025-09-25', '2026-09-25', '2025-09-25')).toBeNull();
    expect(isDateProblem(TOO_OLD_DATE_MESSAGE)).toBe(true);
  });
});

describe('isLargeClaim', () => {
  it('asks for confirmation strictly above £1,000', () => {
    expect(isLargeClaim('1000.00')).toBe(false);
    expect(isLargeClaim('1000.01')).toBe(true);
    expect(isLargeClaim('99999999.00')).toBe(true);
    expect(isLargeClaim('12.50')).toBe(false);
  });
});

describe('labels', () => {
  it('formats periods and dates the British way', () => {
    expect(periodLabel('2026-03')).toBe('March 2026');
    expect(formatDate('2026-04-01')).toBe('1 Apr 2026');
    expect(formatDate(null)).toBe('—');
  });

  it('spans the months a statement covers, or names the one month in full', () => {
    expect(periodRangeLabel('2026-05', '2026-07', '2026-07')).toBe('May–Jul 2026');
    expect(periodRangeLabel('2025-11', '2026-01', '2026-01')).toBe('Nov 2025–Jan 2026');
    expect(periodRangeLabel('2026-07', '2026-05', '2026-07')).toBe('May–Jul 2026');
    expect(periodRangeLabel('2026-07', '2026-07', '2026-07')).toBe('July 2026');
    expect(periodRangeLabel(null, null, '2026-07')).toBe('July 2026');
    expect(periodRangeLabel('2026-07', null, '2026-06')).toBe('June 2026');
    expect(periodRangeLabel('bad', '2026-07', '2026-06')).toBe('June 2026');
  });
});

describe('month names in sentences', () => {
  it('drops the year for the current one and keeps it otherwise', () => {
    expect(monthName('2026-07', september)).toBe('July');
    expect(monthName('2025-12', september)).toBe('December 2025');
    expect(monthName('bad', september)).toBe('bad');
  });

  it('joins with commas and a final "and", no Oxford comma', () => {
    expect(joinWithAnd([])).toBe('');
    expect(joinWithAnd(['July'])).toBe('July');
    expect(joinWithAnd(['July', 'August'])).toBe('July and August');
    expect(joinWithAnd(['June', 'July', 'August'])).toBe('June, July and August');
  });

  it('lists months in calendar order whatever order they come in', () => {
    expect(monthsPhrase(['2026-08', '2026-07'], september)).toBe('July and August');
    expect(monthsPhrase(['2026-01', '2025-12'], september)).toBe('December 2025 and January');
  });
});
