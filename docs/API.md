# REST API contract

All routes are prefixed with `/api`. JSON in, JSON out. Money is serialised as a
decimal string (e.g. `"-45.90"`); dates as `YYYY-MM-DD`; periods as `YYYY-MM`.
Sign convention everywhere: **negative = money out, positive = money in**.

## Authentication

`POST /api/auth/login` `{ "password": "..." }` → `{ token, role, user_id, display_name }`

Send `Authorization: Bearer <token>` on every other request. Tokens expire after 30 days and
are invalidated when the role's password changes. After 5 wrong passwords from one address
the login endpoint answers **429** (with `Retry-After`) for 1 minute, doubling on repeats.

| role        | may call                                                                                                   |
|-------------|------------------------------------------------------------------------------------------------------------|
| `primary`   | everything                                                                                                 |
| `secondary` | `GET /auth/me`, `GET /config`, `GET/POST /claims`, `DELETE /claims/{id}` (own, unsettled), `GET /settlement/{p}` |

`GET /api/auth/me` → `{ role, user_id, display_name }`

## Reference

`GET /api/config` → sanitised config for the UI:
```json
{
  "base_currency": "GBP", "currency_symbol": "£",
  "users": { "primary": {"id","display_name"}, "secondary": {"id","display_name"} },
  "split": { "strategy", "primary_ratio", "secondary_ratio", "rounding_decimals", "settlement_day_of_month" },
  "accounts": [ {"id","institution","label","account_type","owner","identifier_last4","default_claim_type","billed_to","is_active"} ],
  "categories": ["Bills:Water", "..."],
  "category_emojis": { "Bills": "🧾", "Groceries": "🛒", "...": "..." },
  "claim_types": ["personal","shared_proportional","shared_equal","secondary_personal","primary_personal"]
}
```
`label` is the optional display name set under Settings → Accounts (`null` when unset; the UI then shows institution and account type). `billed_to` here is the resolved payer, never `null`: the account's own `billed_to`, else the primary user for a `credit_supplementary` card, else the owner (unlike `AccountOut.billed_to`, which is `null` when unset). Archived accounts are included with `is_active: false`. `category_emojis` maps each category group (the part of a name before the first `:`; an ungrouped name is its own group) to its emoji: the effective map of Settings → Categories, only for groups in `categories`, and leaving out groups without one.

## Accounts (Settings → Accounts)

Accounts live in the database. `config.yaml` seeds them the first time Settl starts with an empty `accounts` table; after that these endpoints are the only way they change. Every other endpoint sees the current rows (the "effective" configuration), so a card added here is mapped by its digits on the next upload and its `billed_to` rule is used by the settlement.

AccountOut: `id, institution, label, account_type, owner_user_id, identifier_last4, default_claim_type, billed_to, is_active, transaction_count, created_at`

`GET /api/accounts` → `[AccountOut]` (archived included; active first, then in creation order)

`POST /api/accounts` `{ id?, institution, label?, account_type, owner, identifier_last4, default_claim_type?, billed_to? }` → **201** AccountOut. `id` is generated (`acc_<institution>_<type>_<last4>`) when omitted; if given it must be 2–64 lowercase letters, digits, `_` or `-`. **422** for an unknown `owner`/`billed_to`, blank fields, or another active account at the same institution with the same digits (a main card and its supplementary card are allowed to share digits); **409** when the `id` exists.

`PATCH /api/accounts/{id}` `{ institution?, label?, account_type?, owner?, identifier_last4?, default_claim_type?, billed_to?, is_active? }` → AccountOut. Omitted fields are untouched; `null` clears `label` / `billed_to`. `is_active: false` archives the account: it keeps its history but is no longer offered for uploads. **404** for an unknown id; **422** under the same rules as `POST` (unknown `owner`/`billed_to`, blank `institution`/`identifier_last4`, and, whenever the account is active after the change, another active account at the same institution with the same digits).

`DELETE /api/accounts/{id}` → 204. **404** for an unknown id; **409** when the account has transactions or uploads (archive it instead), or a rule (Settings → Rules) sends transfers to it.

## AI (Settings → AI)

Which proxy and models Settl uses, and the thresholds behind them. Defaults come from `config.yaml` (`llm`, `auditor`) and `.env` (`LLM_PROVIDER`, `EMBEDDING_PROVIDER`, `LITELLM_URL`); a saved document overrides them and applies to the next request, no restart needed. Provider API keys never pass through this API.

