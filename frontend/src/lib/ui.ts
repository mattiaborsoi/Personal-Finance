/** Shared Tailwind class strings so components stay small and consistent.
 *
 * Everything here uses design tokens (see src/index.css), so it renders correctly
 * in light and dark mode without per-component `dark:` variants.
 */

export const focusRing =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

export const btnBase = `inline-flex items-center justify-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

export const btnPrimary = `${btnBase} border-brand bg-brand text-white shadow-sm hover:border-brand-strong hover:bg-brand-strong`;
export const btnSecondary = `${btnBase} border-hairline bg-surface text-ink shadow-card hover:border-hairline-strong hover:bg-surface-2`;
/** Destructive actions are quiet until hovered; the confirm step carries the weight. */
export const btnDanger = `${btnBase} border-transparent bg-critical/10 text-critical-ink hover:bg-critical/20`;
export const btnGhost = `${btnBase} border-transparent bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink`;
export const btnSmall = 'px-2.5 py-1.5 text-xs';
export const btnIcon = `inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

const controlBase = `rounded-lg border border-hairline bg-surface text-ink transition-colors placeholder:text-ink-3 hover:border-hairline-strong disabled:bg-surface-2 disabled:text-ink-3 ${focusRing}`;
export const inputBase = `block w-full px-3 py-2 text-sm ${controlBase}`;
export const selectBase = `${inputBase} cursor-pointer pr-8`;
/** 32px select for inline row editing (matches `btnSmall` buttons and `btnIcon`); set its width explicitly. */
export const selectCompact = `block h-8 cursor-pointer py-1 pl-2.5 pr-7 text-xs ${controlBase}`;
/** 44px inputs for the mobile-first claim form. */
export const inputTall = 'min-h-[44px] text-base';
export const checkboxBase = `h-4 w-4 cursor-pointer rounded border-hairline-strong bg-surface accent-brand ${focusRing}`;
export const radioBase = `h-4 w-4 cursor-pointer border-hairline-strong bg-surface accent-brand ${focusRing}`;

export const labelBase = 'block text-sm font-medium text-ink-2';
export const eyebrow = 'text-2xs font-semibold uppercase text-ink-3';
export const linkBase = `rounded font-medium text-brand hover:text-brand-strong hover:underline ${focusRing}`;
export const cardBase = 'rounded-2xl border border-hairline bg-surface p-5 shadow-card sm:p-6';
export const cardInset = 'rounded-xl bg-surface-2 px-4 py-3';
export const chip =
  'inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-2.5 py-1 text-xs font-medium text-ink-2';
/** Quieter chip for metadata inside rows (account labels, sources). */
export const chipSoft =
  'inline-flex max-w-full items-center gap-1 truncate rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium leading-4 text-ink-2';

/** Inside `<Modal>`: the scrolling middle of a dialog form, and its pinned footer of buttons. */
export const dialogBody = 'min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6';
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
