import { describe, expect, it } from 'vitest';
import { ID_OCADO, ID_PART_A, ID_PART_B, part, transaction } from '../test/fixtures';
import { formatPence, magnitude, mergePartUpdate, parseAmountPence, toPence } from './splits';

describe('split maths', () => {
  it('converts money strings to integer pence and back without drift', () => {
    expect(toPence('-45.90')).toBe(-4590);
    expect(toPence('0.1')).toBe(10);
    expect(toPence(null)).toBe(0);
    expect(toPence('abc')).toBe(0);
    expect(formatPence(4590)).toBe('45.90');
    expect(formatPence(-600)).toBe('-6.00');
    expect(formatPence(5)).toBe('0.05');
    // 0.1 + 0.2 style sums are exact in pence.
    expect(formatPence(toPence('0.10') + toPence('0.20'))).toBe('0.30');
  });

  it('shows the magnitude without a sign', () => {
    expect(magnitude('-45.90')).toBe('45.90');
    expect(magnitude('12')).toBe('12.00');
  });

  it('parses typed amounts, rejecting blanks, zero and nonsense', () => {
    expect(parseAmountPence('6')).toBe(600);
    expect(parseAmountPence('£6.50')).toBe(650);
    expect(parseAmountPence('0')).toBeNull();
    expect(parseAmountPence('')).toBeNull();
    expect(parseAmountPence('-4')).toBeNull();
    expect(parseAmountPence('abc')).toBeNull();
  });

  it('merges a PATCHed part back into its parent, leaving the other parts alone', () => {
    const parent = transaction({
      id: ID_OCADO,
      is_split: true,
      parts: [part({ id: ID_PART_A }), part({ id: ID_PART_B, split_index: 1, amount: '-15.90', category: 'Dining' })],
    });
    const returned = transaction({
      id: ID_PART_A,
      split_parent_id: ID_OCADO,
      amount: '-30.00',
      category: 'Bills:Water',
      subcategory: 'Meter',
      claim_type: 'personal',
      is_claimable: false,
      allocated_primary_amount: '-30.00',
      allocated_secondary_amount: '0.00',
    });

    const merged = mergePartUpdate(parent, ID_PART_A, returned);

    expect(merged.parts[0]).toEqual({
      ...parent.parts[0],
      category: 'Bills:Water',
      subcategory: 'Meter',
      claim_type: 'personal',
      is_claimable: false,
      allocated_primary_amount: '-30.00',
      allocated_secondary_amount: '0.00',
    });
    expect(merged.parts[1]).toBe(parent.parts[1]);
    expect(merged.id).toBe(ID_OCADO);
  });
});
