import { Search } from 'lucide-react';
import type { FormEvent } from 'react';
import type { PeriodOut, ReviewStatus } from '../api';
import { useConfig, useNames } from '../config/ConfigContext';
import { categoryMenuGroups } from '../lib/categories';
import { periodLabel } from '../lib/dates';
import { accountLabel, claimTypeLabel, reviewStatusLabel } from '../lib/format';
import { btnSecondary, checkboxBase, cx, inputBase, labelBase, selectBase } from '../lib/ui';

export interface TransactionFilterValues {
  period: string;
  status: ReviewStatus | '';
  account_id: string;
  category: string;
  /** A claim type, or '' for any. */
  claim_type: string;
  q: string;
  include_transfers: boolean;
  /** Only lines filed unlike their merchant usually is on that card. */
  unusual: boolean;
}

interface Props {
  periods: PeriodOut[];
  values: TransactionFilterValues;
  onChange: (values: TransactionFilterValues) => void;
}

const STATUSES: Array<ReviewStatus | ''> = ['', 'pending_review', 'auto_approved', 'manual_approved'];

export function TransactionFilters({ periods, values, onChange }: Props) {
  const config = useConfig();
  const names = useNames();

  function set<K extends keyof TransactionFilterValues>(key: K, value: TransactionFilterValues[K]) {
    onChange({ ...values, [key]: value });
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = String(new FormData(event.currentTarget).get('q') ?? '').trim();
    onChange({ ...values, q });
  }

  return (
    <form onSubmit={submitSearch} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5" aria-label="Filters">
      <div>
        <label htmlFor="f-period" className={labelBase}>
          Period
        </label>
        <select
          id="f-period"
          className={cx(selectBase, 'mt-1.5')}
          value={values.period}
          onChange={(e) => set('period', e.target.value)}
        >
          <option value="">All periods</option>
          {periods.map((p) => (
            <option key={p.period_key} value={p.period_key}>
              {periodLabel(p.period_key)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="f-status" className={labelBase}>
          Status
        </label>
        <select
          id="f-status"
          className={cx(selectBase, 'mt-1.5')}
          value={values.status}
          onChange={(e) => set('status', e.target.value as ReviewStatus | '')}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s ? reviewStatusLabel(s) : 'Any status'}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="f-account" className={labelBase}>
          Account
        </label>
        <select
          id="f-account"
          className={cx(selectBase, 'mt-1.5')}
          value={values.account_id}
          onChange={(e) => set('account_id', e.target.value)}
        >
          <option value="">All accounts</option>
          {config.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {accountLabel(config.accounts, a.id)}
              {a.is_active === false ? ' (archived)' : ''}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="f-category" className={labelBase}>
          Category
        </label>
        <select
          id="f-category"
          className={cx(selectBase, 'mt-1.5')}
          value={values.category}
          onChange={(e) => set('category', e.target.value)}
        >
          <option value="">All categories</option>
          {categoryMenuGroups(config.categories, config.category_emojis).map((group, i) =>
            group.heading ? (
              <optgroup key={`${group.heading}-${i}`} label={group.heading}>
                {group.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.text}
                  </option>
                ))}
              </optgroup>
            ) : (
              group.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.text}
                </option>
              ))
            ),
          )}
        </select>
      </div>
      <div>
        <label htmlFor="f-claim" className={labelBase}>
          Claim type
        </label>
        <select
          id="f-claim"
          className={cx(selectBase, 'mt-1.5')}
          value={values.claim_type}
          onChange={(e) => set('claim_type', e.target.value)}
        >
          <option value="">Any claim type</option>
          {config.claim_types.map((ct) => (
            <option key={ct} value={ct}>
              {claimTypeLabel(ct, names)}
            </option>
          ))}
        </select>
      </div>
      <div className="sm:col-span-2 lg:col-span-3">
        <label htmlFor="f-q" className={labelBase}>
          Search
        </label>
        <div className="mt-1.5 flex gap-2">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
              aria-hidden="true"
            />
            {/* The URL is the source of truth: remount on change so back/forward and links show the right text. */}
            <input
              key={values.q}
              id="f-q"
              name="q"
              type="search"
              autoComplete="off"
              spellCheck={false}
              className={cx(inputBase, 'pl-9')}
              placeholder="Merchant, description or note…"
              defaultValue={values.q}
            />
          </div>
          <button type="submit" className={btnSecondary}>
            Search
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-x-5 gap-y-1 sm:col-span-2 lg:col-span-1">
        <label htmlFor="f-transfers" className="flex min-h-[38px] cursor-pointer items-center gap-2 text-sm text-ink-2">
          <input
            id="f-transfers"
            type="checkbox"
            className={checkboxBase}
            checked={values.include_transfers}
            onChange={(e) => set('include_transfers', e.target.checked)}
          />
          Include internal transfers
        </label>
        <label
          htmlFor="f-unusual"
          className="flex min-h-[38px] cursor-pointer items-center gap-2 text-sm text-ink-2"
          title="Lines filed unlike their merchant usually is on that card"
        >
          <input
            id="f-unusual"
            type="checkbox"
            className={checkboxBase}
            checked={values.unusual}
            onChange={(e) => set('unusual', e.target.checked)}
          />
          Unusual only
        </label>
      </div>
    </form>
  );
}
