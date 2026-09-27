import { ArrowDown, ArrowUp, CircleAlert, CircleCheck, CreditCard, FlaskConical, ListChecks, LoaderCircle, Minus, Plus, Trash2 } from 'lucide-react';
import { Fragment, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api, CONFIG_DEFAULTS_MESSAGE, errorMessage, isApiError, type ClaimType, type RuleTestResult, type RulesOut } from '../api';
import { useConfig, useNames, useReloadConfig } from '../config/ConfigContext';
import { useFocusFirstProblem } from '../hooks/useFocusFirstProblem';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { accountName, categoryLabel, categoryOptions, claimTypeLabel, plural } from '../lib/format';
import {
  blankPattern,
  blankRule,
  buildRulesUpdate,
  hasRulesProblems,
  matchText,
  patternsOf,
  problemsForError,
  rulesFormChanged,
  rulesFormFrom,
  rulesOf,
  validateRulesForm,
  WINDOW_MAX,
  WINDOW_MIN,
  type RuleField,
  type RuleRow,
  type RulesForm,
  type RulesProblems,
} from '../lib/rules';
import { moveItem } from '../lib/categories';
import {
  btnIcon,
  btnPrimary,
  btnSecondary,
  btnSmall,
  cardInset,
  checkboxBase,
  cx,
  eyebrow,
  fieldNoteId,
  inputBase,
  inputInvalid,
  selectBase,
  tableBase,
  tableFlush,
  tdBase,
  thBase,
} from '../lib/ui';
import { Card } from './Card';
import { EmptyState } from './EmptyState';
import { ErrorMessage } from './ErrorMessage';
import { Field } from './Field';
import { LoadingState } from './LoadingState';
import { Notice } from './Notice';

export const RULES_SAVED_MESSAGE = 'Saved. The rules apply to the next upload; lines already imported keep their classification.';
export const RULES_DESCRIPTION =
  'Tried in order against the raw statement description; the first match wins, skips the AI and is approved straight away.';
export const CARD_PAYMENTS_DESCRIPTION =
  'A line matching one of these patterns is a card being paid off, so it is paired with the same amount on the other statement and kept out of spending.';
export const NO_MATCH_MESSAGE = 'No rule matches; the AI or memory would classify it.';
export const CARD_PAYMENT_MESSAGE = 'Counts as a card payment, so it would go to the transfer buffer rather than spending.';
export const NOT_CARD_PAYMENT_MESSAGE = 'Not a card payment.';
export const PATTERN_PLACEHOLDER = '(?i)ACME\\s*WATER';
export const CONFIG_STALE_MESSAGE = 'Saved, but the settings shown elsewhere could not be refreshed';
export const TRY_HINT = 'Paste a description from a statement to see which rule would file it. Unsaved edits count.';
export const TRY_BLOCKED_MESSAGE = 'Fix the problems above first: the test uses the rules as they are on screen.';
/** Beside a target account the config no longer has, so the select shows what is stored rather than a blank. */
export const UNKNOWN_ACCOUNT_SUFFIX = '(not an account)';

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

interface RowNoteProps {
  id: string;
  message: string;
  /** The server's words, announced; the form's own checks are quieter. */
  live: boolean;
  colSpan: number;
}

/** A row-wide note under a rule: why it cannot be saved, or why the server refused it; the control it is about points here. */
function RowNote({ id, message, live, colSpan }: RowNoteProps) {
  return (
    // No divider above: the note belongs to the rule over it.
    <tr className="!border-t-0 max-sm:block">
      <td colSpan={colSpan} className="px-5 pb-3 max-sm:block sm:px-6">
        <p
          id={id}
          role={live ? 'alert' : undefined}
          className="flex items-center gap-2 rounded-lg bg-critical/10 px-3 py-2 text-xs text-critical-ink"
        >
          <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {message}
        </p>
      </td>
    </tr>
  );
}

const COLUMNS = 7;

/**
 * Below `sm` the rules table reflows into one stacked block per rule (the same
 * elements, so every control keeps its single accessible name): "Rule N" with its
 * actions on the first line, then each field full width under a visible label.
 */
