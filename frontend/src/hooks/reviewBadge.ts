import { createContext, useContext, useEffect } from 'react';
import type { PeriodOut } from '../api';

interface ReviewBadgeSync {
  /** Hands over a list of periods a page has just loaded, so the badge follows without a request of its own. */
  share: (periods: PeriodOut[]) => void;
  /** Asks GET /api/periods once, after something that changes what is pending (an upload, a delete, a reset). */
  refresh: () => void;
}

/**
 * Keeps the navigation's Review badge current without polling. Provided by
 * `<Layout>`; outside it, e.g. in a test of one page, both do nothing.
 */
export const ReviewBadgeContext = createContext<ReviewBadgeSync>({ share: () => {}, refresh: () => {} });

/** Passes each new list of periods a page loads on to the Review badge. */
export function useSharePeriods(periods: PeriodOut[] | null): void {
  const { share } = useContext(ReviewBadgeContext);
  useEffect(() => {
    if (periods) share(periods);
  }, [periods, share]);
}

/** Re-counts the Review badge (one request). */
export function useRefreshReviewBadge(): () => void {
  return useContext(ReviewBadgeContext).refresh;
}
