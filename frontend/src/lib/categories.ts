import { UNCATEGORIZED, type CategoryOut, type CategoryUsage } from '../api';
import { categoryLabel, plural } from './format';

/** "Bills:Water" -> "Bills"; a bare name such as "Groceries" is its own group. */
export function categoryGroup(name: string): string {
  const colon = name.indexOf(':');
  return colon > 0 ? name.slice(0, colon) : name;
}

/** "Bills:Water" -> "Water"; a bare name is returned whole. */
export function categoryLeaf(name: string): string {
  const colon = name.indexOf(':');
  return colon > 0 ? name.slice(colon + 1) : name;
}

/** True for "Group:Name"; false for a bare name. */
export function isGrouped(name: string): boolean {
  return name.indexOf(':') > 0;
}

export interface CategoryRun {
  group: string;
  /** Some member is a "Group:Name", so the run deserves a heading; a lone bare name does not. */
  grouped: boolean;
  /** Each with its index in the flat list, which is the order the menus show. */
  items: Array<{ category: CategoryOut; index: number }>;
}

/**
 * Consecutive categories with the same group, in the list's own order. The
 * flat order is what the menus show, so a group split by a stray entry shows
 * twice rather than being silently reordered on screen.
 */
export function groupRuns(list: CategoryOut[]): CategoryRun[] {
  const runs: CategoryRun[] = [];
  list.forEach((category, index) => {
    const group = categoryGroup(category.name);
    const last = runs[runs.length - 1];
    if (last && last.group === group) {
      last.items.push({ category, index });
      last.grouped = last.grouped || isGrouped(category.name);
    } else {
      runs.push({ group, grouped: isGrouped(category.name), items: [{ category, index }] });
    }
  });
  return runs;
}

export const UNUSED_TEXT = 'unused';

export function isInUse(usage: CategoryUsage): boolean {
  return usage.transactions > 0 || usage.memory > 0 || usage.rules > 0;
}

/** "12 transactions · 3 merchants · 1 rule"; "unused" when nothing references it. */
export function usageText(usage: CategoryUsage): string {
  const parts: string[] = [];
  if (usage.transactions > 0) parts.push(plural(usage.transactions, 'transaction'));
  if (usage.memory > 0) parts.push(plural(usage.memory, 'merchant'));
  if (usage.rules > 0) parts.push(plural(usage.rules, 'rule'));
  return parts.length > 0 ? parts.join(' · ') : UNUSED_TEXT;
}

/** Why a category cannot be removed, for the disabled button's tooltip. */
export function inUseTitle(usage: CategoryUsage): string {
  return `Still in use (${usageText(usage)}); move those to another category first.`;
}

/** `UNCATEGORIZED` can be neither renamed nor removed: lines nothing classifies land there. */
export function isProtectedCategory(name: string): boolean {
  return name === UNCATEGORIZED;
}

/** The list with the item at `from` moved to `to`; unchanged when either is out of range. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= list.length || to >= list.length || from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

// ---------------------------------------------------------------------------
// Emojis
// ---------------------------------------------------------------------------

/** Per-group emojis as the config and the settings API carry them; absent or "" means none. */
export type CategoryEmojis = Record<string, string> | undefined;

/** The emoji of the category's group ("🏠" for "Housing:Mortgage"), or "" when it has none. */
export function categoryEmoji(name: string, emojis: CategoryEmojis): string {
  return emojis?.[categoryGroup(name)]?.trim() ?? '';
}

/** A group's name on screen: the group as it is, "Uncategorized" the British way. */
export function groupLabel(group: string): string {
  return categoryLabel(group);
}

/** "🏠 Housing › Mortgage", "🛒 Groceries", or the plain label when the group has no emoji. */
export function categoryEmojiLabel(name: string, emojis: CategoryEmojis): string {
  const emoji = categoryEmoji(name, emojis);
  const label = categoryLabel(name);
  return emoji ? `${emoji} ${label}` : label;
}

// ---------------------------------------------------------------------------
// Searching the category picker
// ---------------------------------------------------------------------------

