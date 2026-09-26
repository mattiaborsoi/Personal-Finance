# REST API contract

All routes are prefixed with `/api`. JSON in, JSON out. Money is serialised as a
decimal string (e.g. `"-45.90"`); dates as `YYYY-MM-DD`; periods as `YYYY-MM`.
Sign convention everywhere: **negative = money out, positive = money in**.

## Authentication

`POST /api/auth/login` `{ "password": "..." }` → `{ token, role, user_id, display_name }`

Send `Authorization: Bearer <token>` on every other request. Tokens expire after 30 days and
are invalidated when the role's password changes. After 5 wrong passwords from one address
the login endpoint answers **429** (with `Retry-After`) for 1 minute, doubling on repeats.

| role        | may call                                                                 |
|-------------|--------------------------------------------------------------------------|
| `primary`   | everything                                                               |
| `secondary` | `GET /auth/me`, `GET /config`, `GET/POST /claims`, `GET /settlement/{p}` |

`GET /api/auth/me` → `{ role, user_id, display_name }`

## Reference

`GET /api/config` → sanitised config for the UI:
```json
{
  "base_currency": "GBP", "currency_symbol": "£",
  "users": { "primary": {"id","display_name"}, "secondary": {"id","display_name"} },
  "split": { "strategy", "primary_ratio", "secondary_ratio", "rounding_decimals", "settlement_day_of_month" },
  "accounts": [ {"id","institution","label","account_type","owner","identifier_last4","default_claim_type","billed_to"} ],
  "categories": ["Bills:Water", "..."],
  "claim_types": ["personal","shared_proportional","shared_equal","secondary_personal","primary_personal"]
}
```
`label` is the optional display name from `config.yaml` (`null` when unset; the UI then shows institution and account type).

## Accounts (Settings → Accounts)

Accounts live in the database. `config.yaml` seeds them the first time Settl starts with an empty `accounts` table; after that these endpoints are the only way they change. Every other endpoint sees the current rows (the "effective" configuration), so a card added here is mapped by its digits on the next upload and its `billed_to` rule is used by the settlement.

AccountOut: `id, institution, label, account_type, owner_user_id, identifier_last4, default_claim_type, billed_to, is_active, transaction_count, created_at`

`GET /api/accounts` → `[AccountOut]` (archived included; active first, then in creation order)

`POST /api/accounts` `{ id?, institution, label?, account_type, owner, identifier_last4, default_claim_type?, billed_to? }` → **201** AccountOut. `id` is generated (`acc_<institution>_<type>_<last4>`) when omitted; if given it must be 2–64 lowercase letters, digits, `_` or `-`. **422** for an unknown `owner`/`billed_to`, blank fields, or another active account at the same institution with the same digits (a main card and its supplementary card are allowed to share digits); **409** when the `id` exists.

`PATCH /api/accounts/{id}` `{ institution?, label?, account_type?, owner?, identifier_last4?, default_claim_type?, billed_to?, is_active? }` → AccountOut. Omitted fields are untouched; `null` clears `label` / `billed_to`. `is_active: false` archives the account: it keeps its history but is no longer offered for uploads.

`DELETE /api/accounts/{id}` → 204. **409** when the account has transactions or uploads, or a `config.yaml` rule sends transfers to it (archive it instead).

## AI (Settings → AI)

Which proxy and models Settl uses, and the thresholds behind them. Defaults come from `config.yaml` (`llm`, `auditor`) and `.env` (`LLM_PROVIDER`, `EMBEDDING_PROVIDER`, `LITELLM_URL`); a saved document overrides them and applies to the next request, no restart needed. Provider API keys never pass through this API.

