import { StickyNote, StickyNotePlus } from 'lucide-react';
import { NOTE_MAX_LENGTH } from '../api';
import type { InlineEdit } from '../hooks/useInlineEdit';
import { btnIconSmall, cx, inputCompact } from '../lib/ui';

/*
 * The user's own note on a line (what the payment was, when the bank's
 * description does not say). The button and the note line sit in different
 * places in a row, so they share one `useInlineEdit({ value: note ?? '' })`.
 */

interface ButtonProps {
  edit: InlineEdit;
  hasNote: boolean;
  /** Who the note is about, for the accessible name: "Ocado", "Ocado part 2". */
  subject: string;
  /** The period is closed: the button is disabled with this reason as its tooltip. */
  closedTitle?: string;
  className?: string;
}

/** "Add a note" / "Edit the note" icon button; opens the note field under the description. */
export function NoteButton({ edit, hasNote, subject, closedTitle, className }: ButtonProps) {
  const Icon = hasNote ? StickyNote : StickyNotePlus;
  const { bindTrigger, start } = edit;
  return (
    <button
      type="button"
      ref={bindTrigger}
      className={cx(btnIconSmall, '-my-0.5', className)}
      aria-label={hasNote ? `Edit the note on ${subject}` : `Add a note to ${subject}`}
      title={closedTitle ?? (hasNote ? 'Edit note' : 'Add note')}
      disabled={Boolean(closedTitle)}
      onClick={start}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

interface LineProps {
  edit: InlineEdit;
  note: string | null;
  subject: string;
  className?: string;
}

/**
 * The note under the raw description, or its field while it is being edited.
 * `w-0 min-w-full`, like the raw line, so a long note truncates instead of
 * widening the column.
 */
export function NoteLine({ edit, note, subject, className }: LineProps) {
  if (edit.editing) {
    return (
      <input
        name="note"
        autoComplete="off"
        className={cx(inputCompact, 'mt-1 w-0 min-w-full max-w-[26rem] text-xs', className)}
        aria-label={`Note on ${subject}`}
        placeholder="What was this payment?"
        value={edit.draft}
        maxLength={NOTE_MAX_LENGTH}
        autoFocus
        onChange={(e) => edit.setDraft(e.target.value)}
        onKeyDown={edit.onKeyDown}
        onBlur={() => edit.end(true)}
      />
    );
  }
  if (!note) return null;
  return (
    <p className={cx('mt-1 flex w-0 min-w-full max-w-[26rem] items-start gap-1 text-xs text-ink-2', className)} title={note}>
      <StickyNote className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="sr-only">Note: </span>
      <span className="line-clamp-2 min-w-0 break-words">{note}</span>
    </p>
  );
}
