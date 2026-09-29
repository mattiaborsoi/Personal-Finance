import { Pencil } from 'lucide-react';
import type { ReactNode } from 'react';
import { useInlineEdit } from '../hooks/useInlineEdit';
import { btnIconSmall, cx, focusRing, inputCompact } from '../lib/ui';

interface Props {
  merchant: string;
  /** Whether the statement's raw line under the name is shown in full. */
  expanded: boolean;
  /** Clicking the name shows or hides the full raw line. */
  onToggle: () => void;
  /** Tooltip on the name. */
  nameTitle?: string;
  /** False on a split part: its parent carries the merchant (the server refuses the rename with 409). */
  canRename?: boolean;
  /** The period is closed: the pencil is disabled with this reason as its tooltip. */
  closedTitle?: string;
  /** A save is running on the row; a new rename does not start. */
  busy?: boolean;
  /** Saves a changed, non-blank name (errors are the row's to show). */
  onRename: (name: string) => void;
  /** More small buttons after the pencil (the note button); hidden while renaming. */
  children?: ReactNode;
}

/**
 * The merchant name at the top of a row, with its inline rename: the pencil
 * swaps the name for a field, Enter saves, Escape cancels, blur saves, and
 * focus comes back to the pencil after a keyboard save or cancel.
 */
export function MerchantName({
  merchant,
  expanded,
  onToggle,
  nameTitle,
  canRename = true,
  closedTitle,
  busy = false,
  onRename,
  children,
}: Props) {
  const { editing, draft, setDraft, start, end, onKeyDown, bindTrigger } = useInlineEdit({
    value: merchant,
    blocked: busy,
    onSave: (name) => {
      if (name) onRename(name);
    },
  });

  if (editing) {
    return (
      <input
        name="merchant_name"
        autoComplete="off"
        spellCheck={false}
        className={cx(inputCompact, 'w-full max-w-[18rem] font-semibold')}
        aria-label={`New name for ${merchant}`}
        value={draft}
        maxLength={255}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => end(true)}
      />
    );
  }

  return (
    <>
      <button
        type="button"
        className={cx(
          'line-clamp-2 min-w-0 break-words rounded text-left font-semibold leading-snug text-ink hover:underline',
          focusRing,
        )}
        title={nameTitle}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {merchant}
      </button>
      {canRename && (
        <button
          type="button"
          ref={bindTrigger}
          className={cx(btnIconSmall, '-my-0.5')}
          aria-label={`Rename ${merchant}`}
          title={closedTitle ?? 'Rename the merchant'}
          // Not locked while saving, so focus can come back here after Enter; a click then is ignored.
          disabled={Boolean(closedTitle)}
          onClick={start}
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
      {children}
    </>
  );
}
