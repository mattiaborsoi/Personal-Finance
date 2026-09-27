import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Returns a function that moves focus to the first control in `root` marked
 * `aria-invalid`, once the render it causes has landed and `busy` is false
 * (controls are disabled while a save runs). A closed `<details>` around the
 * control is opened first. The control's `aria-describedby` points at its
 * problem, so the reason is read out with it.
 */
export function useFocusFirstProblem(root: RefObject<HTMLElement | null>, busy: boolean): () => void {
  const [requested, setRequested] = useState(0);
  const handled = useRef(0);

  useEffect(() => {
    if (requested === handled.current || busy) return;
    handled.current = requested;
    const target = root.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not(:disabled)');
    if (!target) return;
    const details = target.closest('details');
    if (details && !details.open) details.open = true;
    target.focus();
  }, [requested, busy, root]);

  return useCallback(() => setRequested((n) => n + 1), []);
}