`GET /api/ai` →
```json
{
  "enabled": true,
  "embedding_provider": "litellm",
  "models": { "chat": "default-chat", "extraction": "default-chat", "audit": "default-chat", "embedding": "default-embedding" },
  "thresholds": { "similarity_threshold": 0.82, "top_k": 3, "deviation_threshold": 0.15, "lookback_periods": 3 },
  "proxy": { "mode": "bundled", "url": "http://litellm:4000", "bundled_url": "http://litellm:4000", "from_env": false, "reachable": true, "has_key": true },
  "available_models": [ { "name": "cheap-chat", "mode": "chat", "provider": "Anthropic", "model": "claude-haiku-4-5" } ],
  "memory_rows": 8,
  "stored": false
}
```
`models.chat` categorises transactions, `extraction` reads PDFs the parsers cannot, `audit` writes the monthly summary, `embedding` turns merchants into vectors (`embedding_provider: "hash"` = offline, no AI). `available_models` is what the selected LiteLLM proxy lists (`/model/info`, falling back to `/v1/models`), cached for a minute; `proxy.mode` is `bundled` (whatever `.env` says: `LITELLM_URL` / `LITELLM_API_KEY`, by default the Compose container; `from_env: true` when `.env` points elsewhere) or `external` (a LiteLLM you already run, at `proxy.url` with a key stored server-side and never returned). `stored: false` means nothing has been saved yet.

`PUT /api/ai` body: any subset of `{ enabled, embedding_provider, models: {chat?, extraction?, audit?, embedding?}, thresholds: {...}, proxy: {mode?, url?, api_key?}, clear_memory }` → the same body as `GET`. A blank or omitted `api_key` keeps the stored one. **422** for out-of-range thresholds (similarity 0.5–0.99, top_k 1–10, deviation 0.05–1.0, look-back 1–12), a model the proxy does not list or lists with the wrong kind, or `mode: external` without an `http(s)://` URL. **409** when the embedding model or provider changes while `memory_rows > 0` and `clear_memory` is not `true`: the stored vectors would no longer be comparable; with `clear_memory: true` the merchant memory is emptied and the change saved.

`POST /api/ai/test` body: the same shape as `PUT` (the values on the form, saved or not) → `{ "chat": {ok, ms, model, error} | null, "extraction": ..., "audit": ..., "embedding": {ok, ms, model, dimensions, error} }`. Each chat job is one tiny completion; the embedding test also checks the vector has the schema's 1536 dimensions. `null` for a job that is switched off; never a 5xx.

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
  "checked_at": "<iso>"
}
```
`running` comes from the updater sidecar (the commit checked out on disk); `latest` from GitHub (the newest of the last 30 commits on the branch, one request cached for ten minutes) and `null` when the check is disabled (`UPDATE_CHECK=false`) or the host is offline. `changes` lists the commits newer than `running`, newest first, each `message` being the first line of the commit message: the changelog of every update skipped, empty when up to date. When `running` is older than all 30 fetched, `changes` holds those 30 and `changes_truncated` is `true`; when `running` is unknown, `changes` is simply the newest commits. `update_available` is `null` whenever either side is unknown.

`POST /api/system/check` → the same body after a fresh look at GitHub.

`POST /api/system/update` → **202** `{ state: "running", started_at }`. The updater runs `git pull --ff-only` and `docker compose up -d --build` for the app services; poll `GET /api/system` (expect a short outage while the backend restarts). **409** while an update is running, **503** when the updater container is not deployed or not reachable.

`GET /api/health` → `{ status, database, llm_provider, embedding_provider }` (no auth)

## Periods

`GET /api/periods` → `[ {period_key, start_date, end_date, is_closed, closed_at, transaction_count, pending_review_count} ]` (newest first)

`POST /api/periods/{period_key}/close?force=false` → PeriodOut. Runs the auditor and records the settlement snapshot first. Returns **409** when transactions are still `pending_review` unless `force=true`, and **409** when the period is already closed.

`POST /api/periods/{period_key}/reopen` → PeriodOut

While a period is closed, `PATCH`/`approve`/`approve-batch`/`DELETE`/`split` on its transactions and `DELETE` on its claims return **409**; uploads adding new lines to it and new claims dated in it are refused the same way. Transfer matching is exempt (the buffer persists across closes). `transaction_count` and `pending_review_count` count split transactions once (through the parent).

## Statements

`POST /api/statements/upload` — `multipart/form-data` with `file` (pdf/csv/xlsx/xls) and optional `account_id` (default account for the file; card sections that resolve to another account of the same institution keep their own account). The chosen account's type also fixes the sign convention for bare "Amount" columns. →
```json
{ "upload_id", "account_id", "period_key", "parser", "inserted", "skipped_duplicates",
  "pending_review", "auto_approved", "transfers_matched", "warnings": [] }
