import type { TransferBufferOut } from '../api';
import { toNumber } from './money';

/** Two legs of a transfer should cancel out; anything beyond a rounding penny needs a second look. */
export const MATCH_TOLERANCE = 0.01;

export function amountsCancelOut(
  a: Pick<TransferBufferOut, 'amount'>,
  b: Pick<TransferBufferOut, 'amount'>,
): boolean {
  const sum = toNumber(a.amount) + toNumber(b.amount);
  return Number.isFinite(sum) && Math.abs(sum) <= MATCH_TOLERANCE + 1e-9;
}
