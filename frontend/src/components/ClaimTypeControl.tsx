import { Divide, Scale, User, UserRound, Wallet, type LucideIcon } from 'lucide-react';
import { useContext, useRef, type KeyboardEvent } from 'react';
import type { ClaimType } from '../api';
import { AuthContext } from '../auth/AuthContext';
import { useConfig } from '../config/ConfigContext';
import { claimTypeLabel } from '../lib/format';
import { cx, focusRing } from '../lib/ui';

interface Choice {
  value: ClaimType;
  /** The word on the segment ("By income", "Alex", "Mine"). */
  short: string;
  /** The accessible name and tooltip: the full label, which starts with the short one where they differ. */
  name: string;
  icon: LucideIcon;
  /** For a person's own items: their initial, shown instead of the icon so the two people differ at a glance. */
  initial?: string;
}

/** One letter each, or two when both names start with the same letter. */
function personInitials(primary: string, secondary: string): { primary: string; secondary: string } {
  const a = firstName(primary).toUpperCase();
  const b = firstName(secondary).toUpperCase();
  const size = a[0] && a[0] === b[0] ? 2 : 1;
  return { primary: a.slice(0, size) || '?', secondary: b.slice(0, size) || '?' };
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** Short labels and icons for each claim type, from the viewer's point of view ("Mine" for their own). */
function useClaimChoices(): Choice[] {
  const config = useConfig();
  const viewer = useContext(AuthContext)?.session?.user_id ?? null;
  const names = { primary: config.users.primary.display_name, secondary: config.users.secondary.display_name };
  const initials = personInitials(names.primary, names.secondary);
  function personal(who: 'primary' | 'secondary'): Pick<Choice, 'short' | 'name' | 'initial'> {
    const full = claimTypeLabel(`${who}_personal`, names);
    const initial = initials[who];
    return config.users[who].id === viewer
      ? { short: 'Mine', name: `Mine (${full})`, initial }
      : { short: firstName(names[who]), name: full, initial };
  }
  return config.claim_types.map((value): Choice => {
    switch (value) {
      case 'shared_proportional':
        return { value, short: 'By income', name: claimTypeLabel(value, names), icon: Scale };
      case 'shared_equal':
        return { value, short: '50/50', name: claimTypeLabel(value, names), icon: Divide };
      case 'primary_personal':
        return { value, ...personal('primary'), icon: User };
      case 'secondary_personal':
        return { value, ...personal('secondary'), icon: UserRound };
      default:
        // "personal": the account owner's own spending, nothing to settle.
        return { value, short: 'Personal', name: claimTypeLabel(value, names), icon: Wallet };
    }
  });
}

interface Props {
  value: ClaimType | '' | null | undefined;
  onChange: (claimType: ClaimType) => void;
  /** The group's accessible name, e.g. "Claim type for Ocado". */
  label: string;
  disabled?: boolean;
  /**
   * `wide` (rows): icons only, with the chosen segment's word added on a phone
   * and from `2xl`, so a row fits a laptop. `always`: the chosen word always shows.
   */
  labels?: 'wide' | 'always';
  /** `compact` is 32px tall like the row controls; `base` matches a full-size field. */
  size?: 'compact' | 'base';
  className?: string;
}

/**
 * The claim type as a segmented control: a WAI-ARIA radio group with one
 * tab stop, where the arrow keys (and Home and End) move and choose, as in a
 * native radio group. Every segment has an icon and a tooltip; the full
 * label is each segment's accessible name.
 */
export function ClaimTypeControl({ value, onChange, label, disabled = false, labels = 'wide', size = 'compact', className }: Props) {
  const choices = useClaimChoices();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const checkedIndex = choices.findIndex((c) => c.value === value);
  const tabStop = checkedIndex >= 0 ? checkedIndex : 0;

  function choose(index: number) {
    const choice = choices[index];
    if (!choice || disabled) return;
    refs.current[index]?.focus();
    if (choice.value !== value) onChange(choice.value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = choices.length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index === 0 ? last : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next === null) return;
    event.preventDefault();
    choose(next);
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cx(
        'inline-flex items-stretch gap-0.5 rounded-lg border border-control bg-surface p-0.5',
        size === 'compact' ? 'h-8' : 'h-[2.375rem]',
        disabled && 'bg-surface-2',
        className,
      )}
    >
      {choices.map((choice, index) => {
        const checked = index === checkedIndex;
        const Icon = choice.icon;
        const showWord = checked && (labels === 'always' ? 'inline' : 'hidden max-sm:inline 2xl:inline');
        return (
          <button
            key={choice.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={choice.name}
            title={choice.name}
            data-value={choice.value}
            tabIndex={index === tabStop ? 0 : -1}
            disabled={disabled}
            className={cx(
              'inline-flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
              checked ? 'bg-brand text-on-brand shadow-sm' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
              focusRing,
            )}
            onClick={() => choose(index)}
            onKeyDown={(e) => onKeyDown(e, index)}
          >
            {choice.initial ? (
              <span
                aria-hidden="true"
                className="inline-grid h-4 min-w-4 shrink-0 place-items-center rounded-full border border-current px-0.5 text-[9px] font-semibold leading-none"
              >
                {choice.initial}
              </span>
            ) : (
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            {showWord && <span className={cx(showWord, 'max-w-[6rem] truncate whitespace-nowrap')}>{choice.short}</span>}
          </button>
        );
      })}
    </div>
  );
}
