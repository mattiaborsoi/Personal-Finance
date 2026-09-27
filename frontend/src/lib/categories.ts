import { UNCATEGORIZED, type CategoryOut, type CategoryUsage } from '../api';
import { plural } from './format';

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
