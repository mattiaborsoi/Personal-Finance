import { CalendarDays, Coins, Scale, UserRound, Users } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, CONFIG_DEFAULTS_MESSAGE, errorMessage, isApiError, type HouseholdOut, type SplitStrategy } from '../api';
import { useReloadConfig } from '../config/ConfigContext';
import {
  buildHouseholdUpdate,
  fieldForError,
  householdFormChanged,
  householdFormFrom,
  NO_INCOME_MESSAGE,
  parseHouseholdForm,
  ROUNDING_MAX,
  ROUNDING_MIN,
  SETTLEMENT_DAY_MAX,
  SETTLEMENT_DAY_MIN,
  splitPreview,
  splitPreviewText,
  type HouseholdField,
  type HouseholdForm,
  type HouseholdProblems,
  type Person,
  type PersonFields,
} from '../lib/household';
import { btnPrimary, btnSecondary, cardInset, cx, eyebrow, fieldNoteId, inputBase, inputInvalid } from '../lib/ui';
import { PRODUCT_NAME } from './BrandMark';
import { Card } from './Card';
import { ErrorMessage } from './ErrorMessage';
import { Field } from './Field';
import { LoadingState } from './LoadingState';
import { Notice } from './Notice';
import { RadioOption } from './RadioOption';

export const HOUSEHOLD_SAVED_MESSAGE = `Saved. The names, the split and the currency now apply throughout ${PRODUCT_NAME}.`;
export const PROPORTIONAL_LABEL = 'In proportion to income';
export const EQUAL_LABEL = '50–50';
export const CONFIG_STALE_MESSAGE = 'Saved, but the names and figures elsewhere could not be refreshed';

/** The card titles when a person has no name yet. */
const FALLBACK_NAMES: Record<Person, string> = { primary: 'Primary', secondary: 'Partner' };
const ROLE_HINTS: Record<Person, string> = {
  primary: 'The primary user: uploads statements and reviews them.',
  secondary: 'The partner: logs claims and settles up.',
};

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

interface AmountInputProps {
  id: string;
  value: string;
  symbol: string;
  disabled: boolean;
  problem?: string;
  onChange: (value: string) => void;
}

