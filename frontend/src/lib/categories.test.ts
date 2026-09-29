import { describe, expect, it } from 'vitest';
import { categories } from '../test/fixtures';
import {
  categoryEmoji,
  categoryEmojiLabel,
  categoryGroup,
  categoryLeaf,
  categoryMenuGroups,
  groupRuns,
  insertCategory,
  inUseTitle,
  isExactCategory,
  isProtectedCategory,
  moveItem,
  newCategoryOptions,
  searchCategories,
  usageText,
} from './categories';

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

const LIST = [
  'Housing:Mortgage',
  'Housing:Council tax',
  'Bills:Water',
  'Bills:Energy',
  'Bills:Broadband',
  'Groceries',
  'Dining',
  'Transport:Taxi',
  'Uncategorized',
];
const EMOJIS = { Housing: '🏠', Groceries: '🛒', Bills: '' };

describe('category emojis', () => {
  it('takes the emoji of the group, and none for a group without one', () => {
    expect(categoryEmoji('Housing:Mortgage', EMOJIS)).toBe('🏠');
    expect(categoryEmoji('Groceries', EMOJIS)).toBe('🛒');
    expect(categoryEmoji('Bills:Water', EMOJIS)).toBe('');
    expect(categoryEmoji('Dining', undefined)).toBe('');
  });

  it('puts the emoji before the label', () => {
    expect(categoryEmojiLabel('Housing:Mortgage', EMOJIS)).toBe('🏠 Housing › Mortgage');
    expect(categoryEmojiLabel('Groceries', EMOJIS)).toBe('🛒 Groceries');
    expect(categoryEmojiLabel('Bills:Water', EMOJIS)).toBe('Bills › Water');
    expect(categoryEmojiLabel('Uncategorized', EMOJIS)).toBe('Uncategorised');
  });

  it('builds a menu with one section per group, bare names on their own and Uncategorised last', () => {
    const menu = categoryMenuGroups(['Uncategorized', 'Housing:Mortgage', 'Groceries', 'Dining', 'Housing:Rent'], EMOJIS);
    expect(menu).toEqual([
      { heading: '🏠 Housing', options: [{ value: 'Housing:Mortgage', text: 'Mortgage' }, { value: 'Housing:Rent', text: 'Rent' }] },
      { heading: null, options: [{ value: 'Groceries', text: '🛒 Groceries' }, { value: 'Dining', text: 'Dining' }] },
      { heading: null, options: [{ value: 'Uncategorized', text: 'Uncategorised' }] },
    ]);
  });
});

describe('searchCategories', () => {
  it('lists every member of a group typed by name', () => {
    expect(searchCategories(LIST, 'bills')).toEqual(['Bills:Water', 'Bills:Energy', 'Bills:Broadband']);
  });

  it('finds a bare name from its start, whatever the case', () => {
    expect(searchCategories(LIST, 'GRO')).toEqual(['Groceries']);
  });

  it('matches the start of each word typed, across group and name', () => {
    expect(searchCategories(LIST, 'hou mor')).toEqual(['Housing:Mortgage']);
    expect(searchCategories(LIST, 'housing › mort')).toEqual(['Housing:Mortgage']);
    expect(searchCategories(LIST, 'Housing:Mortgage')).toEqual(['Housing:Mortgage']);
  });

  it('ranks names that start with the text before names that only contain it', () => {
    // "tax": Council tax only has a word starting with it, so the leaf match (Taxi) comes first although it is later in the list.
    expect(searchCategories(LIST, 'tax')).toEqual(['Transport:Taxi', 'Housing:Council tax']);
    // "er" starts nothing, so plain containment in list order.
    expect(searchCategories(LIST, 'er')).toEqual(['Bills:Water', 'Bills:Energy', 'Groceries']);
    // A name that starts with the text beats one whose leaf does.
    expect(searchCategories(['Food:Bread', 'Bakery:Buns', 'Bread'], 'bre')).toEqual(['Bread', 'Food:Bread']);
  });

  it('finds Uncategorised by either spelling, and everything for an empty query', () => {
    expect(searchCategories(LIST, 'uncategorised')).toEqual(['Uncategorized']);
    expect(searchCategories(LIST, 'uncategorized')).toEqual(['Uncategorized']);
    expect(searchCategories(LIST, '  ')).toEqual(LIST);
  });
});

describe('adding from the picker', () => {
  it('knows an exact name whatever the separator or case', () => {
    expect(isExactCategory(LIST, 'bills › water')).toBe(true);
    expect(isExactCategory(LIST, 'Bills water')).toBe(true);
    expect(isExactCategory(LIST, 'Uncategorised')).toBe(true);
    expect(isExactCategory(LIST, 'Water')).toBe(false);
  });

  it('adds under the group typed before a colon or a ›, spelt as the group already is', () => {
    expect(newCategoryOptions(LIST, 'Dining:Takeaway', [])).toEqual([{ name: 'Dining:Takeaway', label: 'Add “Takeaway” under Dining' }]);
    expect(newCategoryOptions(LIST, 'housing › Rent', [])).toEqual([{ name: 'Housing:Rent', label: 'Add “Rent” under Housing' }]);
    expect(newCategoryOptions(LIST, 'Dining:', [])).toEqual([]);
    expect(newCategoryOptions(LIST, 'Bills:water', [])).toEqual([]);
  });

  it('adds a bare name ungrouped, offering the groups it came close to', () => {
    expect(newCategoryOptions(LIST, 'Takeaway', [])).toEqual([{ name: 'Takeaway', label: 'Add “Takeaway”' }]);
    const results = searchCategories(LIST, 'wat');
    expect(newCategoryOptions(LIST, 'wat', results)).toEqual([
      { name: 'wat', label: 'Add “wat”' },
      { name: 'Bills:wat', label: 'Add “wat” under Bills' },
    ]);
    // Typing the start of a group is looking for it, not naming something new inside it.
    expect(newCategoryOptions(LIST, 'Hou', searchCategories(LIST, 'Hou'))).toEqual([{ name: 'Hou', label: 'Add “Hou”' }]);
    expect(newCategoryOptions(LIST, 'groceries', [])).toEqual([]);
    expect(newCategoryOptions(LIST, 'bills', searchCategories(LIST, 'bills'))).toEqual([]);
    expect(newCategoryOptions(LIST, '   ', [])).toEqual([]);
  });

  it('inserts a new name beside its group, or before Uncategorized', () => {
    expect(insertCategory(LIST, 'Housing:Rent')).toEqual([
      'Housing:Mortgage',
      'Housing:Council tax',
      'Housing:Rent',
      ...LIST.slice(2),
    ]);
    expect(insertCategory(LIST, 'Takeaway').slice(-2)).toEqual(['Takeaway', 'Uncategorized']);
    expect(insertCategory(LIST, 'Pets:Food').slice(-2)).toEqual(['Pets:Food', 'Uncategorized']);
    expect(insertCategory(['Groceries'], 'Dining')).toEqual(['Groceries', 'Dining']);
  });
});
