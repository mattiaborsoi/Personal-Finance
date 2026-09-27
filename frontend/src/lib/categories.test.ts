import { describe, expect, it } from 'vitest';
import { categories } from '../test/fixtures';
import { categoryGroup, categoryLeaf, groupRuns, inUseTitle, isProtectedCategory, moveItem, usageText } from './categories';

const unused = { transactions: 0, memory: 0, rules: 0 };

describe('category helpers', () => {
  it('splits a name at its first colon into group and leaf', () => {
    expect(categoryGroup('Bills:Water')).toBe('Bills');
    expect(categoryLeaf('Bills:Water')).toBe('Water');
    expect(categoryLeaf('Transport:Taxi:Night')).toBe('Taxi:Night');
    expect(categoryGroup('Groceries')).toBe('Groceries');
    expect(categoryLeaf('Groceries')).toBe('Groceries');
    // A leading colon is not a group.
    expect(categoryGroup(':Odd')).toBe(':Odd');
  });

  it('groups consecutive names only, so the menu order is never rearranged', () => {
    const runs = groupRuns(categories().categories);
    expect(runs.map((r) => [r.group, r.grouped, r.items.map((i) => i.index)])).toEqual([
      ['Bills', true, [0, 1]],
      ['Groceries', false, [2]],
      ['Dining', false, [3]],
      ['Transport', true, [4]],
      ['Uncategorized', false, [5]],
    ]);
    const split = groupRuns(
      ['Bills:Water', 'Groceries', 'Bills:Energy'].map((name) => ({ name, in_use: unused })),
    );
    expect(split.map((r) => r.group)).toEqual(['Bills', 'Groceries', 'Bills']);
  });

  it('says what uses a category, or that nothing does', () => {
    expect(usageText({ transactions: 12, memory: 3, rules: 1 })).toBe('12 transactions · 3 merchants · 1 rule');
    expect(usageText({ transactions: 1, memory: 0, rules: 2 })).toBe('1 transaction · 2 rules');
    expect(usageText(unused)).toBe('unused');
    expect(inUseTitle({ transactions: 0, memory: 1, rules: 0 })).toBe('Still in use (1 merchant); move those to another category first.');
  });

  it('protects Uncategorized only', () => {
    expect(isProtectedCategory('Uncategorized')).toBe(true);
    expect(isProtectedCategory('Dining')).toBe(false);
  });

  it('moves an item, and leaves the list alone for a move off either end', () => {
    const list = ['a', 'b', 'c'];
    expect(moveItem(list, 2, 1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(list, 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(list, 0, -1)).toBe(list);
    expect(moveItem(list, 2, 3)).toBe(list);
    expect(list).toEqual(['a', 'b', 'c']);
  });
});