`GET /api/ai` →
```json
{
  "enabled": true,
  "embedding_provider": "litellm",
  "models": { "chat": "default-chat", "extraction": "default-chat", "audit": "default-chat", "embedding": "default-embedding" },
  "thresholds": { "similarity_threshold": 0.82, "top_k": 3, "deviation_threshold": 0.15, "lookback_periods": 3 },
  "proxy": { "mode": "bundled", "url": "http://litellm:4000", "bundled_url": "http://litellm:4000", "env_url": null, "reachable": true, "has_key": true },
  "available_models": [ { "name": "cheap-chat", "mode": "chat", "provider": "Anthropic", "model": "claude-haiku-4-5" } ],
  "memory_rows": 8,
  "stored": false
}
```
`models.chat` categorises transactions, `extraction` reads PDFs the parsers cannot, `audit` writes the monthly summary, `embedding` turns merchants into vectors (`embedding_provider: "hash"` = offline, no AI). `available_models` is what the selected LiteLLM proxy lists (`/model/info`, falling back to `/v1/models`), cached for a minute; `proxy.mode` is `bundled` (Settl's own LiteLLM container: `bundled_url` with `LITELLM_MASTER_KEY`) or `external` (a LiteLLM you already run, at `proxy.url` with a key stored server-side and never returned; `env_url` is what `LITELLM_URL` in `.env` offers for it, and when that is set `external` is the default mode with that URL and `LITELLM_API_KEY`). `stored: false` means nothing has been saved yet.

`PUT /api/ai` body: any subset of `{ enabled, embedding_provider, models: {chat?, extraction?, audit?, embedding?}, thresholds: {...}, proxy: {mode?, url?, api_key?}, clear_memory }` → the same body as `GET`. A blank or omitted `api_key` keeps the stored one. **422** for out-of-range thresholds (similarity 0.5–0.99, top_k 1–10, deviation 0.05–1.0, look-back 1–12), a model the proxy does not list or lists with the wrong kind (only checked when the proxy answers with a model list; with the proxy unreachable or listing nothing, the names are saved as typed), or `mode: external` without an `http(s)://` URL. **409** when the embedding model or provider changes while `memory_rows > 0` and `clear_memory` is not `true`: the stored vectors would no longer be comparable; with `clear_memory: true` the merchant memory is emptied and the change saved.

`POST /api/ai/test` body: the same shape as `PUT` (the values on the form, saved or not) → `{ "chat": {ok, ms, model, error} | null, "extraction": ..., "audit": ..., "embedding": {ok, ms, model, dimensions, error} }`. Each chat job is one tiny completion; the embedding test also checks the vector has the schema's 1536 dimensions. `null` for a job that is switched off; never a 5xx.

## Household, categories and rules (Settings → Household / Categories / Rules)

Primary login only. Each is one `app_settings` document; `config.yaml` (or the built-in defaults without it) supplies the values until one is saved, and `stored: false` says nothing has been saved yet. A save applies to the next request. Every save is validated like the file (and against the full configuration), with **422** and a message naming the field.

`GET /api/settings/household` →
```json
{
  "users": { "primary": {"id","display_name","base_salary_pa","additional_income_pa"}, "secondary": {...} },
  "split_strategy": "salary_proportional", "rounding_decimals": 2, "settlement_day_of_month": 1,
  "base_currency": "GBP", "currency_symbol": "£",
  "primary_ratio": 0.555556, "secondary_ratio": 0.444444, "stored": false
}
```
`PUT /api/settings/household` body: any subset of the above without `id`s, ratios or `stored` (nested `users.primary` / `users.secondary` fields are merged) → the same body. The user `id`s come from `config.yaml` (or the built-in defaults) and never change. **422** for an empty or over-long (64) display name, a negative income, a `split_strategy` other than `salary_proportional` / `equal_50_50`, `salary_proportional` with no combined income, `rounding_decimals` outside 0–6, `settlement_day_of_month` outside 1–28, a `base_currency` that is not three letters or a `currency_symbol` that is not 1 to 3 characters.

`GET /api/settings/categories` →
```json
{
  "categories": [ {"name": "Bills:Water", "in_use": {"transactions": 0, "memory": 0, "rules": 1}} ],
  "emojis": { "Bills": "🧾", "Coffee": "", "Pets": "🐾" },
  "stored": false
}
```
`categories` is in menu order; `in_use` counts matches ignoring case, split parts included. `emojis` is the effective group → emoji map (a group is the part of a name before the first `:`; `Groceries` is its own group): the saved value, else the built-in default, only for groups in the list. `""` marks a group whose default was removed; a group with neither a saved value nor a default is absent. The defaults: Bills 🧾, Housing 🏠, Insurance 🛡️, Groceries 🛒, Dining 🍽️, Coffee ☕, Entertainment 🎬, Subscriptions 🔁, Health 🩺, Transport 🚆, Travel ✈️, Shopping 🛍️, Personal 💆, Education 🎓, Income 💷, Fees 🏦, Cash 💵, Transfers 🔄, Uncategorized ❔ (`category_emojis` in `config.yaml` replaces them).

`PUT /api/settings/categories` `{ "categories"?: ["Bills:Water", "..."], "emojis"?: {"Pets": "🐾", "Coffee": ""} }` → the same body. `categories` replaces the list (adding, removing, reordering); `emojis` replaces the saved map (`{}`: no custom emojis, the defaults apply; `""`: no emoji for that group, even over a default). A field left out keeps its saved value. Group keys are matched ignoring case against the groups of the submitted list (or the current one when `categories` is left out) and values are trimmed. Emojis of groups no longer in the list are dropped, on save and on read. **422** for a blank, over-long (128) or repeated name; **422** naming the group (`emoji for 'Pets': ...`) for a key that is not a group of the list, a key given twice, or a value that is not `""` or 1 to 8 characters that are not all letters or digits (an emoji or a short symbol; whitespace alone is refused); **409** `category 'X' is still used by N transactions, N remembered merchants and N rules` when a removed category is in use.

`POST /api/settings/categories/rename` `{ "from": "Food:Takeaway", "to": "Food:Delivery" }` → the categories body. Renames it in the list, on every transaction, in merchant memory and in the rules, in one transaction. When the rename moves a group's only category into a group not listed before (`Education` → `Learning`), the group's emoji goes with it. **404** when `from` is not in the list; **409** for `Uncategorized` or a `to` that already exists; **422** for blank or over-long names.

`GET /api/categories/suggestions?merchant=Corner%20Cafe&limit=3` (primary only) → what the category picker offers first:
```json
{
  "merchant": [ {"category": "Dining", "count": 4} ],
  "frequent": [ {"category": "Groceries", "count": 31} ]
}
```
`merchant`: the categories this merchant was filed under before, from approved transactions (`auto_approved` or `manual_approved`) whose `cleaned_merchant` matches ignoring case and surrounding spaces; split parents are skipped and their parts counted. A merchant-memory entry whose `normalized_merchant` matches adds its category with a count of at least 1. Ranked by count, then by the most recent use (transaction date or memory update). `frequent`: the categories of approved transactions (split parts instead of parents) dated within the last 12 months, most used first. Both leave out `Uncategorized` and categories no longer in the taxonomy and hold at most `limit` (1–10, default 3) items. **422** when `merchant` is missing or blank or `limit` is out of range; **403** for the secondary user.

`GET /api/settings/rules` → `{ "rules": [ {pattern, category, claim_type, merchant, subcategory, is_internal_transfer, transfer_to_account, amount_min, amount_max} ], "payment_patterns": ["..."], "match_window_days": 7, "amount_tolerance": "0.01", "stored" }`; rules are tried in list order, first match wins. `amount_min` / `amount_max` are money strings (`"40.00"`) or `null`: inclusive bounds on the line's absolute amount, either side open when `null`. A rule with either bound only matches a line whose amount is known and inside them, so a caller with only a description (and the tester without `amount`) skips it.

`PUT /api/settings/rules` body: any subset of `{ rules, payment_patterns, match_window_days, amount_tolerance }` (an omitted or `null` field keeps its value) → the same body. **422** naming the rule (`rule 3: ...`) for a pattern that is empty, longer than 512 characters or not a valid regex, a category outside the taxonomy, an unknown claim type, a `transfer_to_account` that is not an account, or an `amount_min` / `amount_max` that is negative, has more than two decimals or is the wrong way round (`rule 2: amount_max must not be less than amount_min`); also for `match_window_days` outside 0–60 or `amount_tolerance` outside 0–10.

`POST /api/settings/rules/test` `{ "description": "CARD PAYMENT THANK YOU", "amount"?: "-40.00", "rules"?: [...], "payment_patterns"?: [...] }` → `{ rule_index, rule, is_payment }`: the zero-based position and body of the first rule that matches (`null` for none) and whether the card-payment patterns match. `amount` (either sign) lets a rule with an amount range match; without it such a rule is skipped. Without `rules` / `payment_patterns` the saved ones are used; with them (unsaved edits) they are validated as on `PUT`.

## System (Settings → System)

`GET /api/system` →
```json
{
  "app": {"name": "Settl", "version": "0.1.0"},
  "repository": "owner/repo", "branch": "main",
  "running": {"commit": "<sha>|null", "short": "<7 chars>|null"},
  "latest":  {"commit", "short", "date", "message"} | null,
  "changes": [ {"commit", "short", "date", "message"}, ... ],
  "changes_truncated": false,
  "update_available": true | false | null,
  "update_check_enabled": true,
  "updater": {"available", "state": "idle|running|succeeded|failed", "started_at", "finished_at", "log", "error"},
  "checked_at": "<iso>",
  "backups": {
    "enabled": true, "count": 12, "stale": false,
    "last": {"name": "settl-20260929-020000-nightly.dump", "kind": "nightly", "created_at": "<iso>", "bytes": 2100000} | null,
    "recent": [ {"name", "kind", "created_at", "bytes"}, ... ]
  }
}
```
`running` comes from the updater sidecar (the commit checked out on disk); `latest` from GitHub (the newest of the last 30 commits on the branch, one request cached for ten minutes) and `null` when the check is disabled (`UPDATE_CHECK=false`) or the host is offline. `changes` lists the commits newer than `running`, newest first, each `message` being the first line of the commit message: the changelog of every update skipped, empty when up to date. When `running` is older than all 30 fetched, `changes` holds those 30 and `changes_truncated` is `true`; when `running` is unknown, `changes` is simply the newest commits. `update_available` is `null` whenever either side is unknown. `backups` describes the database dumps (below): `enabled` is whether the scheduled nightly dumps are on (`BACKUPS_ENABLED`), `last` the newest backup of any kind, `stale` is `true` when there is none or the newest is more than 36 hours old, and `recent` the newest five.

`POST /api/system/check` → the same body after a fresh look at GitHub.

`POST /api/system/update` (optional `?skip_backup=true`) → **202** `{ state: "running", started_at }`. The backend first takes a `pre-update` backup, then asks the updater to run `git pull --ff-only` and `docker compose up -d --build` for the app services; poll `GET /api/system` (expect a short outage while the backend restarts). **409** while an update is running, and **409** `The backup before updating failed, so the update was not started: <reason>` when the dump fails (nothing is started; repeat with `?skip_backup=true` to update without one). **503** when the updater container is not deployed or not reachable (no backup is taken then).

### Backups

A backup is one `pg_dump -Fc` file in `BACKUP_DIR` named `settl-YYYYMMDD-HHMMSS-<kind>.dump` (UTC), `kind` being `nightly` (the scheduler), `manual` (`POST` below) or `pre-update` (`POST /api/system/update`). An item is `{ "name", "kind", "created_at": "<iso>", "bytes" }`. All of these are primary only.

- `GET /api/system/backups` → every backup, newest first.
- `POST /api/system/backups` → **201** the new `manual` item (waits for a dump already running, then prunes old backups). **500** `The backup failed: <reason>` when `pg_dump` fails.
- `GET /api/system/backups/{name}` → the file (`application/octet-stream`, `Content-Disposition: attachment`). `name` must match `^settl-\d{8}-\d{6}-(nightly|manual|pre-update)\.dump$` exactly and exist in `BACKUP_DIR`; anything else (other files, `..`, encoded slashes) is **404**.
- `DELETE /api/system/backups/{name}` → **204**; **404** as above.

`POST /api/system/reset` body `{ "scope": "transactions" | "everything", "confirm": "<phrase>" }` →
```json
{ "scope": "transactions",
  "deleted": { "transactions": 17, "uploads": 2, "claims": 0, "periods": 1, "memory": 0, "accounts": 0, "settings": 0 } }
```
- `transactions` (confirm with `DELETE TRANSACTIONS`) wipes the ledger: every transaction (split parts and mirror legs included), every transfer-buffer row, statement upload, audit report and settlement snapshot, and every period that no partner claim files under (closed ones included). Partner claims (and their periods), merchant memory, accounts and the app settings (AI, household, categories, rules) are kept.
- `everything` (confirm with `DELETE EVERYTHING`) also deletes partner claims, every period, merchant memory, the app settings and the accounts, then seeds the accounts from `config.yaml` again exactly as on first start, so the installation looks like day one. Logins stay valid (the passwords live in `.env`).

One database transaction; `deleted` counts the rows removed (`accounts` counts those deleted before the re-seed). **422** `type DELETE TRANSACTIONS to confirm` / `type DELETE EVERYTHING to confirm` when `confirm` (trimmed, case-sensitive) is not the scope's phrase; **422** for an unknown `scope`.

`GET /api/health` → `{ status, database }` (no auth; reachable through the web port, so it reports only whether the app and its database are up)

## Periods

`GET /api/periods` → `[ {period_key, start_date, end_date, is_closed, closed_at, transaction_count, pending_review_count} ]` (newest first). An open period that nothing files under (no transaction, partner claim, settlement entry, snapshot or audit report) is left out, except the current calendar month; closed periods are always listed. An upload's months do not count.

`POST /api/periods/{period_key}/close?force=false` → PeriodOut. Runs the auditor and records the settlement snapshot first. Returns **409** when transactions are still `pending_review` unless `force=true`, and **409** when the period is already closed.

`POST /api/periods/{period_key}/reopen` → PeriodOut

While a period is closed, `PATCH`/`approve`/`approve-batch`/`DELETE`/`split` on its transactions and `DELETE` on its claims return **409**; uploads adding new lines to it, new claims dated in it, and settlement payments or adjustments dated in it (or deleted from it) are refused the same way. A settlement checkpoint may still be set or removed. Closing records the running balance (`carried_in`, `payments`, `adjustments`, `balance_out`) in the snapshot; reopening a month and changing it moves every later month's live balance until the next checkpoint. Transfer matching is exempt (the buffer persists across closes). `transaction_count` and `pending_review_count` count split transactions once (through the parent).

## Statements

`POST /api/statements/upload` — `multipart/form-data` with `file` (pdf/csv/xlsx/xls) and optional `account_id` (default account for the file; card sections that resolve to another account of the same institution keep their own account). The chosen account's type also fixes the sign convention for bare "Amount" columns. →
```json
{ "upload_id", "account_id", "period_key", "period_from", "period_to", "parser", "inserted",
  "skipped_duplicates", "pending_review", "auto_approved", "transfers_matched",
  "auto_approved_known", "warnings": [] }
```
`auto_approved_known` counts the lines that came out of classification `pending_review` but were then approved because their merchant is known (the same decision as `POST /api/transactions/auto-approve`, below); they are included in `auto_approved` and not in `pending_review`. Rule-classified lines are never touched by it.
`period_from` / `period_to` are the earliest and latest month (`YYYY-MM`) among the file's lines, skipped duplicates included; `period_key` is the latest month, kept for compatibility. `warnings` lists parser notes and, when the AI could not classify some lines, why: `AI unavailable (connection refused): 3 lines left uncategorised; approve them in the queue or retry the upload later` (the proxy refused, timed out or answered with an error; the rest of the file was not sent to it) or `AI gave an unusable answer for 1 line, left uncategorised; …`. No warning is raised when AI is switched off in Settings → AI.

Errors: **422** when the account cannot be determined (`detail` is `{message, candidates}`: `message` is a sentence meant for the user, "No account matches this statement. …" when `candidates` is empty and "Settl could not tell which account this statement is from. …" when it lists the account ids to choose from), **422** when the file cannot be parsed or is too large to be a statement (more than 60 pages / 20 LLM chunks), **409** when the file (same sha256) was already ingested, **409** when new lines would land in a closed period, **413** when the file is larger than 25 MB, **422** when the extension is not `.pdf`, `.csv`, `.xlsx` or `.xls`, the file is empty or `account_id` is unknown. Lines that already exist are skipped, not refused. The uploaded file is deleted after ingestion unless `KEEP_UPLOADED_FILES=true`.

`GET /api/statements` → `[ {id, account_id, period_key, period_from, period_to, filename, sha256, parser, transaction_count, created_at, deletable} ]` (`period_from` / `period_to` are `null` on uploads recorded before they existed; `deletable` is `false` only in the last case described under `DELETE` below, so the UI can grey the button out)

`DELETE /api/statements/{upload_id}` → **204**. Deletes every transaction the upload brought in (each line carries its `upload_id`, and so do the mirror legs written for its investment transfers and the parts of its split lines), with their transfer-buffer rows. A counterpart that was matched to one of them is unlinked and its buffer row goes back to `unmatched`. The upload row is removed, so the same file can be uploaded again; open periods left with nothing referencing them (the deleted lines' months and the upload's `period_from`..`period_to` span) are removed too, closed ones stay. **404** `upload not found`; **409** `period 2026-08 is closed; reopen it first` when any of those transactions sits in a closed period (nothing is changed). Uploads recorded before lines were linked to them fall back to the unlinked lines whose `source_file` is the upload's filename, when no other such upload (one that inserted lines, none of which carries its id) has the same filename; otherwise **409** `this upload was recorded before lines were linked to uploads; delete its transactions from the Transactions page`.

## Transactions

`GET /api/transactions?period=YYYY-MM&status=pending_review|auto_approved|manual_approved&account_id=&category=&q=&include_transfers=true&limit=100&offset=0`
→ `{ items: [TransactionOut], total }` (ordered by date desc, then created_at desc)

TransactionOut:
```
id, period_key, account_id, transaction_date, post_date, raw_description, cleaned_merchant,
amount, currency, original_currency, foreign_amount, category, subcategory, claim_type,
is_claimable, allocated_primary_amount, allocated_secondary_amount, review_status,
is_internal_transfer, linked_transfer_id, classification_source (rule|memory|llm|manual|transfer|none),
classification_confidence, source_file, note, created_at,
is_split, split_parent_id, parts: [TransactionPart]
```
TransactionPart: `id, split_index, amount, category, subcategory, claim_type, is_claimable, allocated_primary_amount, allocated_secondary_amount, note`

`note` is the user's own free text on what the payment was (null when there is none). `raw_description` is exactly what the bank printed and is never edited, because the duplicate fingerprint is built from it.

The list never contains parts: a split transaction appears once, as its parent, with `is_split: true` and its parts embedded. The `category` filter matches a transaction whose own category **or** any part's category equals the value. `q` is a case-insensitive substring search over `raw_description`, `cleaned_merchant` and `note`, and a parent also matches when one of its parts' notes does.

`GET /api/transactions/{id}` → TransactionOut (works for a part too: `split_parent_id` is then set and `parts` is empty)

`PATCH /api/transactions/{id}` body `{ category?, subcategory?, claim_type?, cleaned_merchant?, is_internal_transfer?, note? }` → TransactionOut. Recomputes allocations; does **not** change review status. `null` clears `subcategory` and `note` and is ignored for the other fields. `note` is trimmed and `""` clears it; more than 500 characters is **422** `note must be at most 500 characters (got N)`. A note changes nothing else (status, classification, allocations, merchant memory), works on pending and approved lines, on a split parent and on each part (every part may carry its own), and, like every other edit, is **409** while the period is closed. `category` must be one of the configured `categories` (matched ignoring case and stored in the configured spelling) or `Uncategorized`: anything else is **422** naming the value; `subcategory` is free text. Correcting an already-approved transaction updates merchant memory. On a split parent only `cleaned_merchant` may change (it is copied to the parts); `category`, `subcategory`, `claim_type` and `is_internal_transfer` answer **409**. On a part, `category`, `subcategory` and `claim_type` may change; `cleaned_merchant` and `is_internal_transfer` answer **409**. Setting `category` to `Transfers:Internal` also sets `is_internal_transfer` (registering the transfer and making the claim type `personal`) unless the same body sends `is_internal_transfer`; approving a line already in that category does the same, and so does ingestion when the classifier files a line there.

`POST /api/transactions/{id}/approve` body `{ ...same optional corrections..., remember: true }` → TransactionOut with `review_status = manual_approved`. When `remember` is true the confirmed classification is written to merchant memory (learning loop); transfers, `Uncategorized` answers and split transactions are never remembered.

`POST /api/transactions/approve-batch` `{ ids: [...], remember: true }` → `{ approved, items }`. **404** (naming the ids) when any id is unknown, and **409** when any of them is in a closed period; either way nothing is approved.

`POST /api/transactions/auto-approve` `{ period: "YYYY-MM" | null, dry_run: false }` → `{ approved, considered, skipped: { reason: count }, items: [{ id, cleaned_merchant, amount, category, claim_type }] }`. Approves the `pending_review` lines (split parts excluded, as in the list) of one month, or of every month when `period` is `null` or left out, whose merchant has always been filed the same way (see TECHNICAL.md, "Approving known merchants"). `items` are the lines approved or, with `dry_run: true`, that would be; a dry run writes nothing. `considered` counts the pending lines in scope and `skipped` why the others stay: `new_merchant`, `few_approvals`, `mixed_history`, `unusual_amount`, `other_sign`, `transfer`, `split`, `closed_period` (reasons with no lines are left out). Approved lines become `auto_approved` with `classification_source: "memory"` and confidence `0.950`, their allocations recomputed; nothing is written to merchant memory. Lines in closed months are skipped, not refused. **422** for a malformed `period`; **403** for the secondary user.

`DELETE /api/transactions/{id}` → 204 (also removes buffer entries / links; a split parent takes its parts with it). Deleting a part answers **409**: remove the split instead.

### Splitting a transaction

`PUT /api/transactions/{id}/split` body
```json
{ "parts": [
  { "amount": "-6.00", "category": "Groceries", "subcategory": null, "claim_type": "shared_proportional" },
  { "amount": "-4.00", "category": "Shopping:Home", "claim_type": "personal" }
] }
```
→ TransactionOut (the parent, `is_split: true`, `parts` filled, `review_status: manual_approved`).

Each part gets its own category, claim type and allocations; the parent keeps the cash movement, the merchant and the provenance but carries no money of its own in the settlement, the macro/micro metrics or the auditor. Splitting is a reviewed decision, so it approves the transaction; nothing is written to merchant memory. Sending the request again replaces the parts.

Rules (**422** otherwise): between 2 and 20 parts; every `amount` non-zero, signed like the transaction and no larger than it; the amounts sum exactly to the transaction amount; every `category` one of the configured `categories` or `Uncategorized` (matched ignoring case, stored in the configured spelling; the 422 names the offending value). **409** when the period is closed, when the transaction is an internal transfer, or when it is itself a part.

`DELETE /api/transactions/{id}/split` → TransactionOut (`is_split: false`, `parts: []`; the transaction stays approved). **409** in a closed period or when the id is a part (remove the split on its parent). Calling it on a transaction that is not split is a no-op.

## Transfers (reconciliation buffer)

`GET /api/transfers/unmatched` → `[ {id, transaction_id, account_id, amount, transaction_date, match_status, resolved_at, description} ]`

`GET /api/transfers` → `[TransferBufferOut]` (the same shape: every buffer entry whatever its `match_status`, newest `transaction_date` first)

`POST /api/transfers/rematch` → `{ matched }`

`POST /api/transfers/{buffer_id}/ignore` → TransferBufferOut (**404** for an unknown id; **409** when the entry is already `matched`; ignoring twice is a no-op)

`POST /api/transfers/match` `{ buffer_id_a, buffer_id_b }` → `[TransferBufferOut, TransferBufferOut]` (manual link; **409** when either entry is not `unmatched` (matched or ignored), either transaction is already linked, or both are on the same account; **422** when the two ids are the same; **404** for an unknown id)

## Partner claims (mobile `/claim` form)

`POST /api/claims` `{ claim_date, amount (>0), merchant, description?, claim_type? (default shared_proportional), paid_by? }` → **201** ClaimOut.
A `secondary` session always records `paid_by = secondary user`. A `primary` session may set `paid_by` (defaults to secondary — i.e. logging a claim on the partner's behalf); it must be one of the two configured user ids (**422**). Amounts are rounded half-up to the configured decimals; a `claim_date` in the future or more than 12 months ago is **422**; a claim dated in a closed period is **409**.

ClaimOut: `id, period_key, claim_date, paid_by, merchant, description, amount, claim_type, primary_owes, secondary_owes, is_settled, created_at`

`GET /api/claims?period=YYYY-MM&settled=false&limit=200` → `[ClaimOut]` (both roles; newest `claim_date` first, at most `limit` rows, max 1000)

`DELETE /api/claims/{id}` → 204 (primary; a secondary session may delete only its own unsettled claims and gets **403** otherwise). **404** for an unknown id; **409** when the claim's period is closed. When the claim was the only thing filed under its month (no transactions, other claims, uploads, audit reports or settlement snapshot) and the period is open, the empty period is removed with it, so a claim typed with the wrong date leaves no stray month behind.

## Settlement

All money is a string with two decimals, in "secondary owes primary" terms unless stated: positive = the secondary user owes the primary user, negative = the primary owes the secondary.

`GET /api/settlement/{period_key}` (both roles) →
```json
{
  "period_key", "primary_user_id", "secondary_user_id", "primary_ratio", "secondary_ratio",
  "secondary_share_of_primary_paid_shared", "primary_share_of_secondary_paid_shared",
  "secondary_personal_on_primary_paid", "primary_personal_on_secondary_paid",
  "net_owed_by_secondary", "settlement_payments_received",
  "pending_review_count", "unsettled_claim_count",
  "settlement_due_date",
  "snapshot": null | { "period_key", "net_owed_by_secondary", "secondary_share_of_primary_paid_shared",
                       "primary_share_of_secondary_paid_shared", "secondary_personal_on_primary_paid",
                       "primary_personal_on_secondary_paid", "settlement_payments_received", "line_count",
                       "carried_in", "payments", "adjustments", "balance_out", "snapshot_at" },
  "lines": [ {source, id, date, merchant, amount, claim_type, paid_by, primary_share, secondary_share, effect_on_secondary_owes} ],
  "balance": {
    "carried_in", "net", "payments_ledger", "payments_manual", "adjustments", "balance_out",
    "from_period",
    "checkpoint": null | { "id", "amount", "entry_date", "note", "net_at_checkpoint", "drift", "drifted" },
    "before_checkpoint"
  },
  "entries": [ {id, period_key, kind, entry_date, amount, paid_by, note, net_at_checkpoint, created_by, created_at} ],
  "ledger_payments": [ {transaction_id, date, amount, account_id, description, effect} ]
}
```
`net_owed_by_secondary` is the month's own figure: what its approved items move between the two of you, before any money changes hands. `settlement_due_date` is the configured settlement day in the following month. `snapshot` is what was recorded when the period was closed (the settlement ledger); its four balance fields are `null` on snapshots taken before the running balance existed. Everything else is computed live. A split transaction contributes one line per part (with the part's `id`), never a line for the parent.

`settlement_payments_received` is the signed total of the month's approved `Transfers:Settlement` lines in **both** directions (the same figure as `balance.payments_ledger`): positive when, on balance, the secondary paid the primary. Before the running balance it only summed credits; a debit (the primary paying the partner) now counts negatively. It is reported, never subtracted from `net_owed_by_secondary`.

`balance` is the running balance:

* `carried_in` is the previous calendar month's `balance_out` (0 before the first month holding any transaction, claim or settlement entry; months with no data count as zero).
* `balance_out = carried_in + net - payments_ledger - payments_manual + adjustments`.
* `payments_ledger` is the signed effect of `ledger_payments`: on an account the primary pays for, a credit (the partner paid in) is `+amount` and a debit (the primary paid the partner) is `-|amount|`; on an account the secondary pays for the signs flip. Each line's `effect` is its share of that total.
* `payments_manual` is the month's `payment` entries: `+amount` when paid by the secondary, `-amount` when paid by the primary. `adjustments` is the signed sum of the `adjustment` entries.
* When the month holds a checkpoint (an agreed balance), `balance_out` is its `amount` and `carried_in` is `0`: nothing earlier is looked at, and payments, adjustments and approvals in that month no longer move it. `checkpoint.drift` is the month's `net` now minus `net_at_checkpoint` (the net when the balance was set); `drifted` is `drift != 0`, so the UI can say "£x approved since the balance was set".
* `from_period` is where the walk started: the nearest checkpoint month at or before this one, or the first month with data.
* `before_checkpoint` is `true` when a later month holds a checkpoint: this month is history and its balance is not carried forward.

`entries` are the month's settlement entries (all kinds), oldest `entry_date` first.

`POST /api/settlement/entries` (primary) body `{ kind, entry_date, amount, paid_by?, note? }` → **201** entry (the `entries` item shape). `period_key` is the month of `entry_date` (the period row is created if missing).

* `kind: "payment"`: money changing hands outside the ledger. `paid_by` must be one of the two configured user ids and `amount` > 0 (the sum paid). Also marks the month's partner claims settled, as `mark-settled` does.
* `kind: "adjustment"`: `amount` is the signed change to what the secondary owes; it must not be 0.
* `kind: "checkpoint"`: `amount` is the agreed `balance_out` for the month (0 and negative allowed). A month has at most one: posting another replaces its date, amount and note. `net_at_checkpoint` is set to the month's current net.

`amount` has at most two decimals; `paid_by` on anything but a payment is **422**; `note` is trimmed, at most 500 characters. **422** on any of these, an unknown `kind` or a bad date. **409** `period 2026-08 is closed; reopen it first` for a payment or adjustment dated in a closed period; a checkpoint may be set on a closed period (it does not change the snapshot already recorded). **403** for a secondary session.

`DELETE /api/settlement/entries/{id}` (primary) → **204**. **404** for an unknown id; **409** for a payment or adjustment in a closed period (a checkpoint may be removed). When the entry was the only thing filed under its month and the period is open, the empty period is removed with it.

`POST /api/settlement/{period_key}/mark-settled` (primary) → `{ settled_claims }` marks the period's claims `is_settled`. It records no money; use a `payment` entry or an approved `Transfers:Settlement` line for that.

## Metrics

`GET /api/metrics/{period_key}` →
```json
{
  "period_key",
  "macro": { "household_burn", "primary_accounts_burn", "partner_claims_burn", "refunds", "by_category": [{category, amount}] },
  "micro": { "true_net_expense", "from_transactions", "from_partner_claims", "by_category": [...] },
  "liquidity": { "credits", "debits", "net_cash_flow", "by_account": [{account_id, credits, debits, net}] }
}
```
`macro.by_category` is gross debits per category plus a `Partner claims` row when the period has claims, so the rows add up exactly to `household_burn`; categories with no debit are left out. `macro.refunds` is the total of credits in spend categories for the period, reported for display and never deducted from the burn.

`GET /api/metrics/trends?periods=6&ending=YYYY-MM` → `[ {period_key, household_burn, true_net_expense, net_cash_flow} ]` (oldest first; `periods` 1–36; `ending` is the last month of the window, by default the newest period, **422** when malformed; months with no data are zeros)

`GET /api/metrics/investment` → `{ accounts: [{account_id, total_deposits, total_withdrawals, net_invested_capital, realized_gain}], total_deposits, total_withdrawals, net_invested_capital, realized_gain }`

## Audit (Agent 3)

`POST /api/audit/{period_key}/run` → AuditReportOut

`GET /api/audit/{period_key}` → latest AuditReportOut, or `null` (still **200**) when the period has never been audited: "not run yet" is the normal state, not an error. **422** for a malformed period.

AuditReportOut:
```json
{
  "period_key", "summary_sentence",
  "anomalies": [ {transaction_id, merchant, issue, current_amount, baseline_amount, baseline_stddev, deviation} ],
  "category_comparison": [ {category, current, baseline_average, change_pct, baseline_periods} ],
  "created_at"
}
```
`deviation` is a signed fraction (0.28 = +28 %); `change_pct` is a percentage and `null` when there is no baseline. `baseline_average` is averaged over the prior look-back months that carry any approved spend, not over the whole window (a fresh install's first months are not read as zero spend); `baseline_periods` is that count, the same on every row, and `0` (reports stored before the field existed also read `0`) when no prior month has data. The summary sentence is written in the configured currency; an LLM answer quoting another currency is replaced by the deterministic sentence. Macro and micro metrics exclude internal transfers and the `Transfers:*` and `Income:*` categories. Split transactions count through their parts in macro, micro and the audit; the liquidity view counts the parent (the actual cash movement) and ignores the parts.

## Merchant memory

`GET /api/memory?limit=200` → `[ {id, raw_pattern, normalized_merchant, category, default_claim_type, review_count, last_updated} ]`

`DELETE /api/memory/{id}` → 204
