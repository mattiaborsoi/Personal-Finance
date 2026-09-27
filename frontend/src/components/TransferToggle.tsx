import type { TransactionOut } from '../api';
import { checkboxBase, cx } from '../lib/ui';

interface Props {
  transaction: Pick<TransactionOut, 'is_internal_transfer' | 'is_split'>;
  /** The merchant as shown in the row; it names the control for screen readers. */
  merchant: string;
  disabled?: boolean;
  /** Why the toggle is locked, when it is for a reason other than the split (e.g. a closed period). */
  title?: string;
  onChange: (isInternalTransfer: boolean) => void;
}

/**
 * The "this line is a transfer between our own accounts" checkbox, shared by
 * the transactions list and the approval queue. A split line cannot be one.
 */
export function TransferToggle({ transaction: tx, merchant, disabled = false, title, onChange }: Props) {
  // The label grows the 16px box's hit area into the cell's padding (px-2 py-3 in both callers).
  return (
    <label
      className={cx('-mx-2 -my-3 inline-flex px-2 py-3 align-middle', disabled || tx.is_split ? 'cursor-not-allowed' : 'cursor-pointer')}
    >
      <input
        type="checkbox"
        className={checkboxBase}
        checked={tx.is_internal_transfer}
        disabled={disabled || tx.is_split}
        aria-label={`Mark ${merchant} as a transfer`}
        title={tx.is_split ? 'Remove the split before marking this as a transfer' : (title ?? 'Internal transfer')}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