```
Errors: **422** when the account cannot be determined (`detail` is `{message, candidates}`), **422** when the file cannot be parsed or is too large to be a statement (more than 60 pages / 20 LLM chunks), **409** when the file (same sha256) was already ingested, **409** when new lines would land in a closed period. Lines that already exist are skipped, not refused. The uploaded file is deleted after ingestion unless `KEEP_UPLOADED_FILES=true`.

`GET /api/statements` → `[ {id, account_id, period_key, filename, sha256, parser, transaction_count, created_at} ]`

## Transactions

`GET /api/transactions?period=YYYY-MM&status=pending_review|auto_approved|manual_approved&account_id=&category=&q=&include_transfers=true&limit=100&offset=0`
→ `{ items: [TransactionOut], total }` (ordered by date desc, then created_at desc)

TransactionOut:
```
id, period_key, account_id, transaction_date, post_date, raw_description, cleaned_merchant,
amount, currency, original_currency, foreign_amount, category, subcategory, claim_type,
is_claimable, allocated_primary_amount, allocated_secondary_amount, review_status,
is_internal_transfer, linked_transfer_id, classification_source (rule|memory|llm|manual|transfer|none),
classification_confidence, source_file, created_at,
is_split, split_parent_id, parts: [TransactionPart]
```
TransactionPart: `id, split_index, amount, category, subcategory, claim_type, is_claimable, allocated_primary_amount, allocated_secondary_amount`

The list never contains parts: a split transaction appears once, as its parent, with `is_split: true` and its parts embedded. The `category` filter matches a transaction whose own category **or** any part's category equals the value.

`GET /api/transactions/{id}` → TransactionOut (works for a part too: `split_parent_id` is then set and `parts` is empty)

`PATCH /api/transactions/{id}` body `{ category?, subcategory?, claim_type?, cleaned_merchant?, is_internal_transfer? }` → TransactionOut. Recomputes allocations; does **not** change review status. `null` clears `subcategory` and is ignored for the other fields. Correcting an already-approved transaction updates merchant memory. On a split parent only `cleaned_merchant` may change (it is copied to the parts); `category`, `subcategory`, `claim_type` and `is_internal_transfer` answer **409**. On a part, `category`, `subcategory` and `claim_type` may change; `cleaned_merchant` and `is_internal_transfer` answer **409**.

`POST /api/transactions/{id}/approve` body `{ ...same optional corrections..., remember: true }` → TransactionOut with `review_status = manual_approved`. When `remember` is true the confirmed classification is written to merchant memory (learning loop); transfers, `Uncategorized` answers and split transactions are never remembered.

`POST /api/transactions/approve-batch` `{ ids: [...], remember: true }` → `{ approved, items }`

`DELETE /api/transactions/{id}` → 204 (also removes buffer entries / links; a split parent takes its parts with it). Deleting a part answers **409**: remove the split instead.

### Splitting a transaction

`PUT /api/transactions/{id}/split` body
```json
{ "parts": [
  { "amount": "-6.00", "category": "Groceries", "subcategory": null, "claim_type": "shared_proportional" },
  { "amount": "-4.00", "category": "Household", "claim_type": "personal" }
] }
```
→ TransactionOut (the parent, `is_split: true`, `parts` filled, `review_status: manual_approved`).

Each part gets its own category, claim type and allocations; the parent keeps the cash movement, the merchant and the provenance but carries no money of its own in the settlement, the macro/micro metrics or the auditor. Splitting is a reviewed decision, so it approves the transaction; nothing is written to merchant memory. Sending the request again replaces the parts.

Rules (**422** otherwise): between 2 and 20 parts; every `amount` non-zero, signed like the transaction and no larger than it; the amounts sum exactly to the transaction amount; `category` non-empty. **409** when the period is closed, when the transaction is an internal transfer, or when it is itself a part.

`DELETE /api/transactions/{id}/split` → TransactionOut (`is_split: false`, `parts: []`; the transaction stays approved). **409** in a closed period.

## Transfers (reconciliation buffer)

`GET /api/transfers/unmatched` → `[ {id, transaction_id, account_id, amount, transaction_date, match_status, resolved_at, description} ]`

`POST /api/transfers/rematch` → `{ matched }`

`POST /api/transfers/{buffer_id}/ignore` → TransferBufferOut

`POST /api/transfers/match` `{ buffer_id_a, buffer_id_b }` → `[TransferBufferOut, TransferBufferOut]` (manual link; 409 if either already matched)

## Partner claims (mobile `/claim` form)

`POST /api/claims` `{ claim_date, amount (>0), merchant, description?, claim_type, paid_by? }` → ClaimOut.
A `secondary` session always records `paid_by = secondary user`. A `primary` session may set `paid_by` (defaults to secondary — i.e. logging a claim on the partner's behalf). Amounts are rounded half-up to the configured decimals; a `claim_date` in the future is **422**.

ClaimOut: `id, period_key, claim_date, paid_by, merchant, description, amount, claim_type, primary_owes, secondary_owes, is_settled, created_at`

`GET /api/claims?period=YYYY-MM&settled=false` → `[ClaimOut]` (both roles)

`DELETE /api/claims/{id}` → 204 (primary; secondary may delete their own unsettled claims)

## Settlement

`GET /api/settlement/{period_key}` → 
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
                       "primary_personal_on_secondary_paid", "settlement_payments_received", "line_count", "snapshot_at" },
  "lines": [ {source, id, date, merchant, amount, claim_type, paid_by, primary_share, secondary_share, effect_on_secondary_owes} ]
}
```
`net_owed_by_secondary` > 0 means the secondary user pays the primary user. `settlement_due_date` is the configured settlement day in the following month. `snapshot` is the figure recorded when the period was closed (the settlement ledger); the rest is always computed live. A split transaction contributes one line per part (with the part's `id`), never a line for the parent.

`POST /api/settlement/{period_key}/mark-settled` → `{ settled_claims }` marks the period's claims `is_settled`.

## Metrics

`GET /api/metrics/{period_key}` →
```json
{
  "period_key",
  "macro": { "household_burn", "primary_accounts_burn", "partner_claims_burn", "by_category": [{category, amount}] },
  "micro": { "true_net_expense", "from_transactions", "from_partner_claims", "by_category": [...] },
  "liquidity": { "credits", "debits", "net_cash_flow", "by_account": [{account_id, credits, debits, net}] }
}
```
`GET /api/metrics/trends?periods=6` → `[ {period_key, household_burn, true_net_expense, net_cash_flow} ]` (oldest first)

`GET /api/metrics/investment` → `{ accounts: [{account_id, total_deposits, total_withdrawals, net_invested_capital, realized_gain}], total_deposits, total_withdrawals, net_invested_capital, realized_gain }`

## Audit (Agent 3)

`POST /api/audit/{period_key}/run` → AuditReportOut

`GET /api/audit/{period_key}` → latest AuditReportOut, **404** if never run.

AuditReportOut:
```json
{
  "period_key", "summary_sentence",
  "anomalies": [ {transaction_id, merchant, issue, current_amount, baseline_amount, baseline_stddev, deviation} ],
  "category_comparison": [ {category, current, baseline_average, change_pct} ],
  "created_at"
}
```
`deviation` is a signed fraction (0.28 = +28 %); `change_pct` is a percentage and `null` when there is no baseline. Macro and micro metrics exclude internal transfers and the `Transfers:*` and `Income:*` categories. Split transactions count through their parts in macro, micro and the audit; the liquidity view counts the parent (the actual cash movement) and ignores the parts.

## Merchant memory

`GET /api/memory?limit=200` → `[ {id, raw_pattern, normalized_merchant, category, default_claim_type, review_count, last_updated} ]`

`DELETE /api/memory/{id}` → 204
