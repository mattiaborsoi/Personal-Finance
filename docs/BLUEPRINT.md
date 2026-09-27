# System Specification & AI Execution Plan: Self-Hosted Personal Finance & Shared Ledger Engine

This is the original specification Settl was built from, kept for reference and not
maintained. It describes the design as planned, not the shipped product: where the
implementation deviates from or extends it, [`TECHNICAL.md`](TECHNICAL.md) section 13
("Design decisions") records why, and the rest of `TECHNICAL.md` describes what
actually runs.

## 1. System Overview & Architecture Blueprint

```
+---------------------------------------------------------------------------------+
|                                 CLIENT TIER                                     |
|  [ React / Vite / Tailwind SPA ] <---> [ Partner Mobile Expense Claim Form ]    |
+---------------------------------------------------------------------------------+
                                      |
                                  (REST API)
                                      |
+---------------------------------------------------------------------------------+
|                           APPLICATION SERVER (Docker)                           |
|  FastAPI Backend Orchestrator                                                   |
|   ├── Auth & Session Management (Local Token / Session)                         |
|   ├── Config Engine (Parses config.yaml, calculates salary splits)              |
|   ├── Deterministic Rules Engine (Regex & exact match pre-processing)           |
|   ├── Multi-Agent Subsystem:                                                    |
|   │     ├── Extractor Agent (PDF text/layout parser)                            |
|   │     ├── Guesser Agent (pgvector RAG few-shot via LiteLLM)                   |
|   │     └── Auditor Agent (Statistical deviations + Behavioral LLM)             |
|   └── Reconciliation & Transfer Buffer Engine                                   |
+---------------------------------------------------------------------------------+
          |                                                    |
     (Local HTTP)                                        (SQL / pgvector)
          |                                                    |
+----------------------+                             +----------------------------+
|  LiteLLM Proxy       |                             |  PostgreSQL 16 + pgvector  |
|  (Local Container)   |                             |  (Local Docker Volume)     |
|  Routes & tracks LLM |                             |  Master Ledger & Vectors   |
|  token spend         |                             +----------------------------+
+----------------------+
```

### Core Architecture Principles

1. **Zero Hardcoded PII / Public Repo Safety**: the codebase contains no personal
   identifiers, employer names, real account numbers, or individual salaries. All
   identities, account mappings and split formulas are driven by an untracked
   `config.yaml`. A sanitised `config.example.yaml` is provided.
2. **Dual-Ledger Separation**:
   * Master Ledger: 100 % of parsed transactions across all accounts, powering net
     worth, liquidity and personal cash-flow analytics.
   * Settlement Ledger: shared liabilities, partner claims and monthly reconciliation debts.
3. **Local-First with Controlled Cloud Compute**: everything runs in local Docker
   containers. External LLM interaction is isolated through a local LiteLLM proxy
   for strict cost control and API-key encapsulation.

## 2. Configuration & Data Anonymisation Engine

See `config.example.yaml`. Split ratios are derived from the configured incomes:

```
Primary   = 100,000 / 180,000 = 55.5556 %
Secondary =  80,000 / 180,000 = 44.4444 %
```

## 3. Database Schema (PostgreSQL + pgvector)

See `backend/app/schema.sql` (tables `accounts`, `ledger_periods`, `transactions`,
`merchant_memory`, `partner_claims`, `transfer_buffer`, plus `statement_uploads`,
`audit_reports` and the `investment_position` view).

## 4. Multi-Agent Ingestion & Reconciliation Pipeline

