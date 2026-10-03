import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';
import { api, editErrorMessage, type AutoApproveResponse } from '../api';
import { useConfig, useNames } from '../config/ConfigContext';
import { useAsync } from '../hooks/useAsync';
import { knownMerchantsSentence, staysBreakdown } from '../lib/autoApprove';
import { categoryEmojiLabel } from '../lib/categories';
import { monthName } from '../lib/dates';
import { claimTypeLabel, plural } from '../lib/format';
import { btnGhost, btnPrimary, btnSecondary, btnSmall, cardInset, cx, dialogBody, dialogFooter } from '../lib/ui';
import { ErrorMessage } from './ErrorMessage';
import { LoadingState } from './LoadingState';
import { Modal } from './Modal';
import { MoneyText } from './MoneyText';
import { RadioOption } from './RadioOption';

type Scope = 'month' | 'all';

interface Props {
  /** The month on show in the queue (YYYY-MM): the default scope. */
  period: string;
  /** Start from every month, e.g. when the month on show is closed. */
  defaultScope?: Scope;
  onClose: () => void;
  /** Called with the server's answer once the lines are approved. */
  onApproved: (result: AutoApproveResponse) => void;
}

/**
 * "Approve known merchants": shows what a run would approve (a dry run, for this
 * month or every month with lines waiting) and what stays for the user, then runs it.
 */
export function AutoApproveDialog({ period, defaultScope = 'month', onClose, onApproved }: Props) {
  const config = useConfig();
  const names = useNames();
  const idBase = useId();
  const [scope, setScope] = useState<Scope>(defaultScope);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = scope === 'month' ? period : null;
  const preview = useAsync(() => api.autoApprove({ period: target, dry_run: true }), `auto-approve:${target ?? 'all'}`);
  const data = preview.data;
  const count = data?.approved ?? 0;
  const stays = data ? staysBreakdown(data.skipped) : '';
  const listId = `${idBase}-lines`;

  function changeScope(next: Scope) {
    setScope(next);
    setExpanded(false);
    setError(null);
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.autoApprove({ period: target, dry_run: false });
      onApproved(result);
    } catch (err) {
      setError(editErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Approve known merchants"
      description="Lines from merchants you have always filed one way. New merchants and anything unusual stay for you."
      onClose={onClose}
      busy={busy}
    >
      <div className={cx(dialogBody, 'space-y-5')}>
        <fieldset className="space-y-3" disabled={busy}>
          <legend className="sr-only">Which lines</legend>
          <RadioOption
            id={`${idBase}-month`}
            name={`${idBase}-scope`}
            value="month"
            checked={scope === 'month'}
            label="This month"
            hint={`Lines waiting in ${monthName(period)}`}
            onChange={changeScope}
          />
          <RadioOption
            id={`${idBase}-all`}
            name={`${idBase}-scope`}
            value="all"
            checked={scope === 'all'}
            label="All months with lines waiting"
            hint="Every open month in the queue"
            onChange={changeScope}
          />
        </fieldset>

        <div aria-live="polite" aria-busy={preview.loading} className="space-y-3">
          {preview.loading && <LoadingState inline label="Checking the queue" />}
          {preview.error && <ErrorMessage message={editErrorMessage(preview.error)} onRetry={preview.reload} />}
          {data && !preview.loading && (
            <div className={cx(cardInset, 'space-y-1.5')}>
              <p className="text-sm font-semibold text-ink">{knownMerchantsSentence(count)}</p>
              {stays && (
                <p className="text-xs text-ink-2">
                  <span className="font-medium">Stays for you:</span> {stays}
                </p>
              )}
            </div>
          )}
        </div>

        {data && !preview.loading && count > 0 && (
          <div>
            <button
              type="button"
              className={cx(btnGhost, btnSmall, '-ml-2.5')}
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
              {expanded ? 'Hide the lines' : `Show the ${plural(count, 'line')}`}
            </button>
            {expanded && (
              <ul id={listId} aria-label="Lines to approve" className="mt-2 divide-y divide-hairline rounded-xl border border-hairline">
                {data.items.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 basis-40 truncate font-medium text-ink" title={item.cleaned_merchant}>
                      {item.cleaned_merchant}
                    </span>
                    <MoneyText value={item.amount} className="shrink-0 text-ink" />
                    <span className="w-full min-w-0 text-xs text-ink-3">
                      {categoryEmojiLabel(item.category, config.category_emojis)} · {claimTypeLabel(item.claim_type, names)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <ErrorMessage message={error} />
      </div>
      <div className={dialogFooter}>
        <button type="button" className={btnSecondary} onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={btnPrimary} onClick={confirm} disabled={busy || !data || preview.loading || count === 0}>
          {busy ? 'Approving…' : count > 0 ? `Approve ${plural(count, 'line')}` : 'Approve'}
        </button>
      </div>
    </Modal>
  );
}
