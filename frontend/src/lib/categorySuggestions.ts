import { api, type CategorySuggestions } from '../api';

/** How many categories each list of shortcuts asks for. */
export const SUGGESTION_LIMIT = 3;

const cache = new Map<string, Promise<CategorySuggestions | null>>();

/**
 * The merchant's past categories and the most used ones, fetched once per
 * merchant for the session. A failure (or a server without the endpoint) just
 * means no shortcuts, and is not retried until the page reloads.
 */
export function loadSuggestions(merchant: string): Promise<CategorySuggestions | null> {
  let pending = cache.get(merchant);
  if (!pending) {
    pending = api.getCategorySuggestions(merchant, SUGGESTION_LIMIT).catch(() => null);
    cache.set(merchant, pending);
  }
  return pending;
}

/** Forgets every merchant's suggestions (between tests). */
export function resetCategorySuggestions(): void {
  cache.clear();
}
