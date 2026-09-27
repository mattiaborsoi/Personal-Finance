import type { PeriodOut } from '../api';
import { defaultPeriodKey, isPeriodKey, monthsPhrase } from './dates';
import { plural } from './format';

/** The Review page on `period` (`/review?period=2026-07`), or on its default period when there is none. */
export function reviewPath(period?: string | null): string {
  return period && isPeriodKey(period) ? `/review?period=${encodeURIComponent(period)}` : '/review';
}

export interface PendingMonth {
  period: string;
  count: number;
  closed: boolean;
}

/** The months with lines waiting for review, oldest first. */
export function pendingMonths(periods: ReadonlyArray<PeriodOut> | null): PendingMonth[] {
  if (!periods) return [];
  return periods
    .filter((p) => p.pending_review_count > 0 && isPeriodKey(p.period_key))
    .map((p) => ({ period: p.period_key, count: p.pending_review_count, closed: p.is_closed }))
    // Period keys are zero-padded YYYY-MM, so string order is chronological order.
    .sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
}

/** Lines waiting for review across every month. */
export function totalPending(periods: ReadonlyArray<PeriodOut> | null): number {
  return pendingMonths(periods).reduce((sum, m) => sum + m.count, 0);
}

/**
 * Which period the Review page opens on without `?period=`: the oldest open
 * month with lines waiting (then the oldest closed one), otherwise the usual
 * default (`defaultPeriodKey`). Null when nothing is listed.
 */
export function reviewDefaultPeriod(periods: ReadonlyArray<PeriodOut>, now: Date = new Date()): string | null {
  const pending = pendingMonths(periods);
  const first = pending.find((m) => !m.closed) ?? pending[0];
  return first ? first.period : defaultPeriodKey(periods, now);
}

/** "8 lines waiting for review in July and August"; "" when nothing waits. */
export function pendingSummary(periods: ReadonlyArray<PeriodOut> | null, now: Date = new Date()): string {
  const months = pendingMonths(periods);
  if (months.length === 0) return '';
  const total = months.reduce((sum, m) => sum + m.count, 0);
  return `${plural(total, 'line')} waiting for review in ${monthsPhrase(
    months.map((m) => m.period),
    now,
  )}`;
}

export interface ReviewBadge {
  /** The period the Review link opens on: `requested` when it is a period key, else null (the page's default). */
  period: string | null;
  /** Lines waiting for review across every month; 0 while the periods are unknown. */
  count: number;
  /** The months those lines are in, oldest first. */
  months: string[];
}

/** What the navigation's Review link opens on, and how many lines wait for review in all. */
export function reviewBadge(periods: ReadonlyArray<PeriodOut> | null, requested: string | null): ReviewBadge {
  const months = pendingMonths(periods);
  return {
    period: requested && isPeriodKey(requested) ? requested : null,
    count: months.reduce((sum, m) => sum + m.count, 0),
    months: months.map((m) => m.period),
  };
}