```
Statement Upload (PDF / XLS)
       |
       v
[ Deterministic PyMuPDF / Camelot Table Parser ]
       |
       +---> Fallback if parsing fails: [ Agent 1: LLM Layout Vision Extractor ]
       |
       v
Clean Standardized JSON Lines
       |
       v
[ Deterministic Config Matcher ]
       | (Match found? Apply category + claim_type directly)
       | (No match? Route to Agent 2)
       v
[ Agent 2: The Guesser (LiteLLM + pgvector Similarity) ]
       |
       v
Insert into Master Ledger (Status: 'pending_review')
       |
       v
[ Transfer Buffer Engine ] (Auto-match cross-statement Direct Debits)
       |
       v
[ Human Approval UI ] (Confirm / Adjust / Train pgvector)
       |
       v
[ Agent 3: The Auditor ] (On-Demand Anomaly & Trend Analysis)
```

### Agent 1: Statement Extractor & Parser

* Strategy: deterministic Python libraries (`pdfplumber`, `pypdf`, `pandas`) for
  standard statements. If unstructured or poorly formatted, hand pages to an LLM via
  LiteLLM with structured output parsing.
* Extraction schema:

```json
{
  "statement_metadata": {
    "institution": "Amex",
    "account_last4": "7715",
    "closing_date": "2026-08-28",
    "statement_period": "2026-07-29 to 2026-08-28"
  },
  "transactions": [
    {
      "date": "2026-08-14",
      "post_date": "2026-08-14",
      "raw_text": "SP PIMORONI LTD LONDON",
      "amount": -45.90,
      "card_last4": "7715",
      "foreign_spend": null
    }
  ]
}
```

### Agent 2: The Guesser (pgvector learning without token bloat)

1. Pre-processing: if the merchant matches a `config.yaml` regex, skip the LLM.
2. Vector lookup:

```sql
SELECT normalized_merchant, category, default_claim_type,
       1 - (embedding <=> :query_embedding) AS similarity
FROM merchant_memory
WHERE 1 - (embedding <=> :query_embedding) > 0.82
ORDER BY similarity DESC
LIMIT 3;
```

3. Inference (LiteLLM): if no high-confidence vector match exists, send a minimal
   payload containing only the merchant string and the top-3 closest past examples.
4. Learning feedback loop: when the user approves or corrects a transaction in the
   web UI, write the confirmed classification back into `merchant_memory` with an
   updated embedding.

### Cross-Ledger Reconciliation & Timing Buffer

* The problem: direct debits for credit cards leave checking accounts days before or
  after the card statement closing date.
* The buffer algorithm:
  1. Any transaction matching credit-card payment patterns (e.g. `PAYMENT RECEIVED -
     THANK YOU`, `HSBC CARD PYMT`, `PAYMENT DD THANK YOU`) is marked
     `is_internal_transfer = TRUE`.
  2. The record is inserted into `transfer_buffer` with state `unmatched`.
  3. The reconciliation engine searches for an inverse transaction (amount match
     ±0.01, date within ±7 calendar days) across other accounts.
  4. If found, both transactions get `linked_transfer_id` and are set to `matched`.
     They are excluded from monthly expense aggregations to prevent double counting.
  5. If unmatched, the transaction remains in the buffer across ledger-period closes
     without blocking monthly settlement.

### Agent 3: The Auditor (anomaly detection)

Triggered per ledger period before closing.

1. Deterministic statistical analysis: rolling 3-month median and standard deviation
   for recurring bills; flag any recurring bill where
   `|Amount_current − Median_prior| / Median_prior > 0.15`.
2. LLM behavioural analysis: feed grouped aggregated category spend (not individual
   line items) comparing the current period vs the previous 3-period averages.
3. Output: a single concise narrative summary and a structured JSON array of
   transaction ids:

```json
{
  "summary_sentence": "August expenses increased by 14% primarily due to high travel dining and an unexpected £22 increase in East London Energy compared to your 3-month average.",
  "anomalies": [
    {
      "transaction_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "merchant": "East London Energy",
      "issue": "Price deviation: £61.82 vs 3-month average of £45.10"
    }
  ]
}
```

## 5. Dual-Ledger Calculation Engine & Investment Tracking

### Settlement split formula

