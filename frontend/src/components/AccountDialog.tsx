import { ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import {
  api,
  errorMessage,
  type AccountCreate,
  type AccountOut,
  type AccountType,
  type AccountUpdate,
  type ClaimType,
} from '../api';
import { useConfig, useNames } from '../config/ConfigContext';
import { ACCOUNT_TYPES, accountName, accountTypeName, claimTypeLabel, plural } from '../lib/format';
import {
  btnGhost,
  btnPrimary,
  btnSecondary,
  btnSmall,
  cx,
  dialogBody,
  dialogFooter,
  inputBase,
  labelBase,
  selectBase,
} from '../lib/ui';
import { ErrorMessage } from './ErrorMessage';
import { Modal } from './Modal';

interface Props {
  /** The account to edit; leave out to add one. */
  account?: AccountOut | null;
  onClose: () => void;
  /** The saved account as the server returned it. The caller closes the dialog. */
  onSaved: (account: AccountOut) => void;
}

interface Form {
  label: string;
  institution: string;
  account_type: AccountType;
  owner: string;
  identifier_last4: string;
  default_claim_type: ClaimType;
  /** Empty means the owner pays. */
  billed_to: string;
  /** Create only; empty lets the server generate one. */
  id: string;
}

type FieldErrors = Partial<Record<'institution' | 'identifier_last4', string>>;

export const LAST4_MAX_LENGTH = 8;

function initialForm(account: AccountOut | null | undefined, primaryId: string): Form {
  if (account) {
    return {
      label: account.label ?? '',
      institution: account.institution,
      account_type: account.account_type,
      owner: account.owner_user_id,
      identifier_last4: account.identifier_last4,
      default_claim_type: account.default_claim_type,
      billed_to: account.billed_to ?? '',
      id: account.id,
    };
  }
  return {
    label: '',
    institution: '',
    account_type: 'checking',
    owner: primaryId,
    identifier_last4: '',
    default_claim_type: 'personal',
    billed_to: '',
    id: '',
  };
}

function validate(form: Form): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.institution.trim()) errors.institution = 'Enter the institution as printed on the statement.';
  const last4 = form.identifier_last4.trim();
  if (!last4) errors.identifier_last4 = 'Enter the digits printed on the statement.';
  else if (last4.length > LAST4_MAX_LENGTH) errors.identifier_last4 = `Use at most ${LAST4_MAX_LENGTH} characters.`;
  return errors;
}

function createBody(form: Form, customId: boolean): AccountCreate {
  const body: AccountCreate = {
    institution: form.institution.trim(),
    account_type: form.account_type,
    owner: form.owner,
    identifier_last4: form.identifier_last4.trim(),
    default_claim_type: form.default_claim_type,
  };
  const label = form.label.trim();
  if (label) body.label = label;
  if (form.billed_to) body.billed_to = form.billed_to;
  const id = form.id.trim();
  if (customId && id) body.id = id;
  return body;
}

/** Only the fields that differ from the saved account; an empty object means nothing changed. */
function updateBody(form: Form, account: AccountOut): AccountUpdate {
  const body: AccountUpdate = {};
  const label = form.label.trim() || null;
  if (label !== (account.label ?? null)) body.label = label;
  const institution = form.institution.trim();
  if (institution !== account.institution) body.institution = institution;
  if (form.account_type !== account.account_type) body.account_type = form.account_type;
  if (form.owner !== account.owner_user_id) body.owner = form.owner;
  const last4 = form.identifier_last4.trim();
  if (last4 !== account.identifier_last4) body.identifier_last4 = last4;
  if (form.default_claim_type !== account.default_claim_type) body.default_claim_type = form.default_claim_type;
  const billedTo = form.billed_to || null;
  if (billedTo !== (account.billed_to ?? null)) body.billed_to = billedTo;
  return body;
}

interface FieldProps {
  id: string;
  label: string;
  optional?: boolean;
  help?: ReactNode;
  error?: string;
  children: ReactNode;
}

/** Label over a control, with helper text that gives way to the field's error. */
function Field({ id, label, optional = false, help, error, children }: FieldProps) {
  return (
    <div>
      <label htmlFor={id} className={labelBase}>
        {label}
        {optional && <span className="font-normal text-ink-3"> (optional)</span>}
      </label>
      <div className="mt-1.5">{children}</div>
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-critical-ink">
          {error}
        </p>
      ) : (
        help && (
          <p id={`${id}-help`} className="mt-1.5 text-xs text-ink-3">
            {help}
          </p>
        )
      )}
    </div>
  );
}

/** The id of whichever note is showing under a field, for `aria-describedby`. */
function describedBy(id: string, error: string | undefined, help: boolean): string | undefined {
  if (error) return `${id}-error`;
  return help ? `${id}-help` : undefined;
}

