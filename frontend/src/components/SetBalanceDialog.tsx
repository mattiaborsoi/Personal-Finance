import { LoaderCircle, Trash2 } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { api, errorMessage, type SettlementCheckpoint } from '../api';
import { useCurrency, useNames } from '../config/ConfigContext';
import { periodLabel } from '../lib/dates';
import { formatMoney, normaliseAmountInput, toNumber } from '../lib/money';
import { amountProblem, balanceHeadline, lastDayOfPeriod, settlementDirection } from '../lib/settlement';

const ZERO_PROBLEM = amountProblem('0');
import { btnPrimary, btnSecondary, cx, dialogBody, dialogFooter, fieldNoteId, inputBase, inputInvalid } from '../lib/ui';
import { ConfirmButton } from './ConfirmButton';
import { ErrorMessage } from './ErrorMessage';
import { Field } from './Field';
import { Modal } from './Modal';
import { RadioOption } from './RadioOption';

interface Props {
  /** The month whose end the balance is agreed at (YYYY-MM). */
  period: string;
  /** The month's current agreed balance, to edit or remove; null to set one. */
  checkpoint: SettlementCheckpoint | null;
  /** Pre-fills the amount (secondary-owes terms) instead of the checkpoint's, e.g. to set it again after a drift. */
  initialAmount?: number | null;
  onClose: () => void;
  /** Called with a sentence describing what was saved or removed. */
  onSaved: (message: string) => void;
}

type Who = 'secondary_owes' | 'primary_owes' | 'settled';

function initialState(amount: number | null): { who: Who; amount: string } {
  if (amount === null || !Number.isFinite(amount)) return { who: 'secondary_owes', amount: '' };
  const who = settlementDirection(amount);
  return { who, amount: who === 'settled' ? '' : Math.abs(amount).toFixed(2) };
}

/**
 * Agrees the balance as at the end of a month (a checkpoint). Later months start
 * from it and earlier months become history; editing replaces the month's one.
 */
export function SetBalanceDialog({ period, checkpoint, initialAmount = null, onClose, onSaved }: Props) {
  const names = useNames();
  const symbol = useCurrency();
  const idBase = useId();
  const f = (name: string) => `${idBase}-${name}`;
  const start = initialState(initialAmount ?? (checkpoint ? toNumber(checkpoint.amount) : null));
  const [who, setWho] = useState<Who>(start.who);
  const [amount, setAmount] = useState(start.amount);
  const [note, setNote] = useState(checkpoint?.note ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);
  const month = periodLabel(period);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const amountIssue = who === 'settled' ? null : amountProblem(amount);
    if (amountIssue) {
      flushSync(() =>
        setProblem(amountIssue === ZERO_PROBLEM ? 'Enter how much is owed, or choose “Settled up”.' : amountIssue),
      );
      amountRef.current?.focus();
      return;
    }
    const n = who === 'settled' ? '0.00' : (normaliseAmountInput(amount) as string);
    const signed = who === 'primary_owes' ? (-Number(n)).toFixed(2) : n;
    setError(null);
    setSaving(true);
    const trimmed = note.trim();
    const body = {
      kind: 'checkpoint' as const,
      entry_date: lastDayOfPeriod(period),
      amount: signed,
      ...(trimmed ? { note: trimmed } : {}),
    };
    try {
      // A month has one agreed balance: posting again replaces it.
      await api.createSettlementEntry(body);
      onSaved(`Balance at the end of ${month} set: ${balanceHeadline(signed, names, symbol)}.`);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  async function remove() {
    if (!checkpoint) return;
    setError(null);
    setSaving(true);
    try {
      await api.deleteSettlementEntry(checkpoint.id);
      onSaved(`The balance set for ${month} was removed.`);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  const options: { value: Who; label: string; hint: string }[] = [
    { value: 'secondary_owes', label: `${names.secondary} owes ${names.primary}`, hint: 'Enter how much below.' },
    { value: 'primary_owes', label: `${names.primary} owes ${names.secondary}`, hint: 'Enter how much below.' },
    { value: 'settled', label: `Settled up (${formatMoney(0, symbol)})`, hint: 'Nobody owes anything.' },
  ];

  return (
    <Modal
      title={checkpoint ? 'Change the balance' : 'Set the balance'}
      description={`As at the end of ${month}, who owes whom and how much?`}
      onClose={onClose}
      busy={saving}
    >
      <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
        <div className={cx(dialogBody, 'space-y-5')}>
          <p className="text-sm text-ink-2">
            Later months start from this figure; months before it become history and are not carried forward.
          </p>
          <fieldset className="space-y-3">
            <legend className="sr-only">Who owes whom</legend>
            {options.map((o) => (
              <RadioOption<Who>
                key={o.value}
                id={f(o.value)}
                name={f('who')}
                value={o.value}
                checked={who === o.value}
                disabled={saving}
                label={o.label}
                hint={o.hint}
                onChange={(value) => {
                  setWho(value);
                  setProblem(null);
                }}
              />
            ))}
          </fieldset>

          {who !== 'settled' && (
            <Field id={f('amount')} label="Amount" problem={problem ?? undefined} help={`What ${names[who === 'secondary_owes' ? 'secondary' : 'primary']} owes at the end of ${month}.`}>
              <input
                ref={amountRef}
                id={f('amount')}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                className={cx(inputBase, problem && inputInvalid)}
                value={amount}
                disabled={saving}
                aria-invalid={problem ? true : undefined}
                aria-describedby={fieldNoteId(f('amount'))}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setProblem(null);
                }}
              />
            </Field>
          )}

          <Field id={f('note')} label="Note (optional)" help="For example, how you agreed it.">
            <input
              id={f('note')}
              type="text"
              className={inputBase}
              value={note}
              maxLength={200}
              disabled={saving}
              aria-describedby={fieldNoteId(f('note'))}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <ErrorMessage message={error} />
        </div>
        <div className={cx(dialogFooter, checkpoint && 'sm:justify-between')}>
          {checkpoint && (
            <ConfirmButton
              tone="danger"
              icon={Trash2}
              confirmLabel={`Remove the balance set for ${month}?`}
              onConfirm={remove}
              disabled={saving}
            >
              Remove it
            </ConfirmButton>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={btnSecondary} disabled={saving} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={btnPrimary} disabled={saving}>
              {saving && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {checkpoint ? 'Save the balance' : 'Set the balance'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
