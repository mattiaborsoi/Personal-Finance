import { Check, Lightbulb, X } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage, type RuleSuggestion } from '../api';
import { useAsync } from '../hooks/useAsync';
import { plural } from '../lib/format';
import { btnPrimary, btnSecondary, btnSmall, cx } from '../lib/ui';
import { Card } from './Card';
import { ErrorMessage } from './ErrorMessage';
import { LoadingState } from './LoadingState';

export const SUGGESTIONS_TITLE = 'Suggested rules';
export const SUGGESTIONS_DESCRIPTION =
  'Worked out from what you approve, without AI. Accepting adds or edits the rule; nothing changes until you do.';

interface Props {
  /** Bumped by the panel after a save so the list is read again. */
  refreshKey: number;
  /** Puts the suggestion into the rules (adds, edits or removes a rule) and saves. */
  onAccept: (suggestion: RuleSuggestion) => Promise<void>;
  /** The panel cannot take a suggestion right now (unsaved edits with problems). */
  acceptDisabled?: boolean;
}

/** The suggestions block of Settings -> Rules: one line each, with Accept and Dismiss. Hidden while empty. */
export function RuleSuggestions({ refreshKey, onAccept, acceptDisabled = false }: Props) {
  const list = useAsync(() => api.getRuleSuggestions(), `rule-suggestions:${refreshKey}`);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const items = list.data?.suggestions ?? [];
  // A bonus block: nothing to show, or a failed load, means no card rather than a complaint.
  if (list.error || (!list.loading && items.length === 0)) return null;

  async function accept(suggestion: RuleSuggestion) {
    setBusyKey(suggestion.key);
    setError(null);
    try {
      await onAccept(suggestion);
      list.setData((prev) => (prev ? { suggestions: prev.suggestions.filter((s) => s.key !== suggestion.key) } : prev));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function dismiss(suggestion: RuleSuggestion) {
    setBusyKey(suggestion.key);
    setError(null);
    try {
      await api.dismissRuleSuggestion(suggestion.key);
      list.setData((prev) => (prev ? { suggestions: prev.suggestions.filter((s) => s.key !== suggestion.key) } : prev));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <Card icon={Lightbulb} title={SUGGESTIONS_TITLE} description={SUGGESTIONS_DESCRIPTION}>
      {list.loading && !list.data && <LoadingState label="Looking for suggestions" rows={2} />}
      <ErrorMessage message={error} onDismiss={() => setError(null)} className="mb-3" />
      {items.length > 0 && (
        <ul className="divide-y divide-hairline">
          {items.map((s) => {
            const busy = busyKey === s.key;
            const verb = s.action === 'remove' ? 'Remove the rule' : s.action === 'edit' ? 'Edit the rule' : 'Add the rule';
            return (
              <li key={s.key} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1 basis-64">
                  <p className="text-sm text-ink">{s.text}</p>
                  <p className="mt-0.5 text-xs text-ink-3">
                    {plural(s.count, 'approved line')} · pattern{' '}
                    <code translate="no" className="font-mono">
                      {s.rule.pattern}
                    </code>
                    {s.examples.length > 0 && <> · e.g. {s.examples.slice(0, 2).join(', ')}</>}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className={cx(btnPrimary, btnSmall)}
                    disabled={busy || acceptDisabled}
                    title={acceptDisabled ? 'Fix the rules on screen first' : verb}
                    aria-label={`Accept: ${s.text}`}
                    onClick={() => void accept(s)}
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    {verb}
                  </button>
                  <button
                    type="button"
                    className={cx(btnSecondary, btnSmall)}
                    disabled={busy}
                    aria-label={`Dismiss: ${s.text}`}
                    onClick={() => void dismiss(s)}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                    Dismiss
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
