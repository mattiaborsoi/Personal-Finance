# Settl: technical reference

Everything under the bonnet of Settl, for people running, extending or auditing it.
The [README](../README.md) explains what the product does; [`API.md`](API.md) is the
REST contract; [`BLUEPRINT.md`](BLUEPRINT.md) is the original specification that the
"Design decisions" section at the end deviates from.

Sign convention everywhere: **negative = money out, positive = money in**. Money is
`Decimal`, quantised to two places with `ROUND_HALF_UP`.

## 1. Architecture

```
                 ┌──────────────────────────────────────────────────────────────┐
  LAN            │  frontend  (nginx 1.27 + React/Vite/Tailwind SPA)   :80      │
  ──────────────▶│    /        static bundle, SPA fallback, security headers    │
                 │    /api/    proxied to backend:8000                          │
                 └───────────────────────────┬──────────────────────────────────┘
                                             │ compose network
                 ┌───────────────────────────▼──────────────────────────────────┐
                 │  backend   (FastAPI, uvicorn, Python 3.11)   127.0.0.1:8000  │
                 │    config engine · auth · routers · services (agents)        │
                 └─┬─────────────────────┬─────────────────────┬────────────────┘
                   │ SQL (psycopg 3)     │ HTTP (OpenAI API)   │ HTTP + token
                 ┌─▼────────────────┐  ┌─▼────────────────┐  ┌─▼────────────────┐
                 │ db pgvector/pg16 │  │ litellm  proxy   │  │ updater sidecar  │
                 │ 127.0.0.1:5432   │  │ 127.0.0.1:4000   │  │ no host port     │
                 │ ledger · memory  │  │ model names →    │  │ git pull, then   │
                 │ snapshots, audits│  │ provider API keys│  │ compose rebuild  │
                 └──────────────────┘  └──────────────────┘  └──────────────────┘
```

Five containers, defined in `docker-compose.yml`:

| container  | image / build                         | role                                                                                    |
|------------|---------------------------------------|-----------------------------------------------------------------------------------------|
| `db`       | `pgvector/pgvector:pg16`              | PostgreSQL 16 with the `vector` extension; data in the `pgdata` volume                   |
| `litellm`  | `ghcr.io/berriai/litellm`             | Local proxy; maps the logical names in `litellm/config.yaml` to providers and holds the provider keys. Optional: Compose profile `bundled-litellm`, on by default (see "Using your own LiteLLM") |
| `backend`  | `backend/Dockerfile`                  | FastAPI app; mounts `config.yaml` read-only and `./uploads`; runs `schema.sql` at start  |
| `frontend` | `frontend/Dockerfile`                 | Vite build served by nginx; the only port published beyond loopback                     |
| `updater`  | `updater/Dockerfile`                  | Optional self-update sidecar (Settings → System → Update now): `git` plus the Docker CLI, with the host's Docker socket mounted; publishes no port (see "Updating") |

The backend never sees provider API keys: it talks to a LiteLLM proxy (Settl's own,
with `LITELLM_MASTER_KEY`, or one you already run, with the key saved in the app or
`LITELLM_API_KEY`) and names models by whatever that proxy lists; Settl's own lists
the logical names `default-chat`, `cheap-chat` and `default-embedding`. Swapping
providers is a LiteLLM config change.

Startup (`app/main.py` lifespan): load `config.yaml` if there is one (a missing file,
or the empty directory Docker leaves in its place, means built-in defaults and a
warning; an invalid file still fails fast with a `ConfigError`), run the security
guard on the secrets, check `EMBEDDING_DIMENSIONS` matches the `vector(1536)` column,
execute `schema.sql` (every statement idempotent, so it doubles as the migration
mechanism) and, only when the `accounts` table is empty, seed it from the accounts in
`config.yaml`. From then on the app is the source of truth: accounts live in their
own table, and the household (names, incomes, split, currency), the categories, the
rules and card-payment patterns, and the AI setup are documents in `app_settings`
edited under Settings. Every request overlays all of that on the file configuration
(`app/deps.py: get_effective_config`), so `config.yaml` only ever supplies defaults
for what has not been saved in the app.

## 2. Deployment

Settl is meant to run on one always-on machine on your home network and to be reached
over the LAN. This is the long version of the README's "Run it in five minutes".

### Prerequisites

* A machine that stays on: a Mac mini, a NAS, a mini PC or a Raspberry-class board
  with a few GB of RAM.
