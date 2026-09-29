const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local date as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Local month as YYYY-MM. */
export function currentPeriodKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

export const PERIOD_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isPeriodKey(value: string): boolean {
  return PERIOD_KEY_PATTERN.test(value);
}

/** "2026-03-07" -> "2026-03"; the current month when the date is not YYYY-MM-DD. */
export function periodKeyForDate(iso: string | null | undefined, now: Date = new Date()): string {
  const key = iso ? iso.slice(0, 7) : '';
  return isPeriodKey(key) ? key : currentPeriodKey(now);
}

/**
 * Which period a page should open on: the current month when it is on
 * record, otherwise the newest period that is not in the future, otherwise
 * the first listed one. Null when nothing is listed.
 */
export function defaultPeriodKey(periods: ReadonlyArray<{ period_key: string }>, now: Date = new Date()): string | null {
  if (periods.length === 0) return null;
  const current = currentPeriodKey(now);
  const keys = periods.map((p) => p.period_key);
  if (keys.includes(current)) return current;
  // Period keys are zero-padded YYYY-MM, so string order is chronological order.
  const past = keys.filter((k) => isPeriodKey(k) && k < current).sort();
  return past.length > 0 ? past[past.length - 1] : keys[0];
}

/** "2026-03" -> "March 2026". Falls back to the input when it is not a period key. */
export function periodLabel(periodKey: string): string {
  if (!isPeriodKey(periodKey)) return periodKey;
  const [year, month] = periodKey.split('-');
  return `${MONTHS[Number(month) - 1]} ${year}`;
}

/** "2026-07" -> "July" in the year of `now`, "July 2025" in any other year. */
export function monthName(periodKey: string, now: Date = new Date()): string {
  if (!isPeriodKey(periodKey)) return periodKey;
  const [year, month] = periodKey.split('-');
  return Number(year) === now.getFullYear() ? MONTHS[Number(month) - 1] : periodLabel(periodKey);
}

/** ["a", "b", "c"] -> "a, b and c"; one item alone, "" for none. */
export function joinWithAnd(items: ReadonlyArray<string>): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** ["2026-08", "2026-07"] -> "July and August": the months in order, named with `monthName`. */
export function monthsPhrase(periodKeys: ReadonlyArray<string>, now: Date = new Date()): string {
  return joinWithAnd([...periodKeys].sort().map((k) => monthName(k, now)));
}

/**
 * The months a statement covers: "May–Jul 2026" when `from` and `to` differ
 * ("Nov 2025–Jan 2026" across a year end), otherwise the one month spelt out
 * ("July 2026"), falling back to `periodKey` when either end is unknown.
 */
export function periodRangeLabel(from: string | null | undefined, to: string | null | undefined, periodKey: string): string {
  if (!from || !to || !isPeriodKey(from) || !isPeriodKey(to)) return periodLabel(periodKey);
  if (from === to) return periodLabel(from);
  // Period keys are zero-padded YYYY-MM, so string order is chronological order.
  const [lo, hi] = from < to ? [from, to] : [to, from];
  const [loYear, loMonth] = lo.split('-');
  const [hiYear, hiMonth] = hi.split('-');
  const short = (month: string) => MONTHS[Number(month) - 1].slice(0, 3);
  if (loYear === hiYear) return `${short(loMonth)}–${short(hiMonth)} ${loYear}`;
  return `${short(loMonth)} ${loYear}–${short(hiMonth)} ${hiYear}`;
}

/**
 * The local date `months` months before `now`, as YYYY-MM-DD. The day is kept
 * where the target month has it, otherwise clamped to that month's last day
 * (29 Feb -> 28 Feb).
 */
export function monthsAgoIso(months: number, now: Date = new Date()): string {
  const target = new Date(now.getFullYear(), now.getMonth() - months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(now.getDate(), lastDay));
  return todayIso(target);
}

/** "2026-03" -> "Mar 26" for compact chart axes. */
export function periodShortLabel(periodKey: string): string {
  if (!isPeriodKey(periodKey)) return periodKey;
  const [year, month] = periodKey.split('-');
  return `${MONTHS[Number(month) - 1].slice(0, 3)} ${year.slice(2)}`;
}

/** "2026-03-07" -> "7 Mar 2026". Unknown formats are returned unchanged. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const [, year, month, day] = match;
  return `${Number(day)} ${MONTHS[Number(month) - 1].slice(0, 3)} ${year}`;
}

/** "2026-03-07T10:15:00Z" -> "7 Mar 2026, 10:15". */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "just now", "5 minutes ago", "6 hours ago", "3 days ago"; older than 30 days, the date. */
export function timeAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (minutes < 60) return unit(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days <= 30) return unit(days, 'day');
  return `on ${formatDate(iso)}`;
}
