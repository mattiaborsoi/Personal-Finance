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
| `border-hairline`, `border-hairline-strong`, `divide-hairline` | 1px rules between things; never the only edge of a form control |
| `border-control` | the edge of inputs, selects, checkboxes and radios: 3:1 against a card in both modes, so a field is visible without relying on its fill |
| `bg-brand`, `bg-brand-strong`, `bg-brand-soft`, `text-brand`, `text-brand-strong` | the one action colour (primary buttons, links, active nav); 5.2:1 as text on a card in light mode, 4.8:1 in dark |
| `text-on-brand` | text on a brand fill: white in light mode, near-black on the lighter dark-mode blue (never `text-white`) |
| `bg-accent-macro` / `-micro` / `-liquidity` (+ `text-…`, `/10` washes) | identity of the three dashboard views only (blue / orange / aqua, CVD-validated) |
| `text-good-ink`, `bg-good/10`, `text-warning-ink`, `bg-warning/15`, `text-critical-ink`, `bg-critical/10` | status: money in, pending/caution, money out & destructive |
| `shadow-card`, `shadow-pop` | resting card; floating tooltip/menu |

Rules:

* **Never use raw palette classes** (`slate-*`, `blue-*`, `rose-*`, `emerald-*`,
  `amber-*`, `violet-*`, `gray-*`, `bg-white`, `text-black`). Map them:
  `slate-50/100` → `surface-2`, `slate-200` → `hairline`, `slate-300` → `hairline-strong`,
  `slate-400/500` → `ink-3`, `slate-600/700` → `ink-2`, `slate-800/900` → `ink`,
  `white` → `surface`, `text-white` on a brand fill → `text-on-brand`, `brand-*`/`blue-*` → `brand`,
  `emerald` → `good`, `rose` → `critical`, `amber` → `warning`, `violet` (LLM badge) → `accent-micro`.
* Contrast is checked, not guessed: every text token clears WCAG AA (4.5:1) on the
  surfaces it is used on, in both modes (`ink-3` hints included), and control edges
  clear 3:1. `.animate-rise` and `animate-pulse` switch off under
  `prefers-reduced-motion`; spinners stay.
* Text never wears an accent colour for emphasis; a coloured **dot, bar or icon
  beside** the text carries identity. Money in/out uses the status inks via
  `moneyTone` only where the sign matters (net figures, amounts in lists).
* Status is never colour alone: pair it with an icon or a label.

## Type & numbers

* Inter Variable everywhere (`font-sans`); no display or serif face.
* Hero figure (one per view): `text-[2.75rem] sm:text-5xl font-semibold leading-none
  tracking-tight`, **proportional figures** (no `tabular`). Columns of numbers and
  axis ticks: `.tabular`.
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
  `btnIconSmall` (24px, inline with a line of text, e.g. the rename pencil beside a
  merchant), `btnSmall` modifier.
* Inputs/selects: `inputBase` / `selectBase` (add `inputTall` for the 44px mobile claim
  form; `inputCompact` is the 32px field for editing a value in place inside a row); labels `labelBase`; checkboxes `checkboxBase`; radios `radioBase`; text links
  `linkBase`; any custom control includes `focusRing` (the shared focus-visible ring);
  `inputInvalid` on a control whose value cannot be sent, always with `aria-invalid`.
* Forms: `Field` (label over a control; `help` under it gives way to a `problem`;
  `readout`/`aside` sit beside the label; `fieldNoteId(id)` is the note's id for the
  control's `aria-describedby`) and `RadioOption` (a radio with a bold label and a
  one-line hint that is its accessible description). A settings form keeps the
  saved document and the form apart, builds the PUT body from only the fields that
  differ, and enables Save whenever there is a change to send or a problem to point
  at: pressing it with a problem moves focus to the first invalid control rather
  than sending anything, and it shows a spinner while the request runs. Discard is
  enabled whenever the form differs at all, an edit that cannot be sent included.
  A form with unsaved edits asks before the tab changes or the page unloads
  (`useUnsavedChanges`). A 422 that names a field is shown as that field's `problem` (or beside
  its row, on the control it is about, which points at it with `aria-describedby`),
  anything else as an `ErrorMessage`, and a `Notice tone="good" role="status"`
  confirms the save. A document with `stored: false` gets `CONFIG_DEFAULTS_MESSAGE`
  as a neutral `Notice` above its cards. A save that changes what `GET /api/config`
  describes calls `useReloadConfig()` afterwards, and a failed reload is its own
  `ErrorMessage` ("Saved, but …"), never a failed save.
