import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { btnIcon, cx } from '../lib/ui';

interface Props {
  title: ReactNode;
  /** One line under the title; also the dialog's accessible description. */
  description?: ReactNode;
  onClose: () => void;
  /** While true (a request is in flight) Escape, the backdrop and the close button do nothing. */
  busy?: boolean;
  /** The control to focus on open; defaults to the first focusable element in the body. */
  initialFocusRef?: RefObject<HTMLElement>;
  /** `md` suits a form; `lg` a wide row editor. */
  size?: 'md' | 'lg';
  /** The body, usually a form made of `dialogBody` and `dialogFooter` sections. */
  children: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal shell: portal, backdrop, labelled `role="dialog"`, focus
 * trap, Escape to close, scroll lock, and focus returned to the opener.
 */
export function Modal({ title, description, onClose, busy = false, initialFocusRef, size = 'md', children }: Props) {
  const idBase = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Initial focus lands in the body; focus goes back where it came from on close.
  useEffect(() => {
    const previous = document.activeElement;
    const target = initialFocusRef?.current ?? bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [initialFocusRef]);

  // The page behind must not scroll while the dialog is open.
  useEffect(() => {
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  // Escape closes; Tab cycles within the dialog.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busy) onClose();
        return;
      }
      const root = dialogRef.current;
      if (event.key !== 'Tab' || !root) return;
      const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const outside = !root.contains(active);
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, busy]);

  const titleId = `${idBase}-title`;
  const descId = `${idBase}-desc`;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-bg/70 backdrop-blur-sm" aria-hidden="true" onClick={() => !busy && onClose()} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={cx(
          'relative z-10 flex max-h-[calc(100vh-2rem)] w-full flex-col rounded-2xl border border-hairline bg-surface shadow-pop animate-rise',
          size === 'lg' ? 'max-w-3xl' : 'max-w-lg',
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-hairline px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-base font-semibold tracking-tight text-ink">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-0.5 text-sm text-ink-2">
                {description}
              </p>
            )}
          </div>
          <button type="button" className={btnIcon} aria-label="Close" title="Close" disabled={busy} onClick={onClose}>
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