/** Modal for adding an account or editing one; edits send only the fields that changed. */
export function AccountDialog({ account, onClose, onSaved }: Props) {
  const config = useConfig();
  const names = useNames();
  const idBase = useId();
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const institutionRef = useRef<HTMLInputElement>(null);
  const last4Ref = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<Form>(() => initialForm(account, config.users.primary.id));
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [customId, setCustomId] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const editing = Boolean(account);
  const f = (name: string) => `${idBase}-${name}`;

  function update<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (key === 'institution' || key === 'identifier_last4') {
      setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problems = validate(form);
    // Committed before focus moves, so the field is already invalid and described by its error when it is read out.
    flushSync(() => setFieldErrors(problems));
    if (problems.institution || problems.identifier_last4) {
      (problems.institution ? institutionRef : last4Ref).current?.focus();
      return;
    }
    setError(null);
    setSaving(true);
    try {
      if (account) {
        const body = updateBody(form, account);
        if (Object.keys(body).length === 0) {
          onClose();
          return;
        }
        onSaved(await api.updateAccount(account.id, body));
      } else {
        onSaved(await api.createAccount(createBody(form, customId)));
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const supplementaryHint = form.account_type === 'credit_supplementary' && form.billed_to === '';
  const billedToHelp = supplementaryHint
    ? `Supplementary cards are billed to ${names.primary} unless you choose otherwise.`
    : 'Who pays the bill; usually the owner.';

  return (
    <Modal
      title={account ? `Edit ${accountName(account)}` : 'Add account'}
      description={
        account ? (
          <>
            <span translate="no" className="break-all font-mono text-xs">
              {account.id}
            </span> · {plural(account.transaction_count, 'transaction')}
          </>
        ) : undefined
      }
      onClose={onClose}
      busy={saving}
      initialFocusRef={firstFieldRef}
    >
      <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
        <div className={cx(dialogBody, 'space-y-4')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={f('label')} label="Label" optional help="A friendlier name shown in the app.">
              <input
                ref={firstFieldRef}
                id={f('label')}
                type="text"
                className={inputBase}
                placeholder="e.g. HSBC Premier…"
                value={form.label}
                autoComplete="off"
                disabled={saving}
                aria-describedby={describedBy(f('label'), undefined, true)}
                onChange={(e) => update('label', e.target.value)}
              />
            </Field>
            <Field
              id={f('institution')}
              label="Institution"
              help="As printed on the statement, e.g. HSBC"
              error={fieldErrors.institution}
            >
              <input
                ref={institutionRef}
                id={f('institution')}
                type="text"
                className={cx(inputBase, fieldErrors.institution && 'border-critical hover:border-critical')}
                value={form.institution}
                autoComplete="off"
                required
                disabled={saving}
                aria-invalid={fieldErrors.institution ? true : undefined}
                aria-describedby={describedBy(f('institution'), fieldErrors.institution, true)}
                onChange={(e) => update('institution', e.target.value)}
              />
            </Field>
            <Field id={f('type')} label="Type">
              <select
                id={f('type')}
                className={selectBase}
                value={form.account_type}
                disabled={saving}
                onChange={(e) => update('account_type', e.target.value as AccountType)}
              >
                {ACCOUNT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {accountTypeName(t)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id={f('owner')} label="Owner" help="Who spends on it.">
              <select
                id={f('owner')}
                className={selectBase}
                value={form.owner}
                disabled={saving}
                aria-describedby={describedBy(f('owner'), undefined, true)}
                onChange={(e) => update('owner', e.target.value)}
              >
                <option value={config.users.primary.id}>{names.primary}</option>
                <option value={config.users.secondary.id}>{names.secondary}</option>
              </select>
            </Field>
            <Field
              id={f('last4')}
              label="Last four digits"
              help="The digits printed on the statement; how uploads are mapped"
              error={fieldErrors.identifier_last4}
            >
              <input
                ref={last4Ref}
                id={f('last4')}
                type="text"
                inputMode="numeric"
                className={cx(inputBase, 'tabular', fieldErrors.identifier_last4 && 'border-critical hover:border-critical')}
                placeholder="e.g. 4471…"
                maxLength={LAST4_MAX_LENGTH}
                value={form.identifier_last4}
                autoComplete="off"
                required
                disabled={saving}
                aria-invalid={fieldErrors.identifier_last4 ? true : undefined}
                aria-describedby={describedBy(f('last4'), fieldErrors.identifier_last4, true)}
                onChange={(e) => update('identifier_last4', e.target.value)}
              />
            </Field>
            <Field id={f('claim')} label="Default claim type" help="The starting claim type for lines nothing else classifies.">
              <select
                id={f('claim')}
                className={selectBase}
                value={form.default_claim_type}
                disabled={saving}
                aria-describedby={describedBy(f('claim'), undefined, true)}
                onChange={(e) => update('default_claim_type', e.target.value as ClaimType)}
              >
                {config.claim_types.map((ct) => (
                  <option key={ct} value={ct}>
                    {claimTypeLabel(ct, names)}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field id={f('billed')} label="Billed to" help={billedToHelp}>
            <select
              id={f('billed')}
              className={selectBase}
              value={form.billed_to}
              disabled={saving}
              aria-describedby={describedBy(f('billed'), undefined, true)}
              onChange={(e) => update('billed_to', e.target.value)}
            >
              <option value="">Same as owner</option>
              <option value={config.users.primary.id}>{names.primary}</option>
              <option value={config.users.secondary.id}>{names.secondary}</option>
            </select>
          </Field>

          {!editing && (
            <div>
              <button
                type="button"
                className={cx(btnGhost, btnSmall, '-ml-2')}
                aria-expanded={customId}
                aria-controls={f('advanced')}
                disabled={saving}
                onClick={() => setCustomId((open) => !open)}
              >
                {customId ? (
                  <ChevronDown className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                )}
                Set the identifier myself
              </button>
              {customId && (
                <div id={f('advanced')} className="mt-2">
                  <Field id={f('id')} label="Identifier" optional help="Leave blank to generate one; used in rules">
                    <input
                      id={f('id')}
                      type="text"
                      className={cx(inputBase, 'font-mono')}
                      placeholder="e.g. acc_checking_hsbc…"
                      value={form.id}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={saving}
                      aria-describedby={describedBy(f('id'), undefined, true)}
                      onChange={(e) => update('id', e.target.value)}
                    />
                  </Field>
                </div>
              )}
            </div>
          )}

          <ErrorMessage message={error} onDismiss={() => setError(null)} />
        </div>

        <footer className={dialogFooter}>
          <button type="button" className={btnSecondary} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className={btnPrimary} disabled={saving}>
            {saving && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add account'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