```
R_p = Salary_primary / (Salary_primary + Salary_secondary)
R_s = 1 − R_p
Allocated_primary   = round(E × R_p, 2)
Allocated_secondary = round(E × R_s, 2)
```

### End-of-month settlement resolution

```
Net owed by secondary =
    Σ (secondary share of primary-paid shared expenses)
  − Σ (primary share of secondary-paid shared expenses)
  + Σ (secondary personal items paid on primary cards)
  − Σ (primary personal items paid on secondary cards)
```

### Multi-view metrics

* Total Household Burn (Macro): Σ |debit transactions| (excluding internal transfers)
  across both primary accounts and secondary claims.
* True Net Expense (Micro): Σ Allocated_primary for all approved transactions.
* Liquidity / Cash Flow: Σ credits_checking − Σ debits_checking.

### Investment cash-basis tracking (Phase 1)

* Transfers from checking to `acc_invest_robinhood` are marked `is_internal_transfer = TRUE`.
* Net Invested Capital = Σ transfers in − Σ transfers out (database view).
* Realised gain/loss on withdrawal: when a transfer occurs from the investment account
  back to checking, if total historical withdrawals exceed total historical deposits,
  the delta is flagged as Investment Gain/Loss.

## 6. Implementation Roadmap

* Phase 1: Docker infrastructure (`docker-compose.yml`: postgres+pgvector, litellm,
  backend, frontend).
* Phase 2: config engine (`pydantic-settings`), SQLAlchemy models, settlement tests
  (rounding edge cases, credit adjustments).
* Phase 3: pdfplumber parser service, pgvector store, LiteLLM wrapper with strict JSON,
  transfer matching buffer.
* Phase 4: React/Vite dashboard (global Macro/Micro/Liquidity toggle, approval queue,
  audit card, settlement banner) and mobile `/claim` route.

## 7. Synthetic Test Fixtures

### Fixture 1: credit card statement parsing

Card primary (last 4: 7715):
* `Jul 31 | CINEWORLD | 20.99` → Entertainment, personal
* `Aug 04 | ANTHROPIC | 18.40 (USD 24.00)` → Subscriptions:Software, personal
* `Aug 15 | WAITROSE | 15.81` → Groceries, shared_proportional
* `Aug 24 | BRITISH AIRWAYS | -357.99 CR` → Travel, shared_proportional (refund)

Card supplementary (last 4: 3348):
* `Jul 28 | WAITROSE | 16.40` → Groceries, shared_proportional
* `Jul 30 | ZOOM OCADO | 37.89` → Groceries, shared_proportional
* `Aug 07 | NETFLIX | 5.99` → Subscriptions:Entertainment, shared_equal

### Fixture 2: checking account ingestion & DD matching

* `28 Jul | HSBC CARD PYMT | Paid Out: 3,384.21` → should match the credit statement payment.
* `03 Aug | NORTHWIND ENERGY | Paid Out: 87.27` → Bills:Energy, shared_proportional
* `03 Aug | FIBRELINE BROADBAND | Paid Out: 30.00` → Bills:Internet, shared_proportional
* `03 Aug | PARTNER TRANSFER CR | Paid In: 1,685.73` → internal settlement credit

### Fixture 3: anomaly detection

* Northwind Energy history: May £68.20, June £68.20, July £68.20, August (test) £87.27.
* Assert: the auditor flags Northwind Energy (Δ > +27 %).

## 8. Docker Deployment & Repository Maintenance

* `.gitignore` must exclude `.env`, `*.pdf`, `*.xlsx`, `*.csv`, `config.yaml`,
  `uploads/`, `__pycache__/`, `pgdata/`, `node_modules/`.
* Pre-commit hook: `detect-secrets` or `gitleaks` to block commits containing names,
  postcodes, bank identifiers or API keys.
* Verification:

```bash
docker compose up -d --build
docker compose exec backend pytest -v
```