/** Lower case, with ":", "›", ">" and "/" read as spaces, so "Bills:Water", "bills › water" and "bills water" compare equal. */
export function normalizeCategoryText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[:›>/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The categories that match what was typed, best first: names that start with
 * it, then names whose leaf does, then names where every word typed starts a
 * word ("hou mor" is Housing › Mortgage), then any that merely contain each
 * word. Ties keep the list's own order. An empty query matches everything.
 */
export function searchCategories(options: string[], query: string): string[] {
  const q = normalizeCategoryText(query);
  if (!q) return [...options];
  const tokens = q.split(' ');
  const scored: Array<{ name: string; score: number; index: number }> = [];
  options.forEach((name, index) => {
    // The raw name and the label both count, so "uncategorised" finds "Uncategorized".
    const texts = [normalizeCategoryText(name), normalizeCategoryText(categoryLabel(name))];
    const words = texts.flatMap((t) => t.split(' '));
    const leaf = normalizeCategoryText(categoryLeaf(name));
    let score = -1;
    if (texts.some((t) => t.startsWith(q))) score = 0;
    else if (leaf.startsWith(q)) score = 1;
    else if (tokens.every((t) => words.some((w) => w.startsWith(t)))) score = 2;
    else if (tokens.every((t) => texts.some((text) => text.includes(t)))) score = 3;
    if (score >= 0) scored.push({ name, score, index });
  });
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((s) => s.name);
}

/** True when what was typed already names a category exactly, ignoring case and separators. */
export function isExactCategory(options: string[], query: string): boolean {
  const q = normalizeCategoryText(query);
  return options.some((name) => normalizeCategoryText(name) === q || normalizeCategoryText(categoryLabel(name)) === q);
}

export interface NewCategoryOption {
  /** The name to add, "Dining:Takeaway" or "Takeaway". */
  name: string;
  /** "Add “Takeaway” under Dining". */
  label: string;
}

/**
 * What the picker offers to add for the text typed, when nothing matches it
 * exactly. "Dining:Takeaway" or "Dining › Takeaway" adds under Dining (spelt as
 * the existing group is); a bare "Takeaway" adds it ungrouped, plus "under X"
 * for up to two groups among the best matches (`results`), skipping a group
 * the text is just the start of ("Din" is not a new Dining item).
 */
export function newCategoryOptions(options: string[], query: string, results: string[]): NewCategoryOption[] {
  const raw = query.trim().replace(/\s+/g, ' ');
  if (!raw || isExactCategory(options, raw)) return [];
  const groups = Array.from(new Set(options.filter(isGrouped).map(categoryGroup)));
  const canonicalGroup = (group: string) => groups.find((g) => g.toLowerCase() === group.toLowerCase()) ?? group;
  const exists = (name: string) => options.some((o) => o.toLowerCase() === name.toLowerCase());

  const split = raw.match(/^(.*?)\s*[:›>]\s*(.*)$/);
  if (split) {
    const group = split[1].trim();
    const leaf = split[2].trim();
    if (!leaf) return [];
    if (!group) return exists(leaf) ? [] : [{ name: leaf, label: `Add “${leaf}”` }];
    const name = `${canonicalGroup(group)}:${leaf}`;
    return exists(name) ? [] : [{ name, label: `Add “${leaf}” under ${canonicalGroup(group)}` }];
  }

  // A group's own name ("bills") is a search for its members, not a new bare category beside them.
  const isGroup = groups.some((g) => g.toLowerCase() === raw.toLowerCase());
  const offers: NewCategoryOption[] = exists(raw) || isGroup ? [] : [{ name: raw, label: `Add “${raw}”` }];
  const q = normalizeCategoryText(raw);
  const nearby = Array.from(new Set(results.filter(isGrouped).map(categoryGroup)))
    .filter((g) => !normalizeCategoryText(g).startsWith(q))
    .slice(0, 2);
  for (const group of nearby) {
    const name = `${group}:${raw}`;
    if (!exists(name)) offers.push({ name, label: `Add “${raw}” under ${group}` });
  }
  return offers;
}

/**
 * The list with `name` added where the menus will show it with its kin: after
 * the last member of its group, otherwise before a trailing "Uncategorized", or at the end.
 */
export function insertCategory(list: string[], name: string): string[] {
  const next = [...list];
  if (isGrouped(name)) {
    const group = categoryGroup(name);
    let last = -1;
    next.forEach((n, i) => {
      if (categoryGroup(n) === group) last = i;
    });
    if (last >= 0) {
      next.splice(last + 1, 0, name);
      return next;
    }
  }
  if (next[next.length - 1] === UNCATEGORIZED) next.splice(next.length - 1, 0, name);
  else next.push(name);
  return next;
}

export interface CategoryMenuGroup {
  /** "🏠 Housing" for a group's heading; null for a run of bare names, listed on their own. */
  heading: string | null;
  options: Array<{ value: string; text: string }>;
}

/**
 * A category menu in sections: each group once (its members gathered in list
 * order) under "emoji Group" with the plain leaf names; bare names on their
 * own with their emoji; "Uncategorized" last.
 */
export function categoryMenuGroups(list: string[], emojis: CategoryEmojis): CategoryMenuGroup[] {
  const out: CategoryMenuGroup[] = [];
  const groups = new Map<string, CategoryMenuGroup>();
  let loose: CategoryMenuGroup | null = null;
  for (const value of list) {
    if (value === UNCATEGORIZED) continue;
    if (isGrouped(value)) {
      const group = categoryGroup(value);
      let section = groups.get(group);
      if (!section) {
        const emoji = categoryEmoji(value, emojis);
        section = { heading: emoji ? `${emoji} ${group}` : group, options: [] };
        groups.set(group, section);
        out.push(section);
        loose = null;
      }
      section.options.push({ value, text: categoryLeaf(value) });
    } else {
      if (!loose) {
        loose = { heading: null, options: [] };
        out.push(loose);
      }
      loose.options.push({ value, text: categoryEmojiLabel(value, emojis) });
    }
  }
  if (list.includes(UNCATEGORIZED)) out.push({ heading: null, options: [{ value: UNCATEGORIZED, text: categoryLabel(UNCATEGORIZED) }] });
  return out;
}
