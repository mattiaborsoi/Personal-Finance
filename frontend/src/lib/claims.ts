import { monthsAgoIso, todayIso } from './dates';

export const FUTURE_DATE_MESSAGE = 'The claim date cannot be in the future.';
export const MISSING_DATE_MESSAGE = 'Choose a date.';
export const TOO_OLD_DATE_MESSAGE = 'The claim date cannot be more than 12 months ago.';

/** How far back a claim may be dated; the backend refuses anything older with 422. */
export const CLAIM_LOOKBACK_MONTHS = 12;

/** The earliest date a claim may carry today (YYYY-MM-DD). */
export function earliestClaimDate(now: Date = new Date()): string {
  return monthsAgoIso(CLAIM_LOOKBACK_MONTHS, now);
}

/**
 * Null when the date is usable for a claim; a message otherwise. The backend
 * rejects future dates and dates more than 12 months old with 422, so both
 * are checked before submitting. Dates are YYYY-MM-DD, so string order is
 * date order.
 */
export function claimDateProblem(
  isoDate: string,
  today: string = todayIso(),
  earliest: string = earliestClaimDate(),
): string | null {
  if (!isoDate) return MISSING_DATE_MESSAGE;
  if (isoDate > today) return FUTURE_DATE_MESSAGE;
  if (isoDate < earliest) return TOO_OLD_DATE_MESSAGE;
  return null;
}

/** Whether a form-level message is one of the date complaints above. */
export function isDateProblem(message: string | null): boolean {
  return message === FUTURE_DATE_MESSAGE || message === MISSING_DATE_MESSAGE || message === TOO_OLD_DATE_MESSAGE;
}

/** The amount above which the claim form asks for confirmation before logging. */
export const LARGE_CLAIM_THRESHOLD = 1000;

/** True when a claim of this size deserves a "Log it?" check before it is sent. */
export function isLargeClaim(normalisedAmount: string): boolean {
  return Number(normalisedAmount) > LARGE_CLAIM_THRESHOLD;
}
