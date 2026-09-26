import { todayIso } from './dates';

export const FUTURE_DATE_MESSAGE = 'The claim date cannot be in the future.';
export const MISSING_DATE_MESSAGE = 'Choose a date.';

/**
 * Null when the date is usable for a claim; a message otherwise. The backend
 * rejects future dates with 422, so this is checked before submitting.
 * Dates are YYYY-MM-DD, so string order is date order.
 */
export function claimDateProblem(isoDate: string, today: string = todayIso()): string | null {
  if (!isoDate) return MISSING_DATE_MESSAGE;
  if (isoDate > today) return FUTURE_DATE_MESSAGE;
  return null;
}

/** Whether a form-level message is one of the date complaints above. */
export function isDateProblem(message: string | null): boolean {
  return message === FUTURE_DATE_MESSAGE || message === MISSING_DATE_MESSAGE;
}
