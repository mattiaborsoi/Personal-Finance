import { Divide, Info, Scale, Wallet, X, type LucideIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { useConfig, useCurrency, useNames } from '../config/ConfigContext';
import { claimTone } from '../lib/claimTones';
import { claimTypeEffect, claimTypeLabel } from '../lib/format';
import { btnGhost, btnSecondary, btnSmall, cx } from '../lib/ui';

interface Props {
  /**
   * Opens the explainer on its own the first time this key is seen (per browser),
   * with a "Got it" that puts it away for good; the toggle can always bring it back.
   */
  tipKey?: string;
  className?: string;
}

const TIP_PREFIX = 'settl.tip.';

function tipSeen(key: string): boolean {
  try {
    return window.localStorage.getItem(TIP_PREFIX + key) === 'seen';
  } catch {
    return true; // No storage (private window): never nag.
  }
}

function markTipSeen(key: string) {
  try {
    window.localStorage.setItem(TIP_PREFIX + key, 'seen');
  } catch {
    // Nothing to do: the tip simply shows again next time.
  }
}

/** Below `sm` (a phone), where the open explainer pushes the queue off the screen. */
function onPhone(): boolean {
  try {
    return window.matchMedia?.('(max-width: 639px)').matches ?? false;
  } catch {
    return false;
  }
}

function Glyph({ icon: Icon, initial, tone }: { icon?: LucideIcon; initial?: string; tone: string }) {
  return (
    <span aria-hidden="true" className={cx('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md', tone)}>
      {Icon ? (
        <Icon className="h-4 w-4" />
      ) : (
        <span className="inline-grid h-4 min-w-4 place-items-center rounded-full border border-current px-0.5 text-[9px] font-semibold leading-none">
          {initial}
        </span>
      )}
    </span>
  );
}

/** "What do the claim types mean?": a toggle and a short panel with each type's effect and a worked example. */
export function ClaimTypeHelp({ tipKey, className }: Props) {
  const config = useConfig();
  const names = useNames();
  const symbol = useCurrency();
  const panelId = useId();
  const [asTip] = useState(() => {
    const show = Boolean(tipKey) && !tipSeen(tipKey as string);
    // On a phone one visit is enough: the tip shows this once and stays collapsed from the next visit on.
    if (show && tipKey && onPhone()) markTipSeen(tipKey);
    return show;
  });
  const [open, setOpen] = useState(asTip);
  const [tipShowing, setTipShowing] = useState(asTip);

  function dismissTip() {
    if (tipKey) markTipSeen(tipKey);
    setTipShowing(false);
    setOpen(false);
  }

  function toggle() {
    if (open && tipShowing && tipKey) markTipSeen(tipKey);
    setTipShowing(false);
    setOpen((o) => !o);
  }

  const first = (name: string) => name.trim().split(/\s+/)[0] || name;
  const initial = (name: string) => first(name).slice(0, 1).toUpperCase();
  const rows: Array<{ key: string; glyph: ReactNode; label: string; effect: string }> = config.claim_types.map((ct) => {
    const glyph =
      ct === 'shared_proportional' ? (
        <Glyph icon={Scale} tone={claimTone(ct)} />
      ) : ct === 'shared_equal' ? (
        <Glyph icon={Divide} tone={claimTone(ct)} />
      ) : ct === 'primary_personal' ? (
        <Glyph initial={initial(names.primary)} tone={claimTone(ct)} />
      ) : ct === 'secondary_personal' ? (
        <Glyph initial={initial(names.secondary)} tone={claimTone(ct)} />
      ) : (
        <Glyph icon={Wallet} tone={claimTone(ct)} />
      );
    return { key: ct, glyph, label: claimTypeLabel(ct, names), effect: claimTypeEffect(ct, names) };
  });

  return (
    <div className={className}>
      <button
        type="button"
        className={cx(btnGhost, btnSmall, '-ml-2.5')}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
        What do the claim types mean?
      </button>
      {open && (
        <section
          id={panelId}
          aria-label="What the claim types mean"
          className="mt-2 rounded-xl border border-hairline bg-surface-2 px-4 py-3 text-sm"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="font-medium text-ink">
              {tipShowing ? 'Before you start: the claim type decides who pays for a line.' : 'The claim type decides who pays for a line.'}
            </p>
            {!tipShowing && (
              <button
                type="button"
                className={cx(btnGhost, btnSmall, '-mr-2 -mt-1 px-1.5')}
                aria-label="Close the explanation"
                onClick={() => setOpen(false)}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
          <dl className="mt-2 space-y-1.5">
            {rows.map((row) => (
              <div key={row.key} className="flex gap-2">
                {row.glyph}
                <div className="min-w-0">
                  <dt className="inline font-medium text-ink">{row.label}: </dt>
                  <dd className="inline text-ink-2">{row.effect}</dd>
                </div>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-ink-2">
            <span className="font-medium text-ink">Example: </span>
            {`${symbol}20 of ${first(names.primary)}'s on ${first(names.secondary)}'s card is "${claimTypeLabel('primary_personal', names)}": ${first(names.primary)} pays ${first(names.secondary)} back ${symbol}20. On ${first(names.primary)}'s own card, Personal and "${claimTypeLabel('primary_personal', names)}" come to the same thing.`}
          </p>
          <p className="mt-1 text-xs text-ink-3">Hover over a claim type on any line to see exactly what it does there.</p>
          {tipShowing && (
            <div className="mt-3">
              <button type="button" className={cx(btnSecondary, btnSmall)} onClick={dismissTip}>
                Got it
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
