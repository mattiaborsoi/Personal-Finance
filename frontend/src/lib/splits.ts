import type { Money, TransactionOut, TransactionPart } from '../api';
import { normaliseAmountInput } from './money';

/**
 * Split maths is done in integer pence so a £10.00 receipt split £6.00 + £4.00
 * always adds up exactly; floating-point sums of decimal strings do not.
 */

/** "-45.90" -> -4590. NaN-safe: an unparsable value is 0. */
export function toPence(value: Money | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** 4590 -> "45.90"; -600 -> "-6.00". */
export function formatPence(pence: number): Money {
  return (pence / 100).toFixed(2);
}

/** The unsigned amount as the user types it: "-45.90" -> "45.90". */
export function magnitude(value: Money | number | null | undefined): string {
  return formatPence(Math.abs(toPence(value)));
}

/**
 * Pence for a typed amount, or null when it is blank, unparsable or not
 * greater than zero (a part must carry some of the total; the sign comes
 * from the parent, never from the user).
 */
export function parseAmountPence(raw: string): number | null {
  const normalised = normaliseAmountInput(raw);
  if (normalised === null) return null;
  const pence = toPence(normalised);
  return pence > 0 ? pence : null;
}

/**
 * Copies the editable fields of a PATCHed part (which the backend returns as
 * a full transaction) onto the matching part inside its parent.
 */
export function mergePartUpdate(parent: TransactionOut, partId: string, updated: TransactionOut): TransactionOut {
  return {
    ...parent,
    parts: parent.parts.map((p): TransactionPart => {
      if (p.id !== partId) return p;
      return {
        ...p,
        category: updated.category ?? p.category,
        subcategory: updated.subcategory,
        claim_type: updated.claim_type ?? p.claim_type,
        is_claimable: updated.is_claimable,
        allocated_primary_amount: updated.allocated_primary_amount ?? p.allocated_primary_amount,
        allocated_secondary_amount: updated.allocated_secondary_amount ?? p.allocated_secondary_amount,
        note: updated.note,
      };
    }),
  };
}
