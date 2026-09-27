/** Shared Tailwind class strings so components stay small and consistent.
 *
 * Everything here uses design tokens (see src/index.css), so it renders correctly
 * in light and dark mode without per-component `dark:` variants.
 */

export const focusRing =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

export const btnBase = `inline-flex items-center justify-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

export const btnPrimary = `${btnBase} border-brand bg-brand text-on-brand shadow-sm hover:border-brand-strong hover:bg-brand-strong`;
export const btnSecondary = `${btnBase} border-hairline bg-surface text-ink shadow-card hover:border-hairline-strong hover:bg-surface-2`;
/** Destructive actions are quiet until hovered; the confirm step carries the weight. */
export const btnDanger = `${btnBase} border-transparent bg-critical/10 text-critical-ink hover:bg-critical/20`;
export const btnGhost = `${btnBase} border-transparent bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink`;
export const btnSmall = 'px-2.5 py-1.5 text-xs';
export const btnIcon = `inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
/** 24px icon button that sits inline with a line of text (the rename pencil beside a merchant name); needs `aria-label`. */
export const btnIconSmall = `inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-transparent text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

/** Controls carry a `border-control` edge (3:1 against the card) so the field is visible without relying on its background. */
const controlBase = `rounded-lg border border-control bg-surface text-ink transition-colors placeholder:text-ink-3 hover:border-ink-3 disabled:bg-surface-2 disabled:text-ink-3 ${focusRing}`;
export const inputBase = `block w-full px-3 py-2 text-sm ${controlBase}`;
export const selectBase = `${inputBase} cursor-pointer pr-8`;
/** Added to a control whose value cannot be sent; pair it with `aria-invalid`. */
export const inputInvalid = 'border-critical hover:border-critical';
/** 32px select for inline row editing (matches `btnSmall` buttons and `btnIcon`); set its width explicitly. */
export const selectCompact = `block h-8 cursor-pointer py-1 pl-2.5 pr-7 text-xs ${controlBase}`;
/** 32px text input for editing a value in place inside a row (a merchant name); set its width explicitly. */
export const inputCompact = `block h-8 px-2.5 py-1 text-sm ${controlBase}`;
/**
 * Width for a row's category select: as wide as its longest option (so
 * "Subscriptions:Software" is not clipped), never narrower than the claim-type
 * select's neighbour column looks right beside, and capped so one very long
 * name cannot push the table out; pair it with a `title` carrying the full name.
 */
export const selectCategory = 'w-auto min-w-[11rem] max-w-[18rem]';
/** 44px inputs for the mobile-first claim form. */
export const inputTall = 'min-h-[44px] text-base';
export const checkboxBase = `h-4 w-4 cursor-pointer rounded border-control bg-surface accent-brand ${focusRing}`;
export const radioBase = `h-4 w-4 cursor-pointer border-control bg-surface accent-brand ${focusRing}`;

export const labelBase = 'block text-sm font-medium text-ink-2';
export const eyebrow = 'text-2xs font-semibold uppercase text-ink-3';
/** "Skip to content": hidden until focused, then pinned top-left above the chrome; targets `<main id="main">`. */
export const skipLink = `sr-only rounded-lg bg-surface px-3 py-2 text-sm font-medium text-ink shadow-pop focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 ${focusRing}`;
export const linkBase = `rounded font-medium text-brand hover:text-brand-strong hover:underline ${focusRing}`;
export const cardBase = 'rounded-2xl border border-hairline bg-surface p-5 shadow-card sm:p-6';
export const cardInset = 'rounded-xl bg-surface-2 px-4 py-3';
export const chip =
  'inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-2.5 py-1 text-xs font-medium text-ink-2';
/** Quieter chip for metadata inside rows (account labels, sources). */
export const chipSoft =
  'inline-flex max-w-full items-center gap-1 truncate rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium leading-4 text-ink-2';

/** Inside `<Modal>`: the scrolling middle of a dialog form, and its pinned footer of buttons. */
export const dialogBody = 'min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6';
export const dialogFooter = 'flex flex-wrap items-center justify-end gap-2 border-t border-hairline px-5 py-4 sm:px-6';

export const tableBase = 'min-w-full divide-y divide-hairline text-sm';
/** Inside `<Card flush>`: first/last cells pick up the card's horizontal padding so columns align with the header. */
export const tableFlush =
  '[&_td:first-child]:pl-5 [&_th:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:last-child]:pr-5 sm:[&_td:first-child]:pl-6 sm:[&_th:first-child]:pl-6 sm:[&_td:last-child]:pr-6 sm:[&_th:last-child]:pr-6';
export const thBase = 'px-3 py-2.5 text-left text-2xs font-semibold uppercase text-ink-3';
export const tdBase = 'px-3 py-3 align-top text-ink';
export const trHover = 'transition-colors hover:bg-surface-2/60';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** The id of the note under a `<Field>` (its help or its problem), for the control's `aria-describedby`. */
export function fieldNoteId(id: string): string {
  return `${id}-help`;
}
