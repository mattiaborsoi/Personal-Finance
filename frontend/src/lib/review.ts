import type { PeriodOut } from '../api';
import { defaultPeriodKey, isPeriodKey } from './dates';

/** The Review page on `period` (`/review?period=2026-07`), or on its default period when there is none. */
export function reviewPath(period?: string | null): string {
  return period && isPeriodKey(period) ? `/review?period=${encodeURIComponent(period)}` : '/review';
}

export interface ReviewBadge {
  /** The period counted: `requested` when it is a period key, else the Review page's default; null while unknown. */
  period: string | null;
  /** Lines waiting for review in it; 0 while the periods are unknown. */
  count: number;
}

/** What the navigation's Review link opens on, and how many lines wait there. */
export function reviewBadge(periods: ReadonlyArray<PeriodOut> | null, requested: string | null): ReviewBadge {
  const period = requested && isPeriodKey(requested) ? requested : periods ? defaultPeriodKey(periods) : null;
  const count = periods?.find((p) => p.period_key === period)?.pending_review_count ?? 0;
  return { period, count };
}
