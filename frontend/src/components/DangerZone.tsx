import { Check, Eraser, RotateCcw, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { RESET_PHRASES, api, errorMessage, type ResetOut, type ResetScope } from '../api';
import { useReloadConfig } from '../config/ConfigContext';
import { useRefreshReviewBadge } from '../hooks/reviewBadge';
import { noticeState } from '../lib/navNotice';
import { resetSummary } from '../lib/reset';
import { btnDanger, btnSecondary, cx, eyebrow, fieldNoteId, inputBase, linkBase } from '../lib/ui';
import { PRODUCT_NAME } from './BrandMark';
import { Card } from './Card';
import { ErrorMessage } from './ErrorMessage';
import { Field } from './Field';
import { Notice } from './Notice';

interface ResetAction {
  scope: ResetScope;
  /** The button that opens the confirmation. */
  action: string;
  icon: LucideIcon;
  summary: string;
  goes: string[];
  stays: string[];
}

const ACTIONS: ResetAction[] = [
  {
    scope: 'transactions',
    action: 'Delete all transactions',
    icon: Eraser,
    summary: 'Empties the ledger and keeps everything you have set up.',
    goes: [
      'Every transaction, split part and transfer leg',
      'Every statement upload',
      'Audit reports and the settlement figures recorded at close',
      'Periods with no partner claims in them',
    ],
    stays: [
      'Partner claims, and the periods they are in',
      'Merchant memory',
      'Accounts',
      'Settings: household, categories, rules and AI',
    ],
  },
  {
    scope: 'everything',
    action: `Reset ${PRODUCT_NAME} to day one`,
    icon: RotateCcw,
    summary: 'Empties everything and sets the accounts up again from config.yaml.',
    goes: [
      'Every transaction and statement upload',
      'Partner claims and every period',
      'Merchant memory',
      'Accounts and settings: household, categories, rules and AI',
    ],
    stays: ['Both logins: the passwords live in .env', 'config.yaml: its accounts are set up again, as on first start'],
  },
];

/** The server's sentences start in lower case ("type DELETE TRANSACTIONS to confirm"). */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ItemList({ items, icon: Icon, iconClass }: { items: string[]; icon: LucideIcon; iconClass: string }) {
  return (
    <ul className="mt-2 space-y-1.5 text-sm text-ink-2">
      {items.map((item) => (
        <li key={item} className="flex gap-2">
          <Icon className={cx('mt-0.5 h-4 w-4 shrink-0', iconClass)} aria-hidden="true" />
          {item}
        </li>
      ))}
    </ul>
  );
}

interface ConfirmProps {
  action: ResetAction;
  busy: boolean;
  error: string | null;
  onDismissError: () => void;
  onConfirm: (phrase: string) => void;
  onCancel: () => void;
}

/** What goes and what stays, then the phrase to type; Confirm is enabled only once it matches. */
function ResetConfirmation({ action, busy, error, onDismissError, onConfirm, onCancel }: ConfirmProps) {
  const inputId = useId();
  const headingId = useId();
  const phrase = RESET_PHRASES[action.scope];
  const [typed, setTyped] = useState('');
  // The server trims and compares case-sensitively; so does this.
  const matches = typed.trim() === phrase;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (matches && !busy) onConfirm(typed.trim());
  }

  return (
    <form
      id={`reset-${action.scope}`}
      aria-labelledby={headingId}
      onSubmit={submit}
      noValidate
      className="mt-3 space-y-4 rounded-xl border border-critical/30 p-4 animate-rise"
    >
      <h3 id={headingId} className="sr-only">
        Confirm: {action.action}
      </h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h4 className={eyebrow}>What goes</h4>
          <ItemList items={action.goes} icon={X} iconClass="text-critical-ink" />
        </div>
        <div>
          <h4 className={eyebrow}>What stays</h4>
          <ItemList items={action.stays} icon={Check} iconClass="text-good-ink" />
        </div>
      </div>
      <Field id={inputId} label={`Type ${phrase} to confirm`} help="This cannot be undone.">
        <input
          id={inputId}
          className={cx(inputBase, 'font-mono sm:max-w-xs')}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          disabled={busy}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          aria-describedby={fieldNoteId(inputId)}
        />
      </Field>
      <ErrorMessage message={error} onDismiss={onDismissError} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={btnDanger} disabled={!matches || busy}>
          <Check className="h-4 w-4" aria-hidden="true" />
          {busy ? 'Working…' : 'Confirm'}
        </button>
        <button type="button" className={btnSecondary} onClick={onCancel} disabled={busy}>
          <X className="h-4 w-4" aria-hidden="true" />
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The foot of Settings → System: empty the ledger, or the whole installation, behind a typed phrase. */
export function DangerZone() {
  const navigate = useNavigate();
  const reloadConfig = useReloadConfig();
  const refreshReviewBadge = useRefreshReviewBadge();
  const [open, setOpen] = useState<ResetScope | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  function toggle(scope: ResetScope) {
    setError(null);
    setDone(null);
    setSyncError(null);
    setOpen((current) => (current === scope ? null : scope));
  }

  async function reset(scope: ResetScope, confirm: string) {
    setBusy(true);
    setError(null);
    let result: ResetOut;
    try {
      result = await api.resetSystem({ scope, confirm });
    } catch (err) {
      // A 422 is the server's "type DELETE … to confirm".
      setError(capitalise(errorMessage(err)));
      setBusy(false);
      return;
    }
    const summary = resetSummary(result.scope, result.deleted, PRODUCT_NAME);
    // Names, categories and accounts elsewhere read the config, which a reset can change.
    let reloadError: string | null = null;
    try {
      await reloadConfig();
    } catch (err) {
      reloadError = `Reset, but the rest of ${PRODUCT_NAME} shows the old settings until you reload the page: ${errorMessage(err)}`;
    }
    if (result.scope === 'everything' && !reloadError) {
      navigate('/', { state: noticeState(summary) });
      return;
    }
    setBusy(false);
    setOpen(null);
    setDone(summary);
    setSyncError(reloadError);
    refreshReviewBadge();
  }

  return (
    <Card icon={TriangleAlert} title="Danger zone" description="These cannot be undone." accentClass="bg-critical">
      <ul className="divide-y divide-hairline">
        {ACTIONS.map((action) => {
          const Icon = action.icon;
          const expanded = open === action.scope;
          return (
            <li key={action.scope} className="py-4 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="min-w-0 flex-1 basis-60 text-sm text-ink-2">{action.summary}</p>
                <button
                  type="button"
                  className={btnDanger}
                  aria-expanded={expanded}
                  aria-controls={expanded ? `reset-${action.scope}` : undefined}
                  disabled={busy}
                  onClick={() => toggle(action.scope)}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {action.action}
                </button>
              </div>
              {expanded && (
                <ResetConfirmation
                  action={action}
                  busy={busy}
                  error={error}
                  onDismissError={() => setError(null)}
                  onConfirm={(phrase) => void reset(action.scope, phrase)}
                  onCancel={() => toggle(action.scope)}
                />
              )}
            </li>
          );
        })}
      </ul>
      {(done || syncError) && (
        <div className="mt-4 space-y-3">
          {done && (
            <Notice tone="good" role="status">
              {done}
            </Notice>
          )}
          <ErrorMessage message={syncError} onDismiss={() => setSyncError(null)} />
        </div>
      )}
      <p className="mt-4 border-t border-hairline pt-4 text-xs text-ink-3">
        To remove one statement, use Delete under Previous uploads on the{' '}
        <Link to="/upload" className={linkBase}>
          Upload page
        </Link>
        .
      </p>
    </Card>
  );
}