* Docker with the Docker Compose plugin.
* Optionally, API keys for a language-model provider. As shipped, `litellm/config.yaml`
  uses Anthropic for chat and OpenAI for embeddings, so it expects an
  `ANTHROPIC_API_KEY` and an `OPENAI_API_KEY`; point both logical models at one
  provider if you prefer. Settl works with no key at all (see "Running without an
  LLM" below).

### Install

```bash
git clone https://github.com/mattiaborsoi/personal-finance settl && cd settl
cp .env.example .env                  # then edit it (section ".env" below)
cp config.example.yaml config.yaml    # optional: seeds the defaults described next
```

### Setting up the household: Settings, or `config.yaml`

Everything personal is set up in the app under **Settings** and stored in the
database: **Household** (the two names, incomes, split strategy, settle-by day,
rounding and currency), **Accounts**, **Categories**, **Rules** (deterministic rules
and card-payment patterns) and **AI**. `config.yaml` is optional: when present it
seeds the defaults for all of that before anything is saved, and the accounts are
imported from it once. Whatever is saved in Settings wins, and edits to the file are
not read again for a section that has been saved in the app. The field-by-field
reference is in section 11; working through `config.example.yaml` from the top:

* **`users`**: the two of you, each with an `id` (fixed once chosen; it is stored on
  every claim), a `display_name`, a `base_salary_pa` and an `additional_income_pa`.
  The incomes exist only to set the split ratio (the example's 100,000 and 80,000
  give 0.555556 / 0.444444) and are never shown to the secondary login:
  `GET /api/config` strips them. Editable later under Settings → Household.
* **`settlement`**: `salary_proportional` or `equal_50_50`, the rounding, and the day
  of the following month by which you settle (`settlement_day_of_month`). Also under
  Settings → Household.
* **`accounts`**: one entry per account or card, imported the first time Settl starts
  and managed in the app afterwards (Settings → Accounts; edits to this section are
  not applied again). `institution` and `identifier_last4`
  are how uploaded statements are mapped to accounts, so use exactly what the
  statement prints; `owner` is the person who spends on it; the optional `label` is
  the friendlier name shown in the app. The example set is a typical spread for a
  couple: an HSBC Premier current account (··4471) and an Amex Platinum (··7715) for
  the primary user, a Barclays Premier current account (··2093) for the secondary
  user, a supplementary Amex Platinum card (··3348) that the secondary user spends on
  but which is billed to the primary user (`credit_supplementary`, with
  `default_claim_type: shared_proportional` so its lines start out as shared), a
  Virgin Money credit card (··5502) and a Robinhood investment account
  (`investment_cash`).
* **`deterministic_rules`**: ordered regexes for merchants you already know; a match
  skips the LLM and is auto-approved. The supplier names in the example (AQUANORTH
  WATER, NORTHWIND ENERGY, FIBRELINE BROADBAND, EVERGREEN LIFE) are placeholders:
  replace them with what your own statements print. Two rules are worth keeping in
  some form: the `Transfers:Settlement` rule that recognises your partner's
  settlement transfer, and the `Transfers:Investment` rule with `transfer_to_account`
  that tracks cash moved into the investment account. Settings → Rules edits them,
  with a "Try it" box that shows which rule a description would hit.
* **`transfers.payment_patterns`**: how a card payment is described on your
  current-account and card statements, so the two legs are matched to each other and
  never counted as spending. Also under Settings → Rules ("Card payments").
* **`categories`**: the taxonomy offered to the classifier and the UI; Settings →
  Categories adds, reorders, renames (everywhere at once) and removes unused ones. It
  also sets the emoji shown next to each category group (the part of a name before
  the first `:`), over built-in defaults for the usual groups (`category_emojis` in
  `config.yaml` replaces those); an empty value hides a group's default. The
  category picker opens with suggestions from `GET /api/categories/suggestions`:
  what the merchant was filed under before (approved transactions and merchant
  memory) and the most used categories of the last 12 months.
* **`llm`, `auditor`**: the models, the similarity threshold and few-shot count and
  the Auditor's thresholds; Settings → AI. The defaults are fine to start with.

#### Claim types: who bears what

Every transaction and claim carries a *claim type* that says who the cost belongs to.
Who *paid* is worked out from the account it was spent on; who *bears* it comes from
the table below. The difference between the two is what ends up in the settlement
(section 6 has the arithmetic).

| claim type            | who bears it                                                           |
|-----------------------|------------------------------------------------------------------------|
| `personal`            | whoever owns the account it was spent from; nothing to settle          |
| `shared_proportional` | both of you, in proportion to your incomes                             |
| `shared_equal`        | both of you, 50 / 50                                                   |
| `secondary_personal`  | your partner alone (their item that went on your card)                 |
| `primary_personal`    | you alone (your item that went on your partner's card or in a claim)   |

A supplementary card is treated as spent by its holder but paid by the main
cardholder, which is exactly the case Settl was built to untangle. The income ratio
comes from the incomes under Settings → Household (or `config.yaml` until something
is saved there); switch to `equal_50_50` if you prefer a straight split.

### `.env`

Compose refuses to start until `DB_PASSWORD`, `SECRET_KEY`, `PRIMARY_PASSWORD` and
`SECONDARY_PASSWORD` are set, and the backend also refuses the placeholder values of
the last three (the guard is in `app/auth.py`); replace the placeholder
`DB_PASSWORD` too. The remaining rows configure the AI proxy; none of them stops
Settl from starting:

| variable                                 | rule                                                                                     |
|------------------------------------------|------------------------------------------------------------------------------------------|
| `DB_PASSWORD`                            | any password; it is baked into the database volume on first run (changing it later is a separate step, below) |
| `SECRET_KEY`                             | at least 32 random characters (`openssl rand -hex 32`); rotating it logs everyone out    |
| `PRIMARY_PASSWORD`, `SECONDARY_PASSWORD` | at least 8 characters each, not a placeholder, and different from each other             |
| `COMPOSE_PROFILES`                       | `bundled-litellm` starts Settl's own LiteLLM proxy; leave it empty when you run your own (see "Using your own LiteLLM") |
| `LITELLM_MASTER_KEY`                     | any long random string; it guards Settl's own LiteLLM                                    |
| `LITELLM_URL` / `LITELLM_API_KEY`        | only when you run your own LiteLLM: its address and key, which then become the default under Settings → AI → Proxy |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`   | provider keys, read only by the LiteLLM container; leave them empty when running without an LLM |

`LLM_PROVIDER`, `EMBEDDING_PROVIDER` and `KEEP_UPLOADED_FILES` are covered below and
in section 11.

### First start and first login

```bash
docker compose up -d --build
```

builds and starts the containers; on first start the backend creates the schema
and seeds the accounts from `config.yaml` if there is one (section 1). Open
<http://localhost> (or the machine's LAN address) and log in with `PRIMARY_PASSWORD`. Your partner opens
<http://localhost/claim> on their phone and logs in with `SECONDARY_PASSWORD`; that
login can log claims and read the settlement, and nothing else. To check everything
is wired up, run the test-suite inside the container:

```bash
docker compose exec backend pytest -v   # optional; uses a separate _test database
```

### The AI setup (Settings → AI)

Everything about the models is chosen in the app, under **Settings → AI**, and
stored in the database (`app_settings`, key `ai`); `config.yaml` (`llm`, `auditor`)
and `.env` (`LLM_PROVIDER`, `EMBEDDING_PROVIDER`, `LITELLM_URL`) only provide the
defaults shown before anything is saved. A saved change applies to the next request.
The page offers:

* **Use AI** on or off. Off means rules and the merchant memory only: unknown
  merchants land in the Review queue as `Uncategorized` for you to fix once, and the
  Auditor writes its sentence from the numbers alone.
* **Proxy**: one of two. **Settl's own LiteLLM** is the container from
  `docker-compose.yml` (its address is `BUNDLED_LITELLM_URL`, its key
  `LITELLM_MASTER_KEY`, its model list `litellm/config.yaml`). **A LiteLLM I already
  run** takes a URL and a key typed in the app; when `LITELLM_URL` / `LITELLM_API_KEY`
  are set in `.env` that option is selected by default with those values. The card
  says whether the chosen proxy answers and how many models it lists.
* **Which model does what**: categorising transactions (many small calls, a cheap
  model is fine), reading PDFs the parsers cannot (rare), the monthly summary (one
  call a month), and the embeddings behind the merchant memory (or "Offline, no
  AI", the hash embedder). The choices are whatever the selected LiteLLM proxy
  lists (`/model/info`, else `/v1/models`); add models by editing
  `litellm/config.yaml` and restarting the proxy.
* **Fine-tuning**: the memory confidence (cosine similarity at or above which a
  remembered merchant is trusted without asking), how many examples go into the
  prompt, and the Auditor's deviation threshold and look-back.
* **Test connection**: one tiny call per job, with latency; the embedding test also
  checks the vector has the schema's 1 536 dimensions.

Changing the embedding model or provider makes the stored merchant vectors
incomparable, so the page asks you to confirm clearing the merchant memory (the API
answers 409 otherwise). Provider API keys never pass through the app; they stay in
`.env` for the bundled proxy or in your own LiteLLM's configuration.

### Using your own LiteLLM

Settl ships a LiteLLM container, but nothing depends on it being *that* one. The
container sits in the Compose profile `bundled-litellm`, which `.env` enables by
default (`COMPOSE_PROFILES=bundled-litellm`). To use a LiteLLM you already run:

1. leave `COMPOSE_PROFILES` empty in `.env`, so Settl's own proxy is never started
   (nothing else in the stack depends on it);
2. either set `LITELLM_URL` and `LITELLM_API_KEY` in `.env`, which makes **A LiteLLM
   I already run** the selected option under Settings → AI → Proxy with that URL, or
   pick that option in the app and enter the URL and key there (the key is stored in
   the database, never shown again, and used only server-side). What is saved in the
   app wins over `.env`; **Settl's own LiteLLM** stays one click away.

If your proxy lists no embedding model (a chat-only LiteLLM, say), the page says so
and offers **Offline, no AI** for the merchant memory: tick it and save (or set
`EMBEDDING_PROVIDER=hash` in `.env` before anything is saved). Nothing switches
over by itself; add an embedding model to your LiteLLM to use AI there.

From inside the containers a proxy on the same machine is `http://host.docker.internal:4000`
(Docker Desktop provides that name; on Linux the backend service adds it via
`extra_hosts`). Model names are whatever your proxy lists.

### Updating

From the app: **Settings → System** shows the commit that is running, the latest one
on GitHub and, when they differ, every commit in between (the changelog of the
updates you skipped, up to the last 30), and **Update now** pulls the branch and
rebuilds the app containers.
That button is served by the optional `updater` sidecar in `docker-compose.yml`, a
small container holding `git`, the Docker CLI and the Compose plugin, with the
host's Docker socket and the repository directory mounted (at the same path as on
the host, so Compose's relative bind mounts keep resolving). Compose takes that path
from `$PWD`, so run every `docker compose` command from a shell inside the
repository directory; Compose refuses to start if `PWD` is not set. The backend
talks to it over the Compose network only (`UPDATER_URL`, `http://updater:9000`),
authenticated with a token derived from
`SECRET_KEY` (`sha256("settl-updater:" + SECRET_KEY)`); nothing else can trigger a
rebuild, and the sidecar publishes no port. An update is
`git pull --ff-only origin <branch>` followed by
`docker compose up -d --build --remove-orphans backend frontend`: the updater
rebuilds only `backend` and `frontend` (starting `db` first, as their dependency). It never
recreates itself or the `litellm` container, so a change to the sidecar needs a
manual `docker compose up -d --build updater`, and a change to `litellm/config.yaml`
a `docker compose restart litellm`.
Mounting the Docker socket is root-equivalent on the host: if you would rather not,
delete the `updater` service. The System tab then shows the manual commands
instead, and since the running commit is read by the updater, it can no longer tell
which commit is running or whether an update is available; it lists GitHub's latest
commits as recent changes.

The version check is one unauthenticated request to `api.github.com` for the last
30 commits of `UPDATE_REPO` / `UPDATE_BRANCH` (cached for ten minutes, never more
than once per page load); set `UPDATE_CHECK=false` in `.env` to never contact GitHub.
`UPDATE_REPO` (`owner/repo` on GitHub, default `mattiaborsoi/personal-finance`) and
`UPDATE_BRANCH` (default `main`) are `.env` variables too, for a fork; the branch is
also the one the updater pulls (section 11).

By hand:

```bash
git pull && docker compose up -d --build
```

The schema upgrades itself on start: `schema.sql` is idempotent and is re-run every
time the backend boots (section 12), so there is no migration step.

### Backups and restore

* **Back up:** `docker compose exec db pg_dump -U postgres financemaster > backup.sql`.
  The dump carries the ledger, the settlement snapshots, the audits and everything the
  merchant memory has learned.
* **Restore** into a fresh database:
  `docker compose exec -T db psql -U postgres financemaster < backup.sql`.
* `.env` (and `config.yaml`, if you use one) is not in the database; keep a copy
  alongside the dump.

### Starting over (Settings → System → Danger zone)

The System tab ends with a danger zone, each action behind a typed phrase and a plain
list of what goes and what stays (`POST /api/system/reset`,
`app/services/reset.py`; one database transaction):

* **Delete all transactions** (type `DELETE TRANSACTIONS`) empties the ledger: every
  transaction (split parts and mirror legs included), the transfer buffer, statement
  uploads, audit reports, settlement snapshots and every period no partner claim
  files under, closed ones included. Partner claims (and their periods), merchant
  memory, accounts and every Settings document are kept.
* **Reset Settl to day one** (type `DELETE EVERYTHING`) also deletes partner claims,
  every period, merchant memory and the `app_settings` documents (AI, household,
  categories, rules), then deletes the accounts and seeds them from `config.yaml`
  again (none without the file), exactly as on first start. `.env` is untouched, so
  both logins keep working.

Take a backup first if there is any chance you want the data back.

### Changing the database password

The password lives in the database volume, so editing `DB_PASSWORD` in `.env` alone
breaks the backend's connection. Either run `docker compose down -v` (which deletes
all data; back up first) and start again with the new value, or change it in place
and then update `.env`:

```bash
docker compose exec db psql -U postgres -c "ALTER USER postgres PASSWORD 'new-password'"
docker compose up -d
```

### Uploaded files

Statements are deleted from disk as soon as they are ingested; only a sha256 is kept
to spot re-uploads. Set `KEEP_UPLOADED_FILES=true` if you want the originals kept
under `./uploads`.

### Keep it private

Settl speaks plain HTTP and is meant for your LAN. Only the web port (80) is
reachable from other machines; the database, the LLM proxy and the API are bound to
the host's loopback address. Do not expose the host to the internet. If you want to
reach it from outside, put it behind a VPN or a reverse proxy that terminates TLS, and
bind port 80 to a specific interface in `docker-compose.yml` if the host has a public
one. The full security model is in section 10.

## 3. Ingestion pipeline

`app/services/ingestion.py` orchestrates one upload:

```
parse (Agent 1) → per-line account resolution → fingerprint / dedupe
  → classify (rules / transfer pattern / Agent 2) → insert (pending_review | auto_approved)
  → transfer buffer registration (+ mirror rows) → cross-ledger matching
```

* **File-level dedupe:** the upload's sha256 is stored in `statement_uploads`; the same
  file is rejected with 409.
* **Line-level dedupe:** each line gets `fingerprint = sha256(account | date | amount |
  normalised text | occurrence)`, where `occurrence` counts identical lines within the
  file, so overlapping statements insert nothing twice while two identical purchases on
  one day are both kept.
* **Account resolution:** an explicit `account_id` is the file's default; a line printed
  under a card section that resolves to one account of the same institution (a
  supplementary card) keeps that account. Without an explicit account, the line's
  `card_last4`, then the statement's `account_last4` / institution, decide. Ambiguity is
  a 422 listing the candidates.
* **Periods:** a transaction is filed under the calendar month of its own date. New
  lines that would land in a closed period are refused (409); already-known lines are
  skipped, so a statement overlapping a closed month still goes through. The upload
  record keeps the span of months the file touched (`period_from` / `period_to`,
  counting skipped lines too); `period_key` stays the newest month for compatibility.
* **AI outage:** one `guesser.UploadState` is shared by the file's `classify` calls.
  It memoises answers per (normalised description, account), so duplicate lines cost
  one lookup or LLM call, and it carries a circuit breaker: the first time the proxy
  is unreachable (connection refused, timeout) or answers with an HTTP error status,
  the rest of the file skips the LLM and lands `Uncategorized` instead of waiting out
  the timeout line after line. The result then carries a warning such as
  `AI unavailable (connection refused): 3 lines left uncategorised; approve them in
  the queue or retry the upload later` (an unusable model answer is a per-line
  problem: it never trips the breaker and is reported separately). AI switched off
  raises no warning. Classification is still synchronous; classifying in the
  background is a possible follow-up.
* **Limits:** `.pdf`, `.csv`, `.xlsx`, `.xls`; 25 MB; PDFs of more than 60 pages are
  refused before parsing.
* **Provenance:** every inserted line carries `upload_id`, and so do the mirror legs
  written for it and, later, the parts it is split into.

### Removing an upload (`app/services/statement_uploads.py`)

Each entry under "Previous uploads" on the Upload page has a Delete
(`DELETE /api/statements/{id}`) that removes the upload and everything it brought
in: its lines, their split parts and mirror legs, and their transfer-buffer rows. A
counterpart outside the upload that was matched to one of them is unlinked and goes
back to `unmatched` in the buffer (a mirror leg goes with its source). The
`statement_uploads` row is dropped too, so the same file can be uploaded again;
periods stay. The delete is refused with 409, changing nothing, when any of those
lines sits in a closed period (reopen it first). Claims and settlement snapshots are
not checked: they do not reference transactions.

Uploads recorded before lines carried `upload_id` fall back to the unlinked lines
whose `source_file` is the upload's filename. That is only safe when no other such
upload has the same filename; otherwise the delete is refused with 409 and
`GET /api/statements` reports `deletable: false`, so the button is greyed out with
the reason (delete those lines from the Transactions page instead).

### Agent 1: extractor (`app/services/parsers/`)

Deterministic parsers run first: `TabularParser` (pandas; CSV/XLSX/XLS with header
detection and a sign convention taken from the target account's type when the file
gives no hint), `PdfTableParser` (pdfplumber tables) and `PdfTextParser` (text-line
regexes with date context inferred from the statement period). For PDFs both PDF
parsers run and the one that finds more transactions wins (the table parser on a tie).

On a card account a single Amount column is normally card-style (an unsigned amount
is a charge; a minus, parentheses or `CR` mean money in). Some card exports are signed
like a bank account instead, with a minus on purchases. `TabularParser` reads those as
printed: when the lines matching the card-payment patterns are the unsigned ones, or,
with no repayment in the file, when most amounts carry a minus. The upload then carries
a warning saying so.

The **LLM layout extractor** (`llm_extractor.py`) is a fallback only:

* used only when no deterministic parser found any transaction, only for PDFs, and only
  when an LLM is configured (never for spreadsheets, never raw bytes);
* page text is chunked at ~6 000 characters; a document needing more than **20 LLM
  calls** is refused up front; **60 pages** is the hard document limit;
* the model must return the blueprint JSON schema; every field is validated and
  coerced (ISO dates, `Decimal` amounts, negative = money out), malformed items are
  dropped with a warning.

### Agent 2: the Guesser (`app/services/guesser.py`)

Precedence for each raw description:

1. **Deterministic rule** (Settings → Rules, seeded from `config.yaml`; first match
   wins) → `source=rule`, `auto_approved`; may carry `is_internal_transfer` /
   `transfer_to_account`.
2. **Card-payment pattern** (`transfers.payment_patterns`) → `Transfers:Internal`,
   `is_internal_transfer`, `source=transfer`, `auto_approved`.
3. **Merchant-key memory match** (`memory.lookup_by_key`): the *merchant key* is the
   first two words printed before any store number (`TESCO STORES 3021 LONDON` →
   `TESCO STORES`, `WAITROSE 123 LONDON` → `WAITROSE`, `UBER *TRIP HELP.UBER.COM` →
   `UBER TRIP`). A memory row whose normalised pattern is the key, or starts with the
   key followed by a space, is used directly → `source=memory`, confidence 1.0,
   `pending_review`, most reviewed row first. This is how the same shop is recognised under another store number: the
   offline hash embedder scores such pairs at 0.56–0.79, under the threshold. Rows that
   disagree on category or claim type (a shared bank prefix such as `CARD PAYMENT`)
   are not trusted and the vector search runs instead.
4. **Merchant memory** (`app/services/memory.py`, pgvector): the description is
   normalised (upper-case, digits and punctuation stripped), embedded, and the top-k
   (`llm.top_k`, default 3) nearest rows are fetched by cosine distance using the HNSW
   index. If the best hit's similarity is **at or above `llm.similarity_threshold`
   (0.82)** its merchant, category and claim type are used → `source=memory`,
   confidence = similarity, `pending_review`. A hit on the same brand's other service
   (`UBER TRIP` against `UBER EATS`, which embed at 0.85) is demoted to a few-shot
   example rather than pre-filled.
5. **One LLM call** with a minimal payload: the quoted description, the signed amount,
   the account context (institution, type, owner role, default claim type), the allowed
   categories and claim types, and the memory hits with **similarity ≥ 0.5** as
   few-shot examples (weaker hits are noise and an injection surface). The JSON answer
   is validated field by field: an unknown category becomes `Uncategorized` and halves
   the confidence, an unknown claim type falls back to the account default, a blank
   merchant falls back to the heuristic cleaner → `source=llm`, `pending_review`.
   The classification client waits **20 s** per call (PDF extraction 90 s, the audit
   60 s; `LLM_TIMEOUT_SECONDS` caps all three), and within one upload the circuit
   breaker described in section 3 stops calling a dead proxy after the first failure.
6. **No answer** (no LLM, the call failed, or the breaker is open) → `Uncategorized`,
   the account's default claim type, `source=none`, `pending_review`.

**Learning loop.** Approving a transaction (`POST /approve`, `approve-batch`, with
`remember=true`, the default) and correcting an already-approved one (`PATCH`) upsert
the confirmed classification into `merchant_memory`, keyed on the normalised
description, with a fresh embedding and an incremented `review_count`. Internal
transfers and `Uncategorized` answers are never remembered: a transfer is not a
merchant, and remembering "unknown" would silence the model for that merchant forever.

Embeddings are 1 536-dimensional. `EMBEDDING_PROVIDER=litellm` calls `/v1/embeddings`;
`EMBEDDING_PROVIDER=hash` is an offline character-n-gram feature hasher into the same
space. The two spaces are incompatible: do not switch providers once memory has rows.

### Reviewing and correcting

Lines left `pending_review` wait on the **Review** page (`/review`), which holds the
approval queue for one month with the same period selector as the dashboard and the
close / reopen control. The dashboard shows only a compact "N lines waiting for
review" card linking there, and Review in the navigation carries the pending count
of the month it opens on (from `GET /api/periods`, refreshed after an upload, a
delete or a reset rather than polled).

On the Transactions page the merchant name can be renamed inline
(`PATCH /api/transactions/{id}` with `cleaned_merchant`). On a split parent the new
name is copied to its parts; a part cannot be renamed on its own (409). As with any
correction to an approved line, the new name is written to merchant memory, unless
the line is a transfer, `Uncategorized` or split.

## 4. Cross-ledger reconciliation and the transfer buffer

`app/services/transfers.py` implements the blueprint's timing buffer:

1. A transaction matching a payment pattern, or a rule with `is_internal_transfer`, is
   flagged `is_internal_transfer` and inserted into `transfer_buffer` as `unmatched`.
2. The engine looks for an inverse counterpart on a *different* account: amount within
   `amount_tolerance` (**±0.01**) of the negated amount, date within
   `match_window_days` (**±7** calendar days), itself unmatched and not already linked.
   Closest date wins; ties break deterministically.
3. Both transactions get `linked_transfer_id` pointing at each other and both buffer
   rows become `matched` with `resolved_at`.
4. Unmatched rows persist across period closes and never block settlement; matching
   runs after every upload and on demand (`POST /api/transfers/rematch`). Entries can
   be linked by hand (`/match`) or marked **`ignored`**, a third state for entries that
   will never find a counterpart.

Transfers, matched or not, are excluded from settlement and from the expense views.
A rule with `transfer_to_account` (cash moved to an investment account) also writes a
**mirror entry** on the target account: the inverse amount, `source=transfer`,
`auto_approved`, `raw_description` prefixed `MIRROR `, linked to its source. Removing
or un-flagging the source leg deletes its mirror rather than leaving an orphan.

## 5. Periods

One `ledger_periods` row per calendar month (`YYYY-MM`). Closing a period
(`POST /api/periods/{key}/close`) refuses with 409 while transactions are still
`pending_review` unless `force=true`, then runs the Auditor, writes the settlement
snapshot and locks the period. While closed, `PATCH`, approve, split and delete on
its transactions, and delete on its claims, return 409; uploads adding new lines and
claims dated in it are refused the same way. Reopening lifts the lock; the snapshot
stays and is shown next to the live figure.

## 6. Settlement maths (`app/services/settlement.py`)

**Allocation.** For a signed `amount` and a claim type, the primary user's fraction is

| claim type            | primary fraction                                              |
|-----------------------|---------------------------------------------------------------|
| `shared_proportional` | `primary_ratio = income_p / (income_p + income_s)` from config |
| `shared_equal`        | 0.5                                                           |
| `primary_personal`    | 1                                                             |
| `secondary_personal`  | 0                                                             |
| `personal`            | 1 if the account owner is primary, else 0                     |

`allocated_primary = round_half_up(amount × fraction, rounding_decimals)` and
`allocated_secondary = amount − allocated_primary`, the **exact remainder**, so the
pair always sums to the amount and no penny is created or lost.

**Payer.** For a transaction the payer is `AppConfig.payer_for_account`: the account's
`billed_to` if set, else the **primary user for `credit_supplementary` accounts**
(the supplementary card is billed to the main cardholder), else the owner. For a
partner claim it is `paid_by` (a secondary session can only claim for themselves).

**The four sums.** Over approved (`auto_approved` / `manual_approved`),
non-transfer, non-`Transfers:*` transactions and all the period's claims:

```
net_owed_by_secondary =
    + Σ secondary share of shared items paid by primary        (secondary_share_of_primary_paid_shared)
    − Σ primary share of shared items paid by secondary        (primary_share_of_secondary_paid_shared)
    + Σ secondary_personal items paid by primary               (secondary_personal_on_primary_paid)
    − Σ primary_personal items paid by secondary               (primary_personal_on_secondary_paid)
```

Each item contributes to exactly one sum; an item borne entirely by its payer has no
effect and is left out of `lines`. Refunds carry their sign through, so a refunded
shared item reduces the debt. Approved credits categorised `Transfers:Settlement`
(the partner's transfer to you) are reported as `settlement_payments_received` and are
neither spend nor income. The API also reports `pending_review_count` so the UI can
warn that the figure may still move.

**Snapshot and due date.** Closing a period upserts the summary into
`settlement_snapshots` (the persisted settlement ledger). `settlement_due_date` is
`settlement.settlement_day_of_month` in the month after the period.

## 7. Split transactions

A transaction can be split into parts, each with its own amount, category,
subcategory and claim type, for the classic mixed receipt (£10 at the supermarket:
£6 groceries shared by income, £4 a personal item).

**Data model.** Parts are ordinary rows in `transactions`:

* the parent is flagged `is_split = true`; it keeps its money fields but carries no
  money of its own for reporting purposes;
* each part has `split_parent_id` (FK to the parent, `ON DELETE CASCADE`) and a
  `split_index` for ordering, plus its own `amount`, `category`, `subcategory`,
  `claim_type` and allocations computed with the usual `allocate()`;
* parts copy the parent's `period_key`, `account_id`, dates, `cleaned_merchant`,
  `raw_description` and `source_file`; they have **no fingerprint** and never enter the
  transfer buffer, while the parent keeps its fingerprint so a re-upload still
  dedupes;
* invariants (`app/services/splits.py`): 2 to 20 parts, every part non-zero and
  signed like the parent, none larger than the parent, and the parts summing
  **exactly** to the parent's amount after quantisation; a zero-amount transaction
  cannot be split.

**Status.** Parts share the parent's review status; splitting is an act of review, so
the parent (and its parts) are recorded `manual_approved` with `classification_source
= manual`. Nothing is written to merchant memory for a split: a receipt that needed
splitting is not evidence about the merchant in general.

**Where parts count.**

| view / engine                   | parent            | parts                                   |
|---------------------------------|-------------------|-----------------------------------------|
| settlement                      | excluded          | included (each with its own claim type) |
| Macro / Micro metrics, trends   | excluded          | included                                |
| Auditor                         | excluded          | included                                |
| Liquidity view                  | **included**      | excluded (the parent is the real cash movement) |
| `GET /api/transactions` list    | listed, with `parts` embedded; a `category` filter also matches parents with a part in that category | not listed on their own |
| `GET /api/periods` counts       | counted           | counted through their parent            |

**Rules.** Splitting is refused with 409 for internal transfers, for transactions in
a closed period (like every other edit) and for parts themselves (no nesting);
invalid parts are a 422. Once split, the parent's category, subcategory and claim
type cannot be edited (edit the parts or remove the split), neither the parent nor a
part can be flagged as an internal transfer, a part cannot be deleted on its own, and
the merchant is renamed on the parent and copied to its parts.

**Endpoints.** `PUT /api/transactions/{id}/split` creates the parts, replacing any
earlier split; `DELETE /api/transactions/{id}/split` deletes the parts and leaves the
parent as an ordinary, still approved, row; a part's category, subcategory or claim
type is edited through `PATCH /api/transactions/{part_id}`, which recomputes its
allocations. See `API.md` for the payloads.

## 8. Metrics (`app/services/metrics.py`)

Unless stated otherwise a view covers the period's approved transactions and leaves
out internal transfers, anything categorised `Transfers:*` and, for the two expense
views, `Income:*` (a salary credit must not shrink "household burn" or "true net
expense"; refunds keep their spend category and still net off). Partner claims are
positive costs and are included whether or not they are settled.

* **Macro / household burn:** `primary_accounts_burn` = Σ |debits| across all accounts
  (gross, refunds not netted) + `partner_claims_burn` = Σ claim amounts. `by_category`
  is the same gross figure per category plus a `Partner claims` row, so it adds up to
  the headline; `refunds` = Σ credits in spend categories, shown but never deducted.
* **Micro / true net expense:** Σ `−allocated_primary_amount` (refunds and credits
  reduce it) + Σ `partner_claims.primary_owes`; claims appear under the
  pseudo-category `Partner claims`.
* **Liquidity / cash flow:** literal cash movement on `checking` and `savings`
  accounts, every review status, transfers included: `credits − debits`, per account.
* **Trends:** the three headline figures for the last *n* months (zeros for empty
  months).
* **Investment (cash basis):** per `investment_cash` account, over all periods, using
  only the mirror rows: `net_invested_capital = deposits − withdrawals`,
  `realized_gain = max(withdrawals − deposits, 0)`. This is the `investment_position`
  SQL view; totals sum per-account figures so one account's gain is never offset by
  another's deposits.

## 9. The Auditor (Agent 3, `app/services/auditor.py`)

"Spend" here means approved, negative-amount, non-transfer, non-`Transfers:*`
transactions.

1. **Statistical anomalies.** Merchants are grouped by `cleaned_merchant`
   (case-insensitive) and totalled per period over the current period and the
   `auditor.lookback_periods` (3) before it. A merchant is *recurring* when it has
   spend in at least two of the prior periods. The baseline is the **median** of its
   prior per-period totals; the current total is flagged when
   `|current − median| / median > auditor.deviation_threshold` (**0.15**). The
   population **standard deviation** of the prior totals is reported as
   `baseline_stddev` for context, not used as a second trigger. Each anomaly points at
   the merchant's largest current-period transaction.
2. **Category comparison.** Per-category spend against the average of the prior
   periods that carry any approved spend (`baseline_periods`): a month before the
   first statement is not a month of zero spend, so a fresh install's first audits
   are not inflated. A category absent from a month that has data still counts as
   zero for that month. With no prior data the baseline is 0 and `change_pct` null.
3. **Narrative.** The LLM receives **aggregates only**: category totals, baseline
   averages, percentage changes, `baseline_periods` and the anomaly list, never line
   items, together with the configured currency (in the payload and in the prompt),
   and must answer `{"summary_sentence": ...}` in at most 60 words. If no LLM is
   configured, the call fails, the answer is off-contract or it quotes another
   currency (`$212.00` on a GBP ledger), a deterministic sentence is built from the
   same numbers, so an audit always succeeds. That sentence names the months it
   compares against ("up 1.5% on the average of the previous 2 months with data")
   when fewer than the look-back carried spend.

Reports are appended to `audit_reports`; closing a period runs one automatically and
`POST /api/audit/{key}/run` re-runs it at any time, including on a closed period.

## 10. Security model

* **Authentication.** Two shared passwords, `PRIMARY_PASSWORD` and
  `SECONDARY_PASSWORD`, compared in constant time and exchanged for signed,
  time-limited bearer tokens (`itsdangerous`, `SESSION_TTL_SECONDS`, 30 days). There
  is no user table. Each token carries a short tag of the password it was issued for,
  so rotating a password logs that role out everywhere. `primary` can do everything;
  `secondary` can only log and list claims, delete their own unsettled claims, and
  read the settlement and public config.
* **Startup guard.** The backend refuses to start when `SECRET_KEY` is a placeholder
  or shorter than 32 characters, when either password is a placeholder or shorter than
  8 characters, or when the two passwords are the same.
* **Login throttle.** Five failed logins from one client address within 15 minutes
  lock that address out for 60 s; each further lockout doubles, capped at 15 minutes.
  The address is the one nginx vouches for: it overwrites `X-Forwarded-For` with the
  connecting address, and the backend reads the last entry, so a client cannot dodge
  the throttle or aim it at someone else by sending its own header.
  The API answers 429 with `Retry-After`.
* **Uploads.** Files are written to the upload directory (created mode 700) under a
  random prefix followed by the sanitised original file name (`<uuid>_<name>`; the
  name is also kept in `statement_uploads.filename`), capped at 25 MB, deleted after
  ingestion unless `KEEP_UPLOADED_FILES=true`; only the sha256 is kept for duplicate
  detection.
* **Prompt hygiene.** Statement text sent to a model is JSON-quoted and clipped to
  200 characters, few-shot examples below 0.5 similarity are dropped, the system prompt
  states that the text is data and never instructions, and every model answer is
  validated against the configured taxonomy. The Auditor never sees line items.
* **Network.** Only the frontend's port 80 is published to the network; `db`,
  `litellm` and `backend` are bound to `127.0.0.1` on the host. Provider keys reach
  the LiteLLM container only. The OpenAPI docs are unauthenticated but reachable only
  from the host; `/api/health` is reachable without login through the web port (nginx
  proxies `/api/`) and reports only whether the app and its database are up. Everything
  is plain HTTP: keep it on the LAN or behind TLS.
* **Browser.** nginx sends `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer` and a CSP with `default-src 'self'` (no external
  scripts, fonts or images; `style-src` also allows `'unsafe-inline'`, which the
  chart library's inline style attributes need; `img-src` also allows `data:`;
  `frame-ancestors 'none'`, `object-src 'none'`). The SPA loads nothing from
  third-party origins.
* **Repository hygiene.** `.gitignore` excludes `.env`, `config.yaml`, uploads and
  every statement format. `.gitleaks.toml` extends the default secret rules with UK
  PII patterns (sort code + account number, labelled sort codes, IBANs, card numbers,
  labelled postcodes, e-mail addresses). Pre-commit hooks run gitleaks, a private-key
  detector, large-file and YAML checks and a guard that refuses to commit personal
  files. CI (`.github/workflows/ci.yml`) runs `ruff` and the backend suite against a
  pgvector service, `ruff` (with the backend's configuration) and a compile check on
  `updater/updater.py`, the frontend lint / type-check / tests / build, and a
  full-history gitleaks scan on every push.

## 11. Configuration

### `config.yaml` (optional, untracked; start from `config.example.yaml`)

Every section below is a *default*: the app stores what you save under Settings in
`app_settings` (documents `household`, `categories`, `rules`, `ai`) and the
`accounts` table, and overlays them on the file per request. Without a file the
built-in defaults are two users (`user_primary`, `user_secondary`) splitting 50/50,
the standard categories and card-payment patterns, no rules and no accounts.

| section               | what it drives                                                                              |
|-----------------------|---------------------------------------------------------------------------------------------|
| `app`                 | `base_currency`, `currency_symbol`, `data_dir` (default parent of the upload directory)     |
| `users`               | `primary` / `secondary`: `id`, `display_name`, `base_salary_pa`, `additional_income_pa`; the income ratio is derived at load time |
| `settlement`          | `split_strategy` (`salary_proportional` \| `equal_50_50`), `rounding_decimals`, `settlement_day_of_month` (1–28) |
| `accounts`            | `id`, `institution` (as printed on statements; used to map uploads), optional `label` (a friendlier display name shown in the app in place of institution and account type, e.g. `HSBC Premier ··4471`; the last four digits are always appended), `account_type` (`checking`, `savings`, `credit`, `credit_supplementary`, `investment_cash`), `owner` (the spender), `identifier_last4`, `default_claim_type`, optional `billed_to` |
| `deterministic_rules` | ordered regex → `category`, `claim_type`, optional `merchant`, `subcategory`, `is_internal_transfer`, `transfer_to_account` |
| `transfers`           | `payment_patterns` (card-payment regexes), `match_window_days`, `amount_tolerance`          |
| `llm`                 | `chat_model`, `embedding_model` (logical names from `litellm/config.yaml`), optional `extraction_model` and `audit_model` (the models for PDF layout extraction and the monthly summary; both default to `chat_model`), `similarity_threshold`, `top_k` |
| `auditor`             | `deviation_threshold`, `lookback_periods`                                                   |
| `categories`          | the taxonomy offered to the classifier and the UI (`Uncategorized` is always appended)      |

Validation at load, and again on every save from Settings: distinct user ids, unique
account ids, owners and `billed_to` must be configured users, `transfer_to_account`
must name an account, regexes must compile, categories on rules must be in the
taxonomy, and `salary_proportional` needs a positive combined income.
`GET /api/config` exposes a sanitised subset (no incomes, no rules); the full
documents are under `/api/settings/*` for the primary login (docs/API.md).

### `.env` (read by Docker Compose and the backend)

| variable                                   | purpose                                                                          |
|--------------------------------------------|----------------------------------------------------------------------------------|
| `DB_PASSWORD`                              | PostgreSQL password; fixed in the volume on first start                          |
| `LITELLM_MASTER_KEY`                       | the master key of Settl's own LiteLLM (the backend presents it to that container)|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`      | provider keys, injected into the `litellm` container only                        |
| `SECRET_KEY`                               | token signing key (≥ 32 random characters)                                       |
| `PRIMARY_PASSWORD`, `SECONDARY_PASSWORD`   | the two role passwords (≥ 8 characters, different)                               |
| `COMPOSE_PROFILES`                         | `bundled-litellm` (default) starts Settl's own proxy; empty = bring your own      |
| `LITELLM_URL`, `LITELLM_API_KEY`           | a LiteLLM you already run; when set it is the default choice under Settings → AI → Proxy |
| `LLM_PROVIDER`                             | `litellm` \| `none` : the default for "Use AI" in Settings → AI                   |
| `EMBEDDING_PROVIDER`                       | `litellm` \| `hash` : the default embedding provider in Settings → AI             |
| `KEEP_UPLOADED_FILES`                      | `false` (default) deletes statements after ingestion                             |
| `UPDATE_CHECK`                             | `true` (default) lets Settings → System ask `api.github.com` for the newest commits; `false` never contacts GitHub |
| `UPDATE_REPO`, `UPDATE_BRANCH`             | the GitHub `owner/repo` and branch compared with the running code (defaults `mattiaborsoi/personal-finance`, `main`); the updater pulls the same branch |

The backend also reads (set by `docker-compose.yml`, or defaults for local
development): `DATABASE_URL`, `BUNDLED_LITELLM_URL` (Compose sets
`http://litellm:4000`; `http://localhost:4000` outside Docker), `UPDATER_URL`
(`http://updater:9000`), `CONFIG_PATH`,
`UPLOAD_DIR`, `SESSION_TTL_SECONDS`, `LLM_TIMEOUT_SECONDS` (default 90: the PDF
extraction timeout and the ceiling for the 20 s classification and 60 s audit
timeouts), `EMBEDDING_DIMENSIONS` (must be 1536) and `CORS_ORIGINS`.

## 12. Database schema (`backend/app/schema.sql`)

| object                  | purpose                                                                                     |
|-------------------------|---------------------------------------------------------------------------------------------|
| `accounts`              | the accounts (seeded once from `config.yaml`, then edited in the app): `label`, `default_claim_type`, `billed_to`, `is_active` (archived keeps history), `sort_order` |
| `app_settings`          | one JSONB document per `key`, saved from Settings (`household`, `categories`, `rules`, `ai`); each overrides the matching `config.yaml` / `.env` defaults |
| `ledger_periods`        | one row per `YYYY-MM`, `is_closed`, `closed_at`                                             |
| `statement_uploads`     | file provenance and sha256 for duplicate detection; `period_from` / `period_to` (the months the file spans, NULL on older rows) beside the legacy `period_key` |
| `transactions`          | the master ledger: amounts, category, `claim_type`, generated `is_claimable`, the two allocations, `review_status`, transfer flag and link, `classification_source` / `_confidence`, `fingerprint`, the split columns `is_split`, `split_parent_id`, `split_index`, `source_file`, `upload_id` (nullable FK to `statement_uploads`, `ON DELETE SET NULL`; set on the upload's lines, their split parts and mirror legs, NULL on older rows), and `note` (nullable free text, at most 500 characters, the user's own words on what the payment was; `raw_description` is never edited because the fingerprint is built from it) |
| `merchant_memory`       | `raw_pattern` (normalised key, unique), merchant, category, claim type, `vector(1536)` embedding with an HNSW cosine index, `review_count` |
| `partner_claims`        | claims logged at `/claim`: positive `amount`, `paid_by`, `primary_owes` / `secondary_owes`, `is_settled` |
| `transfer_buffer`       | one row per transfer leg, `match_status` `unmatched` \| `matched` \| `ignored`              |
| `audit_reports`         | Auditor output per run: sentence, anomalies and category comparison as JSONB               |
| `settlement_snapshots`  | the settlement ledger: the four sums, net, payments received and line count at close       |
| `investment_position`   | view: deposits, withdrawals, net invested capital and realised gain per `investment_cash` account |

Enums: `account_type_enum`, `claim_type_enum`, `review_status_enum`
(`pending_review`, `auto_approved`, `manual_approved`), `transfer_state_enum`.
The file is re-run on every start; new columns are added with
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so there is no separate migration tool.

## 13. Design decisions (deviations from the blueprint)

* **`primary_personal` claim type** was added to the enum so that "primary personal
  items paid on secondary cards/claims" from the settlement formula can be recorded.
* **Allocation rounding:** the primary share is rounded (half-up) and the secondary
  share is the exact remainder, so allocations always sum to the amount and no penny is
  lost. The blueprint rounds both sides independently.
* **Periods are calendar months** keyed by each transaction's own date, so a card
  statement closing on the 28th spills its late-July lines into July. The span of
  months a file touched is kept on the upload record for provenance (`period_from` /
  `period_to`; `period_key` still names the newest). This keeps the Auditor's rolling
  windows and the settlement month intuitive for both users.
* **Closed periods are locked:** edits, approvals, splits and deletions in a closed
  period return 409 (reopen first); the transfer buffer keeps matching across closes
  as the blueprint requires. The settlement figure at close is stored in
  `settlement_snapshots` (the persisted settlement ledger) and shown next to the live
  figure.
* **Expense views exclude income:** Macro and Micro leave out `Income:*` categories as
  well as transfers, so a salary credit cannot shrink "household burn" or "true net
  expense"; refunds still net off in the Micro view. The Macro headline is gross
  debits and so is its category breakdown (plus a `Partner claims` row), so the rows
  reconcile with the headline; refunds are reported separately as `refunds`.
* **Memory threshold is "at or above" 0.82**, the learning loop runs on approve *and*
  on corrections to already-approved transactions, transfers and `Uncategorized`
  answers are never remembered, and few-shot examples below 0.5 similarity are not
  sent to the model.
* **Auditor:** the flag uses the rolling median as specified; the standard deviation of
  the prior periods is reported alongside (`baseline_stddev`) rather than used as a
  second trigger. Recurring means seen in at least two of the prior three periods.
  The category baseline averages only the prior periods with data, and the narrative
  states the currency and rejects an LLM answer in any other.
* **Transfer buffer** has an extra `ignored` state for entries that will never match.
  Unmatched transfers are already excluded from spend (they are transfers whether or
  not the other statement has arrived).
* **Extra columns/tables:** `transactions.fingerprint` (idempotent re-uploads),
  `transactions.upload_id` (removing an upload with everything it brought in),
  `classification_source` / `classification_confidence` (approval-queue badges),
  `statement_uploads`, `audit_reports`, `settlement_snapshots`, `app_settings` (what
  is saved under Settings) and the `accounts` detail columns (`label`,
  `default_claim_type`, `billed_to`, `is_active`, `sort_order`) that let accounts be
  edited in the app.
* **Split transactions** are modelled as child rows in `transactions` rather than a
  separate table, so every engine (settlement, metrics, Auditor) sees parts through
  the same queries; the parent is filtered out of those engines with `is_split` and
  the parts out of the liquidity view, the list and the period counts with
  `split_parent_id`. A split approves the transaction, is never remembered (neither
  parent nor part, on approve or on a later correction), and is refused for
  transfers, closed periods and parts (no nesting).
* **Investment tracking** uses mirror transactions on the investment account created
  from a rule with `transfer_to_account`; removing or un-flagging the checking leg
  removes its mirror. Realised gain is `max(withdrawals − deposits, 0)` on a cash basis
  (see the `investment_position` view).
* **Settlement payments** received from the partner are categorised
  `Transfers:Settlement` by a rule and excluded from spend and income.
* **Auth** is two shared passwords (primary / secondary) exchanged for signed,
  time-limited bearer tokens; there is no user table by design.
* **LLM fallback caps** (PDF only, 20 calls per file, 60 pages) and the offline
  `hash` embedding provider were added so a bad upload cannot run up a bill and the
  system is usable with no provider at all.

## 14. Development setup

Backend (Python 3.11):

```bash
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/financemaster_test  # needs pgvector
pytest -v
ruff check .
```

Without `TEST_DATABASE_URL` (or `DATABASE_URL`, whose database name is suffixed
`_test` and created on demand) the database-backed tests are skipped and the
pure-logic tests still run. Each test runs in a transaction that is rolled back, the
LLM is a `FakeLLMClient` and embeddings use the hashing provider, so the suite is
fully offline. `tests/fixtures/generate.py` builds the synthetic statements at run
time; no real statement is ever checked in. Inside Docker,
`docker compose exec backend pytest -v` runs the same suite against a `_test`
database on the `db` container.

To run the API that the frontend dev server proxies to, start the database alone
and run uvicorn from `backend/`. Settings come from the environment and from a
`.env` in the current directory (here `backend/`, not the repository root), so
export what the startup guard needs:

```bash
docker compose up -d db          # PostgreSQL + pgvector on 127.0.0.1:5432
cd backend
export DATABASE_URL=postgresql://postgres:<DB_PASSWORD from .env>@localhost:5432/financemaster
export SECRET_KEY=$(openssl rand -hex 32) PRIMARY_PASSWORD=<8+ chars> SECONDARY_PASSWORD=<another>
export LLM_PROVIDER=none EMBEDDING_PROVIDER=hash   # optional: no proxy needed
uvicorn app.main:app --reload --port 8000
```

Without `CONFIG_PATH` it looks for `backend/config.yaml` and, finding none, starts
from the built-in defaults.

Frontend (Node 22):

```bash
cd frontend
npm ci
npm run dev        # http://localhost:5173, proxies /api to http://localhost:8000
npm test           # vitest, jsdom, fetch mocked
npm run lint       # eslint flat config with react-hooks
npm run build      # tsc --noEmit && vite build
```

Pre-commit hooks: `pip install pre-commit && pre-commit install`. A manual scan of
the working tree is `gitleaks detect --config .gitleaks.toml --no-git`.

A `docker-compose.override.yml` (git-ignored) can replace the `litellm` service with a
stub or inject build-time settings for local verification.

## 15. Repository layout

```
├── README.md, CONTRIBUTING.md, SECURITY.md, LICENSE
├── docker-compose.yml          # db (pgvector), litellm (optional), backend, frontend (nginx), updater (optional)
├── config.example.yaml         # sanitised template for the optional, untracked config.yaml
├── .env.example                # runtime secrets template
├── .gitignore, .dockerignore   # secrets, statements, caches; the backend build context (repo root) trimmed
├── .gitleaks.toml              # secret + UK PII rules; .pre-commit-config.yaml wires them in
├── .github/                    # workflows/ci.yml (ruff, pytest, updater lint, frontend gates, gitleaks),
│                               # ISSUE_TEMPLATE/, PULL_REQUEST_TEMPLATE.md, CODEOWNERS
├── litellm/config.yaml         # logical model names -> providers
├── updater/                    # self-update sidecar: Dockerfile, updater.py (git pull + compose rebuild)
├── backend/
│   ├── Dockerfile, pyproject.toml (pytest, ruff), requirements.txt
│   ├── app/
│   │   ├── main.py             # FastAPI app, lifespan (guards, schema, account seeding)
│   │   ├── config.py           # Settings (.env) and AppConfig (config.yaml) models
│   │   ├── database.py         # engine, session factory, init_db (runs schema.sql)
│   │   ├── deps.py             # FastAPI dependencies: settings, config, AI settings, effective config
│   │   ├── auth.py             # passwords -> signed tokens, startup guard
│   │   ├── schema.sql          # canonical DDL, idempotent, run at start
│   │   ├── models.py           # SQLAlchemy mapping of schema.sql
│   │   ├── schemas.py          # Pydantic request/response models (API.md)
│   │   ├── routers/            # accounts, ai, audit, auth, categories, claims, memory, metrics, periods, reference,
│   │   │                       # settlement, site_settings, statements, system, transactions, transfers
│   │   └── services/
│   │       ├── parsers/        # Agent 1: tabular, pdf_table, pdf_text, llm_extractor, registry
│   │       │                   # (+ amounts, dates, columns, metadata, base helpers)
│   │       ├── rules.py        # deterministic rules + merchant name cleaner
│   │       ├── guesser.py      # Agent 2
│   │       ├── memory.py       # pgvector merchant memory
│   │       ├── embeddings.py   # LiteLLM / hashing embedding clients
│   │       ├── llm.py          # LiteLLM JSON client, Null and Fake clients
│   │       ├── providers.py    # builds the LLM / embedding clients from the AI settings
│   │       ├── ingestion.py    # upload orchestration, fingerprints, mirrors
│   │       ├── transfers.py    # transfer buffer and matching
│   │       ├── settlement.py   # allocation and the four sums
│   │       ├── settlement_snapshots.py
│   │       ├── splits.py       # split transactions
│   │       ├── metrics.py      # macro / micro / liquidity / investment
│   │       ├── auditor.py      # Agent 3
│   │       ├── accounts.py     # accounts table: seeding, create / edit / archive
│   │       ├── statement_uploads.py # removing an upload and every line it brought in
│   │       ├── site_settings.py # Settings -> Household, Categories, Rules documents
│   │       ├── category_suggestions.py # the category picker's suggestions
│   │       ├── ai_settings.py  # Settings -> AI: proxy, models, thresholds, connection test
│   │       ├── updates.py      # Settings -> System: GitHub check, updater client
│   │       ├── reset.py        # Settings -> System -> Danger zone: delete transactions / everything
│   │       └── periods.py
│   └── tests/                  # pytest suite; fixtures/generate.py builds synthetic statements
├── frontend/
│   ├── Dockerfile, .dockerignore, nginx.conf, nginx-security-headers.conf
│   ├── package.json, package-lock.json, vite.config.ts, tsconfig.json, eslint.config.js,
│   │   tailwind.config.js, postcss.config.js, index.html
│   ├── README.md               # scripts, production image, source layout
│   ├── DESIGN.md               # the design system
│   └── src/                    # main.tsx, App.tsx, api.ts, index.css; auth/, config/, test/
│       ├── pages/              # one per route: Dashboard, Review, Transactions, Upload, Transfers,
│       │                       # Claims, Claim (the partner's phone form), Memory, Settings, Login
│       ├── components/         # UI pieces, *.test.tsx alongside; the Settings tabs (AccountsPanel,
│       │                       # HouseholdPanel, CategoriesPanel, RulesPanel, AiPanel, SystemPanel
│       │                       # with DangerZone), UploadHistory, the form primitives Field, RadioOption
│       ├── hooks/              # useAsync; reviewBadge (keeps the Review count in the navigation current)
│       └── lib/                # ui, theme, money, dates, format, splits, views ...; household,
│                               # categories, rules (Settings tab logic), review, reset, navNotice
└── docs/                       # TECHNICAL.md (this file), API.md, BLUEPRINT.md,
                                # images/ (the README screenshots)
```

## 16. Frontend design system

The UI is a product, not an admin panel: token-driven colours shared by light and
dark mode, one typeface, one brand colour, three view accents, status never conveyed
by colour alone, British English in sentence case. The rules, tokens and component
primitives are documented in [`frontend/DESIGN.md`](../frontend/DESIGN.md); read it
before adding a component.
