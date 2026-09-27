import { CircleAlert } from 'lucide-react';
import { btnSecondary, btnSmall, cx } from '../lib/ui';

interface Props {
  message: string | null | undefined;
  onRetry?: () => void;
  onDismiss?: () => void;
  /** For a field's `aria-describedby` when the error is about that field. */
  id?: string;
  className?: string;
}

export function ErrorMessage({ message, onRetry, onDismiss, id, className = '' }: Props) {
  if (!message) return null;
  return (
    <div
      id={id}
      role="alert"
      className={cx(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-critical/10 px-4 py-3 text-sm text-critical-ink',
        className,
      )}
    >
      <CircleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 basis-48">{message}</span>
      {(onRetry || onDismiss) && (
        <span className="flex gap-2">
          {onRetry && (
            <button type="button" className={cx(btnSecondary, btnSmall)} onClick={onRetry}>
              Retry
            </button>
          )}
          {onDismiss && (
            <button type="button" className={cx(btnSecondary, btnSmall)} onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </span>
      )}
    </div>
  );
}
