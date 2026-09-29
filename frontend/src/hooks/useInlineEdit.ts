import { useRef, useState, type KeyboardEvent } from 'react';

interface Options {
  /** The saved value the field starts from and is compared against. */
  value: string;
  /** Called with the trimmed text when the edit ends with a save and the text changed. */
  onSave: (next: string) => void;
  /** While true (a save is running) a new edit does not start. */
  blocked?: boolean;
}

export interface InlineEdit {
  /** True while the field is open. */
  editing: boolean;
  /** The text being typed ('' when not editing). */
  draft: string;
  setDraft: (next: string) => void;
  /** Opens the field with the saved value. */
  start: () => void;
  /** Closes the field, saving a changed value when `save` is true. Runs once per edit. */
  end: (save: boolean) => void;
  /** Enter saves, Escape cancels; either way focus goes back to the trigger. */
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** Ref for the button that opens the field, so focus can return to it after a keyboard save or cancel. */
  bindTrigger: (el: HTMLButtonElement | null) => void;
}

/**
 * Edit one value in place inside a row (a merchant name, a note): a trigger
 * button opens a text field, Enter saves, Escape cancels and blur saves.
 */
export function useInlineEdit({ value, onSave, blocked = false }: Options): InlineEdit {
  /** The text being typed; null when the field is closed. */
  const [draft, setDraft] = useState<string | null>(null);
  /** Set once Enter, Escape or blur has ended the edit, so the blur that follows the swap does not save twice. */
  const ended = useRef(false);
  /** Focus goes back to the trigger when the edit ended from the keyboard. */
  const refocus = useRef(false);

  function start() {
    if (blocked) return;
    ended.current = false;
    setDraft(value);
  }

  function end(save: boolean) {
    if (ended.current || draft === null) return;
    ended.current = true;
    const next = draft.trim();
    setDraft(null);
    if (save && next !== value.trim()) onSave(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    refocus.current = true;
    end(event.key === 'Enter');
  }

  // A fresh callback each render, so React calls it again after the field closes and the trigger can take focus.
  const bindTrigger = (el: HTMLButtonElement | null) => {
    if (el && refocus.current) {
      refocus.current = false;
      el.focus();
    }
  };

  return { editing: draft !== null, draft: draft ?? '', setDraft, start, end, onKeyDown, bindTrigger };
}
