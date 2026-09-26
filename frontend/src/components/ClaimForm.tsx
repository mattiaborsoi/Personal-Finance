import { CirclePlus, Divide, Scale, User, type LucideIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, editErrorMessage, type ClaimCreate, type ClaimOut, type ClaimType } from '../api';
import { useAuth } from '../auth/AuthContext';
import { useConfig, useCurrency, useNames } from '../config/ConfigContext';
import { claimDateProblem, isDateProblem } from '../lib/claims';
import { todayIso } from '../lib/dates';
import { normaliseAmountInput } from '../lib/money';
import { btnPrimary, cardInset, cx, inputBase, inputTall, labelBase, selectBase } from '../lib/ui';
import { ErrorMessage } from './ErrorMessage';
import { Notice } from './Notice';

interface Props {
  onCreated: (claim: ClaimOut) => void;
  /** Fires whenever the chosen claim date changes, so the page can follow that month. */
  onDateChange?: (isoDate: string) => void;
}

interface SplitOption {
  value: ClaimType;
  label: (names: { primary: string; secondary: string }) => string;
  hint: string;
  icon: LucideIcon;
}

const SPLIT_OPTIONS: SplitOption[] = [
  { value: 'shared_proportional', label: () => 'Split by income', hint: 'Shared cost, divided by salary ratio', icon: Scale },
  { value: 'shared_equal', label: () => '50/50', hint: 'Shared cost, split equally', icon: Divide },
  { value: 'primary_personal', label: (n) => `${n.primary}'s personal item`, hint: 'Not shared', icon: User },
  { value: 'secondary_personal', label: (n) => `${n.secondary}'s personal item`, hint: 'Not shared', icon: User },
];

/** Mobile-first claim form; large touch targets and native inputs. */
export function ClaimForm({ onCreated, onDateChange }: Props) {
  const { session } = useAuth();
  const config = useConfig();
  const names = useNames();
  const symbol = useCurrency();
  const [claimDate, setClaimDate] = useState(todayIso());
  const [dateError, setDateError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [merchant, setMerchant] = useState('');
  const [description, setDescription] = useState('');
  const [claimType, setClaimType] = useState<ClaimType>('shared_proportional');
  const [paidBy, setPaidBy] = useState(config.users.secondary.id);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  const isPrimary = session?.role === 'primary';

  function changeDate(next: string) {
    setClaimDate(next);
    // Only complain about a future date while typing; a blank field is reported on submit.
    const problem = next ? claimDateProblem(next) : null;
    setDateError(problem);
    // A corrected date also clears the same complaint from the form-level message.
    if (!problem) setError((prev) => (isDateProblem(prev) ? null : prev));
    onDateChange?.(next);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSuccess(null);
    const normalised = normaliseAmountInput(amount);
    if (!normalised || Number(normalised) <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }
    if (!merchant.trim()) {
      setError('Enter the merchant or a short description.');
      return;
    }
    const dateProblem = claimDateProblem(claimDate);
    if (dateProblem) {
      setDateError(dateProblem);
      setError(dateProblem);
      return;
    }
    setError(null);
    setBusy(true);
    const body: ClaimCreate = {
      claim_date: claimDate,
      amount: normalised,
      merchant: merchant.trim(),
      claim_type: claimType,
    };
    if (description.trim()) body.description = description.trim();
    if (isPrimary) body.paid_by = paidBy;
    try {
      const created = await api.createClaim(body);
      onCreated(created);
      setSuccess(`Logged ${symbol}${normalised} at ${body.merchant}.`);
      setAmount('');
      setMerchant('');
      setDescription('');
      // The date is kept: the next claim is usually from the same day or month.
    } catch (err) {
      setError(editErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const bigInput = cx(inputBase, inputTall, 'mt-1.5');

  return (
    <form onSubmit={submit} className="space-y-5" aria-label="Log a claim" noValidate>
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="claim-date" className={labelBase}>
            Date
          </label>
          <input
            id="claim-date"
            type="date"
            className={cx(bigInput, dateError && 'border-critical hover:border-critical')}
            value={claimDate}
            max={todayIso()}
            aria-invalid={dateError ? true : undefined}
            aria-describedby={dateError ? 'claim-date-error' : undefined}
            onChange={(e) => changeDate(e.target.value)}
            required
          />
          {dateError && (
            <p id="claim-date-error" className="mt-1.5 text-sm text-critical-ink">
              {dateError}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="claim-amount" className={labelBase}>
            Amount
          </label>
          <div className="relative">
            <span
              className="pointer-events-none absolute left-3 top-1/2 mt-[3px] -translate-y-1/2 text-base text-ink-3"
              aria-hidden="true"
            >
              {symbol}
            </span>
            <input
              id="claim-amount"
              type="text"
              inputMode="decimal"
              className={cx(bigInput, 'pl-8 tabular')}
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </div>
        </div>
      </div>
      <div>
        <label htmlFor="claim-merchant" className={labelBase}>
          Merchant or description
        </label>
        <input
          id="claim-merchant"
          type="text"
          className={bigInput}
          placeholder="e.g. Tesco"
          value={merchant}
          onChange={(e) => setMerchant(e.target.value)}
          autoComplete="off"
          required
        />
      </div>
      <div>
        <label htmlFor="claim-description" className={labelBase}>
          Notes <span className="font-normal text-ink-3">(optional)</span>
        </label>
        <input
          id="claim-description"
          type="text"
          className={bigInput}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          autoComplete="off"
        />
      </div>

      <fieldset>
        <legend className={labelBase}>Split type</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {SPLIT_OPTIONS.map((opt) => {
            const checked = claimType === opt.value;
            const Icon = opt.icon;
            return (
              <label
                key={opt.value}
                className={cx(
                  cardInset,
                  'flex min-h-[60px] cursor-pointer items-center gap-3 transition-colors',
                  checked ? 'bg-brand-soft/60 ring-2 ring-brand' : 'hover:bg-surface-3',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cx(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors',
                    checked ? 'bg-brand text-white' : 'bg-surface text-ink-2',
                  )}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">{opt.label(names)}</span>
                  <span className="block text-xs text-ink-3">{opt.hint}</span>
                </span>
                <input
                  type="radio"
                  name="claim_type"
                  value={opt.value}
                  checked={checked}
                  onChange={() => setClaimType(opt.value)}
                  className="h-4 w-4 shrink-0 accent-brand"
                />
              </label>
            );
          })}
        </div>
      </fieldset>

      {isPrimary && (
        <div>
          <label htmlFor="claim-paid-by" className={labelBase}>
            Paid by
          </label>
          <select
            id="claim-paid-by"
            className={cx(selectBase, inputTall, 'mt-1.5')}
            value={paidBy}
            onChange={(e) => setPaidBy(e.target.value)}
          >
            <option value={config.users.secondary.id}>{names.secondary}</option>
            <option value={config.users.primary.id}>{names.primary}</option>
          </select>
        </div>
      )}

      <ErrorMessage message={error} onDismiss={() => setError(null)} />
      {success && (
        <Notice tone="good" role="status">
          {success}
        </Notice>
      )}

      <button
        type="submit"
        disabled={busy}
        className={cx(btnPrimary, 'min-h-[48px] w-full text-base font-semibold')}
      >
        <CirclePlus className="h-4 w-4" aria-hidden="true" />
        {busy ? 'Saving…' : 'Log claim'}
      </button>
    </form>
  );
}
