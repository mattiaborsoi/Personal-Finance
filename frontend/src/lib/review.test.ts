import { describe, expect, it } from 'vitest';
import type { PeriodOut } from '../api';
import { period } from '../test/fixtures';
import { pendingMonths, pendingSummary, reviewBadge, reviewDefaultPeriod, reviewPath, totalPending } from './review';

const september = new Date(2026, 8, 25); // local time, so no timezone surprises

function months(pending: Record<string, number>, closed: string[] = []): PeriodOut[] {
  return Object.entries(pending).map(([period_key, pending_review_count]) =>
    period({ period_key, pending_review_count, is_closed: closed.includes(period_key) }),
  );
}

describe('the Review page default', () => {
  it('opens on the oldest month with lines waiting, not the current one, when only older months have any', () => {
    // The browser review: September exists (a claim was logged in it) but the lines wait in July and August.
    const periods = months({ '2026-09': 0, '2026-08': 5, '2026-07': 3 });
    expect(reviewDefaultPeriod(periods, september)).toBe('2026-07');
  });

  it('still picks the oldest when the current month has lines waiting too', () => {
    expect(reviewDefaultPeriod(months({ '2026-09': 2, '2026-08': 1 }), september)).toBe('2026-08');
    expect(reviewDefaultPeriod(months({ '2026-09': 2, '2026-08': 0 }), september)).toBe('2026-09');
  });

  it('skips closed months while an open one has lines waiting, and uses them when none does', () => {
    expect(reviewDefaultPeriod(months({ '2026-08': 4, '2026-07': 3 }, ['2026-07']), september)).toBe('2026-08');
    expect(reviewDefaultPeriod(months({ '2026-09': 0, '2026-07': 3 }, ['2026-07']), september)).toBe('2026-07');
  });

  it('falls back to the usual default when nothing is waiting', () => {
    expect(reviewDefaultPeriod(months({ '2026-09': 0, '2026-08': 0 }), september)).toBe('2026-09');
    expect(reviewDefaultPeriod([], september)).toBeNull();
  });
});

describe('pending counts', () => {
  it('lists the months with lines waiting, oldest first, and adds them up', () => {
    const periods = months({ '2026-09': 0, '2026-08': 5, '2026-07': 3 });
    expect(pendingMonths(periods).map((m) => [m.period, m.count])).toEqual([
      ['2026-07', 3],
      ['2026-08', 5],
    ]);
    expect(totalPending(periods)).toBe(8);
    expect(totalPending(null)).toBe(0);
  });

  it('says how many lines wait and in which months', () => {
    expect(pendingSummary(months({ '2026-09': 0, '2026-08': 5, '2026-07': 3 }), september)).toBe(
      '8 lines waiting for review in July and August',
    );
    expect(pendingSummary(months({ '2026-09': 1 }), september)).toBe('1 line waiting for review in September');
    expect(pendingSummary(months({ '2026-09': 0 }), september)).toBe('');
  });
});

describe('reviewBadge', () => {
  it('counts every month, whatever period is requested', () => {
    const periods = months({ '2026-09': 0, '2026-08': 5, '2026-07': 3 });
    expect(reviewBadge(periods, null)).toEqual({ period: null, count: 8, months: ['2026-07', '2026-08'] });
    expect(reviewBadge(periods, '2026-09')).toEqual({ period: '2026-09', count: 8, months: ['2026-07', '2026-08'] });
    expect(reviewBadge(periods, 'nonsense').period).toBeNull();
  });

  it('is zero with nothing waiting or before the periods arrive', () => {
    expect(reviewBadge(months({ '2026-09': 0 }), null).count).toBe(0);
    expect(reviewBadge(null, '2026-07')).toEqual({ period: '2026-07', count: 0, months: [] });
  });

  it('links to the requested period only when it is one', () => {
    expect(reviewPath('2026-07')).toBe('/review?period=2026-07');
    expect(reviewPath(null)).toBe('/review');
  });
});