const stackTable = 'max-sm:block';
const stackRow = 'max-sm:grid max-sm:grid-cols-[1fr_auto] max-sm:items-center max-sm:py-3';
const stackCell = 'max-sm:col-span-2 max-sm:block max-sm:min-w-0 max-sm:px-5 max-sm:py-1.5';

/** The column name shown above a field when the table is stacked; the control's own aria-label already says it. */
function StackLabel({ children }: { children: string }) {
  return (
    <span aria-hidden="true" className="mb-1 block text-xs font-medium text-ink-2 sm:hidden">
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** The Rules tab of Settings: the deterministic rules in order with a tester, and the card-payment patterns. */
export function RulesPanel() {
  const idBase = useId();
  const f = (name: string) => `${idBase}-${name}`;
  const config = useConfig();
  const names = useNames();
  const reloadConfig = useReloadConfig();

  const [saved, setSaved] = useState<RulesOut | null>(null);
  const [form, setForm] = useState<RulesForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  /** The row the server refused, in its own words; cleared on the next edit. */
  const [serverProblems, setServerProblems] = useState<RulesProblems>({ rules: {}, patterns: {} });

  const [tryText, setTryText] = useState('');
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [result, setResult] = useState<RuleTestResult | null>(null);

  const formRef = useRef<HTMLFormElement>(null);
  const focusFirstProblem = useFocusFirstProblem(formRef, saving || testing);
  const changed = saved !== null && form !== null && rulesFormChanged(form, saved);
  useUnsavedChanges(changed);

  useEffect(() => {
    let cancelled = false;
    api
      .getRules()
      .then((next) => {
        if (cancelled) return;
        setSaved(next);
        setForm(rulesFormFrom(next));
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  function edit(patch: (prev: RulesForm) => RulesForm) {
    setForm((prev) => (prev ? patch(prev) : prev));
    setSavedNotice(false);
    setServerProblems({ rules: {}, patterns: {} });
    // The result described the rules as they were.
    setResult(null);
  }

  function setRule(index: number, patch: Partial<RuleRow>) {
    edit((prev) => ({ ...prev, rules: prev.rules.map((row, i) => (i === index ? { ...row, ...patch } : row)) }));
  }

  function setPattern(index: number, value: string) {
    edit((prev) => ({ ...prev, patterns: prev.patterns.map((row, i) => (i === index ? { ...row, value } : row)) }));
  }

  if (!saved || !form) {
    return (
      <Card icon={ListChecks} title="Rules">
        {loadError ? (
          <ErrorMessage message={loadError} onRetry={() => setAttempt((a) => a + 1)} />
        ) : (
          <LoadingState label="Loading the rules" rows={3} />
        )}
      </Card>
    );
  }

  const own = validateRulesForm(form);
  const valid = !hasRulesProblems(own);
  const update = buildRulesUpdate(form, saved);
  const dirty = Object.keys(update).length > 0;
  const busy = saving || testing;
  const canTest = valid && Boolean(tryText.trim()) && !busy;
  const defaultCategory = config.categories[0] ?? '';
  const defaultClaimType: ClaimType = config.claim_types[0] ?? 'personal';
  /** Active accounts; a rule's own target is added when archived, so the select never shows a blank for it. */
  const accounts = config.accounts.filter((a) => a.is_active !== false);

  function ruleProblem(index: number): { message: string; field: RuleField; live: boolean } | null {
    if (own.rules[index]) return { ...own.rules[index], live: false };
    if (serverProblems.rules[index]) return { ...serverProblems.rules[index], live: true };
    return null;
  }

  function patternProblem(index: number): { message: string; live: boolean } | null {
    if (own.patterns[index]) return { message: own.patterns[index], live: false };
    if (serverProblems.patterns[index]) return { message: serverProblems.patterns[index], live: true };
    return null;
  }

  /** Like every settings tab, a save re-reads the config so the rest of the app works from the same state. */
  async function syncConfig() {
    try {
      await reloadConfig();
      setSyncError(null);
    } catch (err) {
      setSyncError(`${CONFIG_STALE_MESSAGE}: ${errorMessage(err)}`);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !saved) return;
    if (!valid) {
      focusFirstProblem();
      return;
    }
    if (!dirty) return;
    setSaving(true);
    setSaveError(null);
    setSavedNotice(false);
    try {
      const next = await api.updateRules(update);
      setSaved(next);
      setForm(rulesFormFrom(next));
      setServerProblems({ rules: {}, patterns: {} });
      setSavedNotice(true);
      await syncConfig();
    } catch (err) {
      const placed = isApiError(err, 422) ? problemsForError(err, errorMessage(err)) : null;
      if (placed) {
        setServerProblems(placed);
        // Once the controls are enabled again, the one the server refused takes the focus.
        focusFirstProblem();
      } else setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    if (!saved) return;
    setForm(rulesFormFrom(saved));
    setServerProblems({ rules: {}, patterns: {} });
    setSaveError(null);
    setSavedNotice(false);
    setResult(null);
  }

  async function test() {
    if (!canTest || !form) return;
    setTesting(true);
    setTestError(null);
    setResult(null);
    try {
      setResult(await api.testRule({ description: tryText.trim(), rules: rulesOf(form), payment_patterns: patternsOf(form) }));
    } catch (err) {
      // The tester validates the unsaved rules as a save would, so a bad regex lands on its row.
      const placed = isApiError(err, 422) ? problemsForError(err, errorMessage(err)) : null;
      if (placed) setServerProblems(placed);
      else setTestError(errorMessage(err));
    } finally {
      setTesting(false);
    }
  }

  const addRuleButton = (
    <button
      type="button"
      className={btnSecondary}
      disabled={busy}
      onClick={() => edit((prev) => ({ ...prev, rules: [...prev.rules, blankRule(defaultCategory, defaultClaimType)] }))}
    >
      <Plus className="h-4 w-4" aria-hidden="true" />
      Add rule
    </button>
  );

  const windowDays = Number(form.match_window_days);
  const windowProblem = own.match_window_days ?? serverProblems.match_window_days;
  const toleranceProblem = own.amount_tolerance ?? serverProblems.amount_tolerance;

  return (
    <form ref={formRef} onSubmit={save} noValidate className="space-y-6">
      {!saved.stored && (
        <Notice tone="neutral" aria-label="Rules defaults">
          {CONFIG_DEFAULTS_MESSAGE}
        </Notice>
      )}
      <Card flush icon={ListChecks} title="Rules" description={RULES_DESCRIPTION}>
        {form.rules.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="No rules yet"
            hint="A rule files every line whose description matches its pattern, without asking the AI."
            action={addRuleButton}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className={cx(tableBase, tableFlush, stackTable)}>
                <thead className="max-sm:hidden">
                  <tr>
                    <th scope="col" className={cx(thBase, 'text-right')}>
                      #
                    </th>
                    <th scope="col" className={thBase}>
                      Pattern
                    </th>
                    <th scope="col" className={thBase}>
                      Category
                    </th>
                    <th scope="col" className={thBase}>
                      Claim type
                    </th>
                    <th scope="col" className={thBase}>
                      Merchant
                    </th>
                    <th scope="col" className={thBase}>
                      Transfer
                    </th>
                    <th scope="col" className={thBase}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className={cx('divide-y divide-hairline', stackTable)}>
                  {form.rules.map((row, index) => {
                    const n = index + 1;
                    const problem = ruleProblem(index);
                    const noteId = f(`rule-${row.key}-note`);
                    /** The control the row's problem is about wears it: red edge, aria-invalid, and the note as its description. */
                    const flag = (field: RuleField) =>
                      problem?.field === field ? { invalid: true as const, describedBy: noteId } : { invalid: undefined, describedBy: undefined };
                    const target = row.transfer_to_account;
                    const archivedTarget =
                      target && !accounts.some((a) => a.id === target) ? config.accounts.filter((a) => a.id === target) : [];
                    const unknownTarget = Boolean(target) && !config.accounts.some((a) => a.id === target);
                    return (
                      <Fragment key={row.key}>
                        <tr className={stackRow}>
                          <td
                            className={cx(
                              tdBase,
                              'whitespace-nowrap text-right tabular text-ink-3 max-sm:block max-sm:py-1.5 max-sm:text-left max-sm:font-semibold max-sm:text-ink',
                            )}
                          >
                            <span className="sm:hidden">Rule </span>
                            {n}
                          </td>
                          <td className={cx(tdBase, 'min-w-[10rem] 2xl:min-w-[14rem]', stackCell)}>
                            <StackLabel>Pattern</StackLabel>
                            <input
                              type="text"
                              className={cx(inputBase, 'font-mono', flag('pattern').invalid && inputInvalid)}
                              value={row.pattern}
                              placeholder={PATTERN_PLACEHOLDER}
                              autoComplete="off"
                              spellCheck={false}
                              disabled={busy}
                              aria-label={`Pattern for rule ${n}`}
                              aria-invalid={flag('pattern').invalid}
                              aria-describedby={flag('pattern').describedBy}
                              onChange={(e) => setRule(index, { pattern: e.target.value })}
                            />
                          </td>
                          <td className={cx(tdBase, 'min-w-[9rem] 2xl:min-w-[11rem]', stackCell)}>
                            <StackLabel>Category</StackLabel>
                            <select
                              className={cx(selectBase, flag('category').invalid && inputInvalid)}
                              value={row.category}
                              title={categoryLabel(row.category)}
                              disabled={busy}
                              aria-label={`Category for rule ${n}`}
                              aria-invalid={flag('category').invalid}
                              aria-describedby={flag('category').describedBy}
                              onChange={(e) => setRule(index, { category: e.target.value })}
                            >
                              {categoryOptions(config.categories, row.category).map((c) => (
                                <option key={c} value={c}>
                                  {categoryLabel(c)}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className={cx(tdBase, 'min-w-[9rem] 2xl:min-w-[11rem]', stackCell)}>
                            <StackLabel>Claim type</StackLabel>
                            <select
                              className={cx(selectBase, flag('claim_type').invalid && inputInvalid)}
                              value={row.claim_type}
                              disabled={busy}
                              aria-label={`Claim type for rule ${n}`}
                              aria-invalid={flag('claim_type').invalid}
                              aria-describedby={flag('claim_type').describedBy}
                              onChange={(e) => setRule(index, { claim_type: e.target.value as ClaimType })}
                            >
                              {config.claim_types.map((ct) => (
                                <option key={ct} value={ct}>
                                  {claimTypeLabel(ct, names)}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className={cx(tdBase, 'min-w-[7rem] 2xl:min-w-[10rem]', stackCell)}>
                            <StackLabel>Merchant</StackLabel>
                            <input
                              type="text"
                              className={cx(inputBase, flag('merchant').invalid && inputInvalid)}
                              value={row.merchant}
                              placeholder="Optional, e.g. Aquanorth Water…"
                              autoComplete="off"
                              disabled={busy}
                              aria-label={`Merchant for rule ${n}`}
                              aria-invalid={flag('merchant').invalid}
                              aria-describedby={flag('merchant').describedBy}
                              onChange={(e) => setRule(index, { merchant: e.target.value })}
                            />
                          </td>
                          <td className={cx(tdBase, 'min-w-[8rem] 2xl:min-w-[12rem]', stackCell)}>
                            <StackLabel>Transfer</StackLabel>
                            <div className="space-y-2">
                              <label className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap text-sm text-ink-2">
                                <input
                                  type="checkbox"
                                  className={checkboxBase}
                                  checked={row.is_internal_transfer}
                                  disabled={busy}
                                  aria-label={`Internal transfer for rule ${n}`}
                                  onChange={(e) => setRule(index, { is_internal_transfer: e.target.checked })}
                                />
                                Internal transfer
                              </label>
                              {row.is_internal_transfer && (
                                <select
                                  className={cx(selectBase, flag('transfer_to_account').invalid && inputInvalid)}
                                  value={target}
                                  disabled={busy}
                                  aria-label={`Transfer account for rule ${n}`}
                                  aria-invalid={flag('transfer_to_account').invalid}
                                  aria-describedby={flag('transfer_to_account').describedBy}
                                  onChange={(e) => setRule(index, { transfer_to_account: e.target.value })}
                                >
                                  <option value="">Choose the account it goes to</option>
                                  {[...accounts, ...archivedTarget].map((a) => (
                                    <option key={a.id} value={a.id}>
                                      {accountName(a)} ··{a.identifier_last4}
                                    </option>
                                  ))}
                                  {unknownTarget && (
                                    <option value={target}>
                                      {target} {UNKNOWN_ACCOUNT_SUFFIX}
                                    </option>
                                  )}
                                </select>
                              )}
                            </div>
                          </td>
                          <td className={cx(tdBase, 'text-right max-sm:col-start-2 max-sm:row-start-1 max-sm:block max-sm:py-0')}>
                            <div className="flex items-center justify-end gap-1">
                              <button
                                type="button"
                                className={btnIcon}
                                aria-label={`Move rule ${n} up`}
                                title="Move up"
                                disabled={busy || index === 0}
                                onClick={() => edit((prev) => ({ ...prev, rules: moveItem(prev.rules, index, index - 1) }))}
                              >
                                <ArrowUp className="h-4 w-4" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className={btnIcon}
                                aria-label={`Move rule ${n} down`}
                                title="Move down"
                                disabled={busy || index === form.rules.length - 1}
                                onClick={() => edit((prev) => ({ ...prev, rules: moveItem(prev.rules, index, index + 1) }))}
                              >
                                <ArrowDown className="h-4 w-4" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className={cx(btnIcon, 'hover:bg-critical/10 hover:text-critical-ink')}
                                aria-label={`Remove rule ${n}`}
                                title="Remove"
                                disabled={busy}
                                onClick={() => edit((prev) => ({ ...prev, rules: prev.rules.filter((_, i) => i !== index) }))}
                              >
                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                              </button>
                            </div>
                          </td>
                        </tr>
                        {problem && <RowNote id={noteId} message={problem.message} live={problem.live} colSpan={COLUMNS} />}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="border-t border-hairline px-5 py-4 sm:px-6">{addRuleButton}</div>
          </>
        )}
        <div className="border-t border-hairline px-5 py-4 sm:px-6">
          <div className={cardInset}>
            <p className={eyebrow}>Try it</p>
            <p id={f('try-hint')} className="mt-1 text-xs text-ink-3">
              {valid ? TRY_HINT : TRY_BLOCKED_MESSAGE}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label htmlFor={f('try')} className="sr-only">
                Statement description
              </label>
              <input
                id={f('try')}
                type="text"
                className={cx(inputBase, 'min-w-0 flex-1 basis-56 font-mono')}
                placeholder="AQUANORTH WATER 0123"
                value={tryText}
                autoComplete="off"
                spellCheck={false}
                disabled={saving}
                // Read-only rather than disabled while testing, so Enter keeps the focus here.
                readOnly={testing}
                aria-describedby={f('try-hint')}
                onChange={(e) => {
                  setTryText(e.target.value);
                  setResult(null);
                }}
                onKeyDown={(e) => {
                  // Enter tests rather than submitting the whole form.
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void test();
                  }
                }}
              />
              <button type="button" className={btnSecondary} disabled={!canTest} onClick={() => void test()}>
                <FlaskConical className={cx('h-4 w-4', testing && 'animate-pulse')} aria-hidden="true" />
                {testing ? 'Testing…' : 'Test'}
              </button>
            </div>
            <ErrorMessage message={testError} onDismiss={() => setTestError(null)} className="mt-3" />
            {result && (
              <div role="status" aria-label="Test result" className="mt-3 space-y-1.5 text-sm">
                <p className="flex items-start gap-2">
                  {result.rule_index !== null && result.rule ? (
                    <>
                      <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-good-ink" aria-hidden="true" />
                      <span className="text-ink">{matchText(result.rule_index, result.rule, names)}</span>
                    </>
                  ) : (
                    <>
                      <Minus className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
                      <span className="text-ink-2">{NO_MATCH_MESSAGE}</span>
                    </>
                  )}
                </p>
                <p className="flex items-start gap-2 text-ink-2">
                  <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
                  <span>{result.is_payment ? CARD_PAYMENT_MESSAGE : NOT_CARD_PAYMENT_MESSAGE}</span>
                </p>
              </div>
            )}
          </div>
        </div>
      </Card>

      <Card icon={CreditCard} title="Card payments" description={CARD_PAYMENTS_DESCRIPTION}>
        <div className="space-y-5">
          <div>
            <p id={f('patterns-label')} className="text-sm font-medium text-ink-2">
              Payment patterns
            </p>
            <ul aria-labelledby={f('patterns-label')} className="mt-1.5 space-y-2">
              {form.patterns.map((row, index) => {
                const n = index + 1;
                const problem = patternProblem(index);
                const noteId = f(`pattern-${row.key}-note`);
                return (
                  <li key={row.key} className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      className={cx(inputBase, 'min-w-0 flex-1 basis-56 font-mono', problem && inputInvalid)}
                      value={row.value}
                      placeholder="(?i)PAYMENT\s+RECEIVED"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={busy}
                      aria-label={`Payment pattern ${n}`}
                      aria-invalid={problem ? true : undefined}
                      aria-describedby={problem ? noteId : undefined}
                      onChange={(e) => setPattern(index, e.target.value)}
                    />
                    <button
                      type="button"
                      className={cx(btnIcon, 'hover:bg-critical/10 hover:text-critical-ink')}
                      aria-label={`Remove payment pattern ${n}`}
                      title="Remove"
                      disabled={busy}
                      onClick={() => edit((prev) => ({ ...prev, patterns: prev.patterns.filter((_, i) => i !== index) }))}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                    {problem && (
                      <p id={noteId} role={problem.live ? 'alert' : undefined} className="basis-full text-xs text-critical-ink">
                        {problem.message}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
            {form.patterns.length === 0 && <p className="mt-1.5 text-xs text-ink-3">No patterns: card payments will be treated as spending.</p>}
            <button
              type="button"
              className={cx(btnSecondary, btnSmall, 'mt-2')}
              disabled={busy}
              onClick={() => edit((prev) => ({ ...prev, patterns: [...prev.patterns, blankPattern()] }))}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add pattern
            </button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id={f('window')}
              label="Match window"
              help="How many days apart the two sides of a payment may be."
              problem={windowProblem}
              readout={Number.isFinite(windowDays) && !windowProblem ? plural(windowDays, 'day') : undefined}
            >
              <input
                id={f('window')}
                type="number"
                inputMode="numeric"
                min={WINDOW_MIN}
                max={WINDOW_MAX}
                step={1}
                className={cx(inputBase, 'tabular sm:w-32', windowProblem && inputInvalid)}
                value={form.match_window_days}
                disabled={busy}
                aria-invalid={windowProblem ? true : undefined}
                aria-describedby={fieldNoteId(f('window'))}
                onChange={(e) => edit((prev) => ({ ...prev, match_window_days: e.target.value }))}
              />
            </Field>
            <Field
              id={f('tolerance')}
              label="Amount tolerance"
              help="How much the two amounts may differ; 0.01 allows a penny."
              problem={toleranceProblem}
            >
              <input
                id={f('tolerance')}
                type="text"
                inputMode="decimal"
                className={cx(inputBase, 'tabular sm:w-32', toleranceProblem && inputInvalid)}
                value={form.amount_tolerance}
                autoComplete="off"
                disabled={busy}
                aria-invalid={toleranceProblem ? true : undefined}
                aria-describedby={fieldNoteId(f('tolerance'))}
                onChange={(e) => edit((prev) => ({ ...prev, amount_tolerance: e.target.value }))}
              />
            </Field>
          </div>
        </div>
      </Card>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btnSecondary} onClick={discard} disabled={!changed || busy}>
            Discard changes
          </button>
          {/* Enabled while there is a change to send or a problem to point at: pressing it then moves focus to the problem. */}
          <button type="submit" className={btnPrimary} disabled={busy || (valid && !dirty)}>
            {saving && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
        <ErrorMessage message={saveError} onDismiss={() => setSaveError(null)} />
        <ErrorMessage message={syncError} onDismiss={() => setSyncError(null)} />
        {savedNotice && (
          <Notice tone="good" role="status">
            {RULES_SAVED_MESSAGE}
          </Notice>
        )}
      </div>
    </form>
  );
}
