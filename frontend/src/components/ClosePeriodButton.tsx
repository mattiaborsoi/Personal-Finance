import { Lock, Unlock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, isApiError, type PeriodOut } from '../api';
import { btnDanger, btnSecondary, btnSmall, cx } from '../lib/ui';
import { ConfirmButton } from './ConfirmButton';
import { ErrorMessage } from './ErrorMessage';
import { Notice } from './Notice';

interface Props {
  period: PeriodOut | null;
  periodKey: string;
  onChanged: () => void;
}

/** Close (runs the auditor first) or reopen a period; offers a forced close on 409. */
export function ClosePeriodButton({ period, periodKey, onChanged }: Props) {
  const [conflict, setConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const firstRender = useRef(true);
  const isClosed = Boolean(period?.is_closed);

  // Swapping between "Close period", the blocked-close notice and "Reopen period"
  // unmounts whatever had focus. Move it to Cancel when the notice appears (not
  // Force close, so a stray Enter cannot force the close), and back to the
  // period button when the notice goes or the period flips, unless the user has
  // already moved focus elsewhere.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (conflict) {
      cancelRef.current?.focus();
      return;
    }
    const active = document.activeElement;
    if (!active || active === document.body) wrapRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [conflict, isClosed]);

  async function close(force: boolean) {
    setError(null);
    setBusy(true);
    try {
      await api.closePeriod(periodKey, force);
      setConflict(null);
      onChanged();
    } catch (err) {
      if (!force && isApiError(err, 409)) {
        setConflict(err.message || 'Some transactions are still pending review.');
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function reopen() {
    setError(null);
    try {
      await api.reopenPeriod(periodKey);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div ref={wrapRef} className="flex flex-col items-end gap-2">
      {isClosed ? (
        <ConfirmButton confirmLabel="Reopen this period?" onConfirm={reopen} tone="secondary" small icon={Unlock}>
          Reopen period
        </ConfirmButton>
      ) : conflict ? (
        <Notice
          tone="warning"
          role="alert"
          className="text-xs"
          actions={
            <>
              <button type="button" className={cx(btnDanger, btnSmall)} onClick={() => close(true)} disabled={busy}>
                {busy ? 'Closing…' : 'Force close'}
              </button>
              <button
                ref={cancelRef}
                type="button"
                className={cx(btnSecondary, btnSmall)}
                onClick={() => setConflict(null)}
                disabled={busy}
              >
                Cancel
              </button>
            </>
          }
        >
          {conflict}
        </Notice>
      ) : (
        <ConfirmButton
          confirmLabel="Close this period? The auditor runs first."
          onConfirm={() => close(false)}
          tone="secondary"
          small
          disabled={busy}
          icon={Lock}
        >
          Close period
        </ConfirmButton>
      )}
      <ErrorMessage message={error} onDismiss={() => setError(null)} />
    </div>
  );
}