* Tables: `tableBase`, `thBase`, `tdBase`, `trHover`; wrap in `<Card flush>` for edge-to-edge.
* `Badge` (tones map to tokens; `dot` shows a colour dot), `Card` (`accentClass`
  draws a 4px accent stripe; `flush` removes padding; `icon` shows a soft 32px
  square before the title), `BrandMark`/`Wordmark`, `ThemeToggle`, `NavLinks` (Lucide icons).
* Rows and lists: `MerchantAvatar` (32px circle, first letter, one of six soft
  washes chosen by a stable hash of the name), `InitialsChip` (a person), `chipSoft`
  for account labels inside rows, `selectCompact` (32px row select), `TransferToggle` (the "mark as a transfer"
  checkbox, named after the merchant for screen readers), `tableFlush`
  so first/last cells line up with the header inside `<Card flush>`.
* Categories: shown as "Group › Name" (`categoryLabel`), with the group's emoji
  first where it has one (`categoryEmojiLabel`, from `config.category_emojis`).
  Every category control is a `CategoryPicker`, never a native select: a button that
  reads like `selectCompact` (or a full-size field with `size="base"`), named like the
  select was ("Category for Ocado"), opening a popover (portalled, fixed, flips up when
  there is no room below, 20rem at most) with a search box (WAI-ARIA combobox) over a
  grouped listbox: "Suggested" (the merchant's past categories) and "Most used" first,
  then each group under an emoji header, Uncategorised last. Typing filters ("hou mor"
  finds Housing › Mortgage); the primary user can add a category from the search text
  ("Add “Takeaway” under Dining"), unless the parent passes `allowAdd={false}`. Escape
  closes it and only it, returning focus to the button. The one native category select
  left, the Transactions filter, uses an `optgroup` per group labelled "emoji Group".
* Claim types: `ClaimTypeControl`, a segmented radio group ("Claim type for Ocado";
  one tab stop, arrow keys, Home and End move and choose). Each segment is an icon
  (Wallet personal, Scale by income, Divide 50/50, User / UserRound per person) named
  and titled with the full label; the chosen one adds its short word ("By income",
  "50/50", a first name, or "Mine" for the viewer's own) on a phone and from `2xl`, so a
  row still fits a 1280px laptop with icons only.
  The person segments show that person's initial rather than an icon. Each segment's
  tooltip and accessible description say what it does on that line's card
  (`claimTypeEffect` with `claimContextForAccount`), e.g. "Only Alex's, but Sam paid.
  Alex pays Sam back in full."
* Claim-type colours (`claim-*` tokens, `lib/claimTones.ts`): grey personal, blue by
  income, teal 50/50, violet for the primary's items, amber for the secondary's. Only
  the chosen segment wears its colour (soft fill, text in the colour, inset ring), so
  it reads at a glance; the explainer's legend uses the same colours. Text is 5.5:1 or
  better on each fill in both themes.
* Explaining a choice: `ClaimTypeHelp` is a quiet "What do … mean?" toggle that opens
  an inline panel, never a modal. With a `tipKey` it opens by itself once per browser
  as a first-use tip with a "Got it" (stored under `settl.tip.<key>`, and tolerant of
  storage being unavailable).
* Row controls with a short visible label ("Approve", "Delete") name the row for
  screen readers via `aria-label` ("Approve Waitrose"), as the selects already do.
* Renaming in place: a `btnIconSmall` pencil ("Rename Waitrose") swaps the name for an
  `inputCompact` field pre-filled with it; Enter or blur saves a changed, non-blank
  value through the row's own PATCH (its errors show under the row), Escape cancels,
  and focus returns to the pencil after Enter or Escape.
* Skip link: `Layout` opens with a `skipLink` "Skip to content" link to
  `<main id="main" tabIndex={-1}>`, hidden until focused. The sticky mobile top bar
  is cleared for keyboard focus by `scroll-padding-top` in `index.css`, not by
  `scroll-mt-*` on individual targets.
* Navigation counts: a nav item may carry a small `warning/15` count pill (the lines
  waiting on Review) with the count spelt out for screen readers ("Review (12
  pending)"). It comes from one request in `Layout` that pages keep current by sharing
  what they load (`useSharePeriods`) or asking once after a change
  (`useRefreshReviewBadge`); never poll for it.
* Navigation (`NavLinks`): three labelled groups (`eyebrow` labels, each a `<ul
  aria-labelledby>`): Money (Dashboard; Transactions with Review, Upload statement
  and Transfers under it), Partner (Claims with Log a claim) and Setup (Merchant
  memory, Settings). Children are text-only, always shown, and indented on a
  `hairline` guide line under the parent's icon; the open child gets a 2px brand
  stretch of that line and `aria-current="page"`, its parent `aria-current="true"`
  and a brand icon. Items a role cannot see drop out, and a child whose parent is
  hidden stands on its own with its icon (the partner sees only Log a claim, with
  no group labels). The phone menu renders the same component.
* Logo (`BrandMark`): an S drawn as two hooked halves (white and peach `#ffb088`)
  meeting on a `bg-brand` tile, rx 8 on a 32 grid: two people, one balance. Never
  recolour the halves or drop the tile; the `Wordmark` sets "Settl" at 17px
  semibold, -0.02em. `public/` holds the favicons rendered from the same drawing
  (light-mode blue `#226cc8`; full-bleed and padded for the Apple and maskable icons).
* Messages: `Notice` (neutral/good/warning/critical wash + icon; closed-period
  notes, confirmations; as an inline `role="alertdialog"` confirmation it names its
  message with `messageId` + `aria-describedby`, takes focus on its safe choice when
  it appears and hands it back to the trigger on Cancel), `ErrorMessage` (critical, with Retry/Dismiss),
  `EmptyState` (icon circle, title, hint, action), `LoadingState` (inline
  spinner or a `rows` skeleton that holds the space), `StatTile` (label over a
  figure; `surface="raised"` when it sits on a wash, `inset` by default;
  `as="dl-item"` inside a `<dl>`), `ConfirmButton` (inline Confirm ·
  Cancel pair; `iconOnly` for row deletes; `ariaLabel` names the row), and
  `ConfirmPrompt` (exported from `ConfirmButton.tsx`), the same Confirm · Cancel
  step on its own for a form whose first step is its submit button (the claim
  form's "That is £1,500.00. Log it?").
* Danger zone: irreversible, whole-installation actions sit in a last card titled
  "Danger zone" (`accentClass="bg-critical"`, a `TriangleAlert` icon) with quiet
  `btnDanger` openers. Each opens an inline panel that lists what goes and what stays,
  then asks for a typed phrase ("DELETE TRANSACTIONS"); Confirm is enabled only when
  the phrase matches exactly, and a server refusal shows inside the panel. A result
  that ends on another page travels there as location state (`noticeState` in
  `src/lib/navNotice.ts`) and is shown as a dismissible `Notice tone="good"`.
* Dialogs and tabs: `Modal` (portal, backdrop, labelled `role="dialog"`, focus
  trap, Escape to close, focus returned to the opener; `busy` locks closing while a
  request is in flight; `size` `md` for a form, `lg` for a wide row editor); build
  its form from `dialogBody` (the scrolling body) and `dialogFooter` (the actions).
  `Tabs` (roving focus with the arrow keys, Home and End; the caller owns the
  active id and renders the panel), as on the Settings page.
* Settlement is a running balance, not a month on its own. The banner's headline is
  what is outstanding at the end of the month (`balanceHeadline` of `balance_out`,
  labelled "Outstanding at end of March 2026"), never the month's gross; one line under
  it gives the working in words ("Carried in £266.50 owed by Sam · this month £45.90
  owed by Sam · Sam paid £100.00", plus "adjusted …" when there are adjustments). The
  working panel lists Carried in, This month (the four sums, lines behind `?lines=open`),
  Payments (ledger transfers and payments recorded by hand), Adjustments and Outstanding;
  its signed figures are always the change to what the secondary owes. An agreed balance
  (checkpoint) shows as a "Balance set on …" chip and replaces the sum; drift since then is
  a warning `Notice` with "Set it again", and a month before a later checkpoint gets a
  neutral "history, not carried forward" `Notice`. "Record a payment" and "Set the
  balance" are primary-only `Modal` forms; a hand-recorded payment that matches an
  approved ledger payment within 7 days gets a non-blocking warning. The partner's tile
  (`SettlementNetLine`) speaks from the viewer's side ("You owe Alex £312.40") with the
  month so far underneath.
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
