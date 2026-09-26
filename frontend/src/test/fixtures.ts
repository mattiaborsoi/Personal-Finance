import type { TransactionOut, TransactionPart } from '../api';

/** Realistic UUIDs: ids on the wire are never numbers. */
export const ID_OCADO = '3f9a2c1e-8b47-4d6a-9e21-0c5d7a1b2e33';
export const ID_UBER = '7c4d1a92-5e6f-4b3a-8d10-2f9e6c1a4b55';
export const ID_PART_A = 'a1b2c3d4-0001-4e5f-8a9b-0c1d2e3f4a01';
export const ID_PART_B = 'a1b2c3d4-0002-4e5f-8a9b-0c1d2e3f4a02';

export function transaction(overrides: Partial<TransactionOut> = {}): TransactionOut {
  return {
    id: ID_OCADO,
    period_key: '2026-03',
    account_id: 'acc_cc_amex',
    transaction_date: '2026-03-04',
    post_date: '2026-03-05',
    raw_description: 'OCADO RETAIL LTD LONDON',
    cleaned_merchant: 'Ocado',
    amount: '-45.90',
    currency: 'GBP',
    original_currency: null,
    foreign_amount: null,
    category: 'Uncategorized',
    subcategory: null,
    claim_type: 'shared_proportional',
    is_claimable: true,
    allocated_primary_amount: '-27.48',
    allocated_secondary_amount: '-18.42',
    review_status: 'pending_review',
    is_internal_transfer: false,
    linked_transfer_id: null,
    classification_source: 'llm',
    classification_confidence: 0.62,
    source_file: 'statement.pdf',
    created_at: '2026-03-06T10:00:00Z',
    is_split: false,
    split_parent_id: null,
    parts: [],
    ...overrides,
  };
}

/** One part of a split transaction, signed like its parent (spend is negative). */
export function part(overrides: Partial<TransactionPart> = {}): TransactionPart {
  return {
    id: ID_PART_A,
    split_index: 0,
    amount: '-30.00',
    category: 'Groceries',
    subcategory: null,
    claim_type: 'shared_proportional',
    is_claimable: true,
    allocated_primary_amount: '-17.96',
    allocated_secondary_amount: '-12.04',
    ...overrides,
  };
}