/** A money input with the currency symbol sitting inside it on the left. */
function AmountInput({ id, value, symbol, disabled, problem, onChange }: AmountInputProps) {
  return (
    <div className="relative">
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-ink-3">
        {symbol}
      </span>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        className={cx(inputBase, 'tabular', symbol.length > 1 ? 'pl-10' : 'pl-8', problem && inputInvalid)}
        value={value}
        autoComplete="off"
        disabled={disabled}
        aria-invalid={problem ? true : undefined}
        aria-describedby={fieldNoteId(id)}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

interface PersonCardProps {
  person: Person;
  title: string;
  fields: PersonFields;
  symbol: string;
  problems: HouseholdProblems;
  disabled: boolean;
  idFor: (name: string) => string;
  onChange: (key: keyof PersonFields, value: string) => void;
}

/** One person: their name and the two incomes the proportional split is worked out from. */
function PersonCard({ person, title, fields, symbol, problems, disabled, idFor, onChange }: PersonCardProps) {
  const nameId = idFor(`${person}-name`);
  const salaryId = idFor(`${person}-salary`);
  const otherId = idFor(`${person}-other`);
  const nameProblem = problems[`${person}.display_name`];
  return (
    <Card icon={UserRound} title={title} description={ROLE_HINTS[person]}>
      <div className="space-y-4">
        <Field id={nameId} label="Name" problem={nameProblem}>
          <input
            id={nameId}
            type="text"
            className={cx(inputBase, nameProblem && inputInvalid)}
            value={fields.display_name}
            autoComplete="off"
            disabled={disabled}
            aria-invalid={nameProblem ? true : undefined}
            aria-describedby={nameProblem ? fieldNoteId(nameId) : undefined}
            onChange={(e) => onChange('display_name', e.target.value)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={salaryId} label="Annual salary" help="Before tax, per year." problem={problems[`${person}.base_salary_pa`]}>
            <AmountInput
              id={salaryId}
              value={fields.base_salary_pa}
              symbol={symbol}
              disabled={disabled}
              problem={problems[`${person}.base_salary_pa`]}
              onChange={(value) => onChange('base_salary_pa', value)}
            />
          </Field>
          <Field
            id={otherId}
            label="Other annual income"
            help="Bonuses, rent, anything else that should count."
            problem={problems[`${person}.additional_income_pa`]}
          >
            <AmountInput
              id={otherId}
              value={fields.additional_income_pa}
              symbol={symbol}
              disabled={disabled}
              problem={problems[`${person}.additional_income_pa`]}
              onChange={(value) => onChange('additional_income_pa', value)}
            />
          </Field>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** The Household tab of Settings: who the two people are, their incomes, how shared costs are split, settlement and currency. */
export function HouseholdPanel() {
  const idBase = useId();
  const f = (name: string) => `${idBase}-${name}`;
  const reloadConfig = useReloadConfig();

  const [saved, setSaved] = useState<HouseholdOut | null>(null);
  const [form, setForm] = useState<HouseholdForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  /** The field the server refused, in its own words; cleared as soon as that field is edited. */
  const [serverProblem, setServerProblem] = useState<{ field: HouseholdField; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getHousehold()
      .then((next) => {
        if (cancelled) return;
        setSaved(next);
        setForm(householdFormFrom(next));
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  function edit(patch: (prev: HouseholdForm) => HouseholdForm, field: HouseholdField) {
    setForm((prev) => (prev ? patch(prev) : prev));
    setSavedNotice(false);
    setServerProblem((prev) => (prev?.field === field ? null : prev));
  }

  function setPerson(person: Person, key: keyof PersonFields, value: string) {
    edit((prev) => ({ ...prev, [person]: { ...prev[person], [key]: value } }), `${person}.${key}`);
  }

  function setField<K extends Exclude<keyof HouseholdForm, Person>>(key: K, value: HouseholdForm[K]) {
    edit((prev) => ({ ...prev, [key]: value }), key);
  }

  if (!saved || !form) {
    return (
      <Card icon={Users} title="Household">
        {loadError ? (
          <ErrorMessage message={loadError} onRetry={() => setAttempt((a) => a + 1)} />
        ) : (
          <LoadingState label="Loading the household" rows={3} />
        )}
      </Card>
    );
  }

  const parsed = parseHouseholdForm(form);
  const valid = Object.keys(parsed.problems).length === 0;
  // The form's own complaints come first; the server's stays on its field until that field is edited.
  const problems: HouseholdProblems = { ...parsed.problems };
  if (serverProblem && !problems[serverProblem.field]) problems[serverProblem.field] = serverProblem.message;
  const update = buildHouseholdUpdate(form, parsed, saved);
  const dirty = Object.keys(update).length > 0;
  const changed = householdFormChanged(form, saved);
  const canSave = dirty && valid && !saving;
  const names = {
    primary: form.primary.display_name.trim() || FALLBACK_NAMES.primary,
    secondary: form.secondary.display_name.trim() || FALLBACK_NAMES.secondary,
  };
  const symbol = parsed.currency_symbol || saved.currency_symbol;
  const preview = splitPreview(form);

  /** The names, ratios and currency elsewhere come from the config, so it must follow every save. */
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
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    setSavedNotice(false);
    try {
      const next = await api.updateHousehold(update);
      setSaved(next);
      setForm(householdFormFrom(next));
      setServerProblem(null);
      setSavedNotice(true);
      await syncConfig();
    } catch (err) {
      const field = isApiError(err, 422) ? fieldForError(err, update) : null;
      if (field) setServerProblem({ field, message: errorMessage(err) });
      else setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    if (!saved) return;
    setForm(householdFormFrom(saved));
    setServerProblem(null);
    setSaveError(null);
    setSavedNotice(false);
  }

  const dayProblem = problems.settlement_day_of_month;
  const roundingProblem = problems.rounding_decimals;
  const codeProblem = problems.base_currency;
  const symbolProblem = problems.currency_symbol;

  return (
    <form onSubmit={save} noValidate className="space-y-6">
      {!saved.stored && (
        <Notice tone="neutral" aria-label="Household defaults">
          {CONFIG_DEFAULTS_MESSAGE}
        </Notice>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <PersonCard
          person="primary"
          title={saved.users.primary.display_name || FALLBACK_NAMES.primary}
          fields={form.primary}
          symbol={symbol}
          problems={problems}
          disabled={saving}
          idFor={f}
          onChange={(key, value) => setPerson('primary', key, value)}
        />
        <PersonCard
          person="secondary"
          title={saved.users.secondary.display_name || FALLBACK_NAMES.secondary}
          fields={form.secondary}
          symbol={symbol}
          problems={problems}
          disabled={saving}
          idFor={f}
          onChange={(key, value) => setPerson('secondary', key, value)}
        />
      </div>

      <Card icon={Scale} title="How shared costs are split" description="Applies to every shared line and claim; personal items are never split.">
        <fieldset className="space-y-3">
          <legend className="sr-only">Split strategy</legend>
          <RadioOption<SplitStrategy>
            id={f('split-proportional')}
            name={f('split')}
            value="salary_proportional"
            checked={form.split_strategy === 'salary_proportional'}
            disabled={saving}
            label={PROPORTIONAL_LABEL}
            hint="Each person pays the share their income is of the household's total."
            onChange={(value) => setField('split_strategy', value)}
          />
          <RadioOption<SplitStrategy>
            id={f('split-equal')}
            name={f('split')}
            value="equal_50_50"
            checked={form.split_strategy === 'equal_50_50'}
            disabled={saving}
            label={EQUAL_LABEL}
            hint="Half each, whatever the incomes."
            onChange={(value) => setField('split_strategy', value)}
          />
        </fieldset>
        <div className={cx(cardInset, 'mt-4')}>
          <p className={eyebrow}>Preview</p>
          {preview ? (
            <p aria-live="polite" className="mt-1 text-sm font-semibold tabular text-ink">
              {splitPreviewText(preview, names)}
            </p>
          ) : (
            <p aria-live="polite" className="mt-1 text-sm text-critical-ink">
              {problems.split_strategy ?? NO_INCOME_MESSAGE}
            </p>
          )}
        </div>
      </Card>

      <Card icon={CalendarDays} title="Settlement" description="When each month is settled, and how its figures are rounded.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id={f('day')}
            label="Settle by"
            help={`Day of the following month; ${SETTLEMENT_DAY_MIN} to ${SETTLEMENT_DAY_MAX} so every month has it.`}
            problem={dayProblem}
          >
            <input
              id={f('day')}
              type="number"
              inputMode="numeric"
              min={SETTLEMENT_DAY_MIN}
              max={SETTLEMENT_DAY_MAX}
              step={1}
              className={cx(inputBase, 'tabular sm:w-32', dayProblem && inputInvalid)}
              value={form.settlement_day_of_month}
              disabled={saving}
              aria-invalid={dayProblem ? true : undefined}
              aria-describedby={fieldNoteId(f('day'))}
              onChange={(e) => setField('settlement_day_of_month', e.target.value)}
            />
          </Field>
          <Field
            id={f('rounding')}
            label="Rounding"
            help={`Decimal places settlement figures are rounded to; 2 gives ${symbol}53.40.`}
            problem={roundingProblem}
          >
            <input
              id={f('rounding')}
              type="number"
              inputMode="numeric"
              min={ROUNDING_MIN}
              max={ROUNDING_MAX}
              step={1}
              className={cx(inputBase, 'tabular sm:w-32', roundingProblem && inputInvalid)}
              value={form.rounding_decimals}
              disabled={saving}
              aria-invalid={roundingProblem ? true : undefined}
              aria-describedby={fieldNoteId(f('rounding'))}
              onChange={(e) => setField('rounding_decimals', e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card icon={Coins} title="Currency" description="Every amount is shown with this symbol; statements are expected in this currency.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={f('currency')} label="Code" help="The three-letter ISO code, e.g. GBP or EUR." problem={codeProblem}>
            <input
              id={f('currency')}
              type="text"
              className={cx(inputBase, 'font-mono uppercase sm:w-32', codeProblem && inputInvalid)}
              value={form.base_currency}
              maxLength={3}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={saving}
              aria-invalid={codeProblem ? true : undefined}
              aria-describedby={fieldNoteId(f('currency'))}
              onChange={(e) => setField('base_currency', e.target.value.toUpperCase())}
            />
          </Field>
          <Field id={f('symbol')} label="Symbol" help="Shown before every amount, e.g. £ or €." problem={symbolProblem}>
            <input
              id={f('symbol')}
              type="text"
              className={cx(inputBase, 'sm:w-32', symbolProblem && inputInvalid)}
              value={form.currency_symbol}
              maxLength={3}
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
              aria-invalid={symbolProblem ? true : undefined}
              aria-describedby={fieldNoteId(f('symbol'))}
              onChange={(e) => setField('currency_symbol', e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btnSecondary} onClick={discard} disabled={!changed || saving}>
            Discard changes
          </button>
          <button type="submit" className={btnPrimary} disabled={!canSave}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
        <ErrorMessage message={saveError} onDismiss={() => setSaveError(null)} />
        <ErrorMessage message={syncError} onDismiss={() => setSyncError(null)} />
        {savedNotice && (
          <Notice tone="good" role="status">
            {HOUSEHOLD_SAVED_MESSAGE}
          </Notice>
        )}
      </div>
    </form>
  );
}
