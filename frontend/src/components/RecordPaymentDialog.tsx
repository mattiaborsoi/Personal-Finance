import { LoaderCircle } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { api, errorMessage, type SettlementEntry, type SettlementLedgerPayment } from '../api';
import { useConfig, useCurrency, useNames } from '../config/ConfigContext';
import { formatDate, periodLabel, todayIso } from '../lib/dates';
import { accountLabel } from '../lib/format';
import { formatMoney, normaliseAmountInput, toNumber } from '../lib/money';
import { amountProblem, nearbyLedgerPayment, paymentDateRange, settlementDirection } from '../lib/settlement';
import { btnGhost, btnPrimary, btnSecondary, btnSmall, cx, dialogBody, dialogFooter, fieldNoteId, inputBase, inputInvalid } from '../lib/ui';
import { ErrorMessage } from './ErrorMessage';
import { Field } from './Field';
import { Modal } from './Modal';
import { Notice } from './Notice';
import { RadioOption } from './RadioOption';

interface Props {
  /** The month the banner shows (YYYY-MM); the date may run from its first day to today. */
  period: string;
  /** The outstanding balance in secondary-owes terms: it picks who paid and offers "the full amount". */
  balanceOut: string;
  /** Approved ledger settlement payments, checked so the same payment is not counted twice. */
  ledgerPayments: SettlementLedgerPayment[];
  onClose: () => void;
  onSaved: (entry: SettlementEntry) => void;
  /** Today as YYYY-MM-DD (tests pin it). */
  today?: string;
}

type Payer = 'primary' | 'secondary';
type Problems = Partial<Record<'amount' | 'date', string>>;

/** Records a payment made outside the ledger (cash, another bank); it counts in either direction. */
export function RecordPaymentDialog({ period, balanceOut, ledgerPayments, onClose, onSaved, today = todayIso() }: Props) {
  const config = useConfig();
  const names = useNames();
  const symbol = useCurrency();
  const idBase = useId();
  const f = (name: string) => `${idBase}-${name}`;
  const ids = { primary: config.users.primary.id, secondary: config.users.secondary.id };
  const range = paymentDateRange(period, today);

  const owedBy = settlementDirection(balanceOut);
  const [payer, setPayer] = useState<Payer>(owedBy === 'primary_owes' ? 'primary' : 'secondary');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(range.initial);
  const [note, setNote] = useState('');
  const [problems, setProblems] = useState<Problems>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);

  const receiver: Payer = payer === 'primary' ? 'secondary' : 'primary';
  const outstanding = Math.abs(toNumber(balanceOut));
  // "The full amount" only makes sense when the chosen payer is the one who owes.
  const fullAmount =
    (payer === 'secondary' && owedBy === 'secondary_owes') || (payer === 'primary' && owedBy === 'primary_owes')
      ? outstanding
      : null;
  const normalised = amountProblem(amount) ? null : normaliseAmountInput(amount);
  const duplicate = normalised
    ? nearbyLedgerPayment(ledgerPayments, Number(normalised), date, ids[payer], ids)
    : null;

  function validate(): Problems {
    const next: Problems = {};
    const problem = amountProblem(amount);
    if (problem) next.amount = problem;
    if (!date) next.date = 'Choose a date.';
    else if (date < range.min || date > range.max)
      next.date = `Choose a date between ${formatDate(range.min)} and ${formatDate(range.max)}.`;
    return next;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = validate();
    flushSync(() => setProblems(next));
    if (next.amount || next.date) {
      (next.amount ? amountRef : dateRef).current?.focus();
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const entry = await api.createSettlementEntry({
        kind: 'payment',
        entry_date: date,
        amount: normalised as string,
        paid_by: ids[payer],
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onSaved(entry);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  const dateHelp =
    date && date.slice(0, 7) !== period
      ? `Counts towards ${periodLabel(date.slice(0, 7))}, the month of the date.`
      : `Between ${formatDate(range.min)} and ${formatDate(range.max)}.`;

  return (
    <Modal
      title="Record a payment"
      description="Money paid outside the ledger, in either direction. It comes off the outstanding balance and settles the month’s claims."
      onClose={onClose}
      busy={saving}
    >
      <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
        <div className={cx(dialogBody, 'space-y-5')}>
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-ink-2">Who paid</legend>
            {(['secondary', 'primary'] as const).map((who) => (
              <RadioOption<Payer>
                key={who}
                id={f(`payer-${who}`)}
                name={f('payer')}
                value={who}
                checked={payer === who}
                disabled={saving}
                label={`${names[who]} paid ${names[who === 'primary' ? 'secondary' : 'primary']}`}
                hint={
                  who === 'secondary'
                    ? `Reduces what ${names.secondary} owes, or adds to what ${names.primary} owes.`
                    : `Reduces what ${names.primary} owes, or adds to what ${names.secondary} owes.`
                }
                onChange={setPayer}
              />
            ))}
          </fieldset>

          <Field
            id={f('amount')}
            label="Amount"
            problem={problems.amount}
            help={`Paid by ${names[payer]} to ${names[receiver]}.`}
            aside={
              fullAmount !== null && fullAmount > 0 ? (
                <button
                  type="button"
                  className={cx(btnGhost, btnSmall)}
                  disabled={saving}
                  onClick={() => {
                    setAmount(fullAmount.toFixed(2));
                    setProblems((prev) => ({ ...prev, amount: undefined }));
                  }}
                >
                  The full {formatMoney(fullAmount, symbol)}
                </button>
              ) : undefined
            }
          >
            <input
              ref={amountRef}
              id={f('amount')}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              className={cx(inputBase, problems.amount && inputInvalid)}
              value={amount}
              disabled={saving}
              aria-invalid={problems.amount ? true : undefined}
              aria-describedby={fieldNoteId(f('amount'))}
              onChange={(e) => {
                setAmount(e.target.value);
                setProblems((prev) => ({ ...prev, amount: undefined }));
              }}
            />
          </Field>

          <Field id={f('date')} label="Date" problem={problems.date} help={dateHelp}>
            <input
              ref={dateRef}
              id={f('date')}
              type="date"
              className={cx(inputBase, problems.date && inputInvalid)}
              value={date}
              min={range.min}
              max={range.max}
              disabled={saving}
              aria-invalid={problems.date ? true : undefined}
              aria-describedby={fieldNoteId(f('date'))}
              onChange={(e) => {
                setDate(e.target.value);
                setProblems((prev) => ({ ...prev, date: undefined }));
              }}
            />
          </Field>

          <Field id={f('note')} label="Note (optional)">
            <input
              id={f('note')}
              type="text"
              className={inputBase}
              value={note}
              maxLength={200}
              disabled={saving}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>

          <div aria-live="polite">
            {duplicate && (
              <Notice tone="warning" role="note">
                The ledger already has an approved settlement payment of {formatMoney(Math.abs(toNumber(duplicate.effect)), symbol)} on{' '}
                {formatDate(duplicate.date)} ({accountLabel(config.accounts, duplicate.account_id)}). If this is the same payment,
                recording it here would count it twice.
              </Notice>
            )}
          </div>
          <ErrorMessage message={error} />
        </div>
        <div className={dialogFooter}>
          <button type="button" className={btnSecondary} disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={btnPrimary} disabled={saving}>
            {saving && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
            Record payment
          </button>
        </div>
      </form>
    </Modal>
  );
}
