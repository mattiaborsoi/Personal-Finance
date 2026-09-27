# Settl — design system

The UI is a **product**, not an admin panel: calm, warm-neutral surfaces, one
brand blue, three view accents, generous whitespace, a single typeface, and
figures that read at a glance. Everything is token-driven so light and dark
mode share one set of components.

## Tokens (`src/index.css`, exposed through `tailwind.config.js`)

| Tailwind class family | Role |
|---|---|
| `bg-bg` | page plane (warm off-white / near-black) |
| `bg-surface`, `bg-surface-2`, `bg-surface-3` | cards; inset tiles & hover washes; pressed/selected washes |
| `text-ink`, `text-ink-2`, `text-ink-3` | primary, secondary, muted text (axis labels, eyebrows, placeholders) |
| `border-hairline`, `border-hairline-strong`, `divide-hairline` | 1px rules; stronger for inputs on hover |
| `bg-brand`, `bg-brand-strong`, `bg-brand-soft`, `text-brand`, `text-brand-strong` | the one action colour (primary buttons, links, active nav) |
| `bg-accent-macro` / `-micro` / `-liquidity` (+ `text-…`, `/10` washes) | identity of the three dashboard views only (blue / orange / aqua, CVD-validated) |
| `text-good-ink`, `bg-good/10`, `text-warning-ink`, `bg-warning/15`, `text-critical-ink`, `bg-critical/10` | status: money in, pending/caution, money out & destructive |
| `shadow-card`, `shadow-pop` | resting card; floating tooltip/menu |

Rules:

* **Never use raw palette classes** (`slate-*`, `blue-*`, `rose-*`, `emerald-*`,
  `amber-*`, `violet-*`, `gray-*`, `bg-white`, `text-black`). Map them:
  `slate-50/100` → `surface-2`, `slate-200` → `hairline`, `slate-300` → `hairline-strong`,
  `slate-400/500` → `ink-3`, `slate-600/700` → `ink-2`, `slate-800/900` → `ink`,
  `white` → `surface`, `brand-*`/`blue-*` → `brand`, `emerald` → `good`, `rose` → `critical`,
  `amber` → `warning`, `violet` (LLM badge) → `accent-micro`.
* Text never wears an accent colour for emphasis; a coloured **dot, bar or icon
  beside** the text carries identity. Money in/out uses the status inks via
  `moneyTone` only where the sign matters (net figures, amounts in lists).
* Status is never colour alone: pair it with an icon or a label.

## Type & numbers

* Inter Variable everywhere (`font-sans`); no display or serif face.
* Hero figure (one per view): `text-5xl font-semibold tracking-tight`, **proportional
  figures** (no `tabular`). Columns of numbers and axis ticks: `.tabular`.
* Eyebrow labels: `eyebrow` from `src/lib/ui.ts` (11px, uppercase, `ink-3`).
* Page title: `text-2xl font-semibold tracking-tight`; card title: `text-base font-semibold`.

## Shape & depth

* Cards `rounded-2xl border-hairline shadow-card` (`cardBase`), inset tiles
  `cardInset` (`rounded-xl bg-surface-2`), controls `rounded-lg`, pills `rounded-full`.
* Depth comes from surface steps and hairlines, not heavy shadows. Dark mode uses
  a 1px light ring instead of a shadow (handled by the token).
* Spacing: sections `space-y-6`, card grids `gap-4`, inside cards `gap-3`/`gap-4`.

## Components (`src/lib/ui.ts` primitives)

* Buttons: `btnPrimary` (brand), `btnSecondary` (surface + hairline), `btnGhost`,
  `btnDanger` (quiet `critical/10` wash — destructive actions are calm until the
  inline confirm step), `btnIcon` (32px square, icon only, needs `aria-label`),
  `btnSmall` modifier.
* Inputs/selects: `inputBase` / `selectBase`; labels `labelBase`; checkboxes `checkboxBase`.
* Tables: `tableBase`, `thBase`, `tdBase`, `trHover`; wrap in `<Card flush>` for edge-to-edge.
* `Badge` (tones map to tokens; `dot` shows a colour dot), `Card` (`accentClass`
  draws a 4px accent stripe; `flush` removes padding; `icon` shows a soft 32px
  square before the title), `BrandMark`/`Wordmark`, `ThemeToggle`, `NavLinks` (Lucide icons).
* Rows and lists: `MerchantAvatar` (32px circle, first letter, one of six soft
  washes chosen by a stable hash of the name), `InitialsChip` (a person), `chipSoft`
  for account labels inside rows, `selectCompact` (32px row select; add
  `selectCategory` for a category select, which sizes to its longest option and
  carries the full name in a `title`), `TransferToggle` (the "mark as a transfer"
  checkbox, named after the merchant for screen readers), `tableFlush`
  so first/last cells line up with the header inside `<Card flush>`.
* Row controls with a short visible label ("Approve", "Delete") name the row for
  screen readers via `aria-label` ("Approve Waitrose"), as the selects already do.
* Messages: `Notice` (neutral/good/warning/critical wash + icon; closed-period
  notes, confirmations), `ErrorMessage` (critical, with Retry/Dismiss),
  `EmptyState` (icon circle, title, hint, action), `LoadingState` (inline
  spinner or a `rows` skeleton that holds the space), `StatTile` (label over a
  figure; `raised` when it sits on a wash), `ConfirmButton` (inline Confirm ·
  Cancel pair; `iconOnly` for row deletes; `ariaLabel` names the row), and
  `ConfirmPrompt`, the same Confirm · Cancel step on its own for a form whose
  first step is its submit button (the claim form's "That is £1,500.00. Log it?").
* Icons: `lucide-react`, 16px (`h-4 w-4`) inline, 20px in feature tiles, always
  `aria-hidden` next to a visible label.

## Data visualisation (dashboard)

Follows the data-viz method: single-series area chart with a 2px line, ~10 %
wash, hairline solid grid, crosshair tooltip with the value leading, no legend for
one series, end value labelled; category bars ≤ 8px thick with a rounded data-end
on a `surface-3` track; the active view's accent colours the marks, never the text.

## Voice

British English, sentence case, friendly and specific ("Secondary owes Primary
£53.40", "Settle by 1 Sep 2026", "No claims logged for September yet").
