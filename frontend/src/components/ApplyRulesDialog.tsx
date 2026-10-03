import { ArrowRight, ChevronDown, ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';
import { api, editErrorMessage, type ApplyRulesResponse, type FiledAs } from '../api';
import { useConfig, useNames } from '../config/ConfigContext';
import { useAsync } from '../hooks/useAsync';
import { categoryEmojiLabel } from '../lib/categories';
import { claimTypeLabel, plural } from '../lib/format';
import { applyPreviewSentence } from '../lib/rules';
import { btnGhost, btnPrimary, btnSecondary, btnSmall, cardInset, cx, dialogBody, dialogFooter } from '../lib/ui';
import { ErrorMessage } from './ErrorMessage';
import { LoadingState } from './LoadingState';
import { Modal } from './Modal';
import { MoneyText } from './MoneyText';
import { Notice } from './Notice';

export const UNSAVED_RULES_NOTE = 'Unsaved edits on the Rules tab are not included: save them first to apply them.';

interface Props {
  /** The form has edits not saved yet; the run uses the saved rules only. */
  unsaved?: boolean;
  onClose: () => void;
  /** Called with the server's answer once the rules are applied. */
  onApplied: (result: ApplyRulesResponse) => void;
}

/**
 * "Apply to waiting lines": shows what the saved rules would do to the lines waiting
 * for review (a dry run over every open month), then applies them on confirm.
 */
export function ApplyRulesDialog({ unsaved = false, onClose, onApplied }: Props) {
  const config = useConfig();
  const names = useNames();
  const idBase = useId();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useAsync(() => api.applyRules({ dry_run: true, period: null }), 'apply-rules');
  const data = preview.data;
  const count = data?.approved ?? 0;
  const listId = `${idBase}-lines`;

  function filed(value: FiledAs): string {
    return `${categoryEmojiLabel(value.category, config.category_emojis)} · ${claimTypeLabel(value.claim_type, names)}`;
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      onApplied(await api.applyRules({ dry_run: false, period: null }));
    } catch (err) {
      setError(editErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Apply rules to waiting lines"
      description="Your saved rules, run again on the lines waiting for review. A line a rule matches is filed as the rule says and approved, as at upload."
      onClose={onClose}
      busy={busy}
    >
      <div className={cx(dialogBody, 'space-y-5')}>
        {unsaved && <Notice tone="warning">{UNSAVED_RULES_NOTE}</Notice>}

        <div aria-live="polite" aria-busy={preview.loading} className="space-y-3">
          {preview.loading && <LoadingState inline label="Checking the waiting lines" />}
          {preview.error && <ErrorMessage message={editErrorMessage(preview.error)} onRetry={preview.reload} />}
          {data && !preview.loading && (
            <p className={cx(cardInset, 'text-sm font-semibold text-ink')}>{applyPreviewSentence(data)}</p>
          )}
        </div>

        {data && !preview.loading && data.items.length > 0 && (
          <div>
            <button
              type="button"
              className={cx(btnGhost, btnSmall, '-ml-2.5')}
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
              {expanded ? 'Hide the lines' : `Show the ${plural(data.matched, 'line')}`}
            </button>
            {expanded && (
              <ul id={listId} aria-label="Lines the rules match" className="mt-2 divide-y divide-hairline rounded-xl border border-hairline">
                {data.items.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 basis-40 truncate font-medium text-ink" title={item.cleaned_merchant}>
                      {item.cleaned_merchant}
                    </span>
                    <MoneyText value={item.amount} className="shrink-0 text-ink" />
                    {item.changed ? (
                      <span className="flex w-full min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-ink-3">
                        <span>{filed(item.before)}</span>
                        <ArrowRight className="h-3 w-3 shrink-0" aria-hidden="true" />
                        <span className="sr-only">becomes</span>
                        <span className="text-ink-2">{filed(item.after)}</span>
                      </span>
                    ) : (
                      <span className="w-full min-w-0 text-xs text-ink-3">{filed(item.after)} · already filed this way</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {expanded && data.items.length < data.matched && (
              <p className="mt-2 text-xs text-ink-3">Showing the first {data.items.length}.</p>
            )}
          </div>
        )}

        <ErrorMessage message={error} />
      </div>
      <div className={dialogFooter}>
        <button type="button" className={btnSecondary} onClick={onClose} disabled={busy}>
          {data && !preview.loading && count === 0 ? 'Done' : 'Cancel'}
        </button>
        {!(data && !preview.loading && count === 0) && (
          <button type="button" className={btnPrimary} onClick={confirm} disabled={busy || !data || preview.loading}>
            {busy ? 'Applying…' : count > 0 ? `Apply to ${plural(count, 'line')}` : 'Apply'}
          </button>
        )}
      </div>
    </Modal>
  );
}
