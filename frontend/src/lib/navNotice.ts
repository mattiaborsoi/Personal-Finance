/**
 * A confirmation carried to the next page in the router's location state, for an
 * action that ends somewhere else (a reset lands on the dashboard):
 * `navigate('/', { state: noticeState('…') })`.
 */
export interface NoticeState {
  notice: string;
}

export function noticeState(notice: string): NoticeState {
  return { notice };
}

/** The notice in `location.state`, or null when there is none. */
export function readNotice(state: unknown): string | null {
  if (state && typeof state === 'object' && typeof (state as { notice?: unknown }).notice === 'string') {
    return (state as NoticeState).notice;
  }
  return null;
}
