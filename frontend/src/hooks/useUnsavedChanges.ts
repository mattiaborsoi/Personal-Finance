import { createContext, useContext, useEffect } from 'react';

/** What a page holding several forms (the Settings tabs) is told about the one on screen. */
export interface UnsavedChangesGuard {
  setDirty: (dirty: boolean) => void;
}

/**
 * Provided by a page that can swap its form out without leaving the route, so it
 * can ask before it does. The app mounts `<BrowserRouter>`, not a data router, so
 * react-router's `useBlocker` is not available and links elsewhere are not guarded.
 */
export const UnsavedChangesContext = createContext<UnsavedChangesGuard | null>(null);

export const LEAVE_UNSAVED_PROMPT = 'You have unsaved changes on this tab. Leave without saving them?';

/**
 * While `dirty`, closing or reloading the page asks first (`beforeunload`), and
 * the surrounding `UnsavedChangesContext`, if any, knows there is something to lose.
 */
export function useUnsavedChanges(dirty: boolean): void {
  const guard = useContext(UnsavedChangesContext);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers only ask when returnValue is set.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    guard?.setDirty(true);
    return () => {
      window.removeEventListener('beforeunload', warn);
      guard?.setDirty(false);
    };
  }, [dirty, guard]);
}
