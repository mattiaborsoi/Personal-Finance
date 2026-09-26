-- Canonical schema for the Personal Finance & Shared Ledger Engine.
-- Every statement is idempotent; app.database.init_db() runs this file at
-- startup and the test-suite runs it against a scratch database.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Enum Definitions --------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE account_type_enum AS ENUM
        ('checking', 'savings', 'credit', 'credit_supplementary', 'investment_cash');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 'primary_personal' extends the blueprint so that "primary personal items paid
-- on secondary cards / claims" can be expressed (needed by the settlement formula).
DO $$ BEGIN
    CREATE TYPE claim_type_enum AS ENUM
        ('personal', 'shared_proportional', 'shared_equal', 'secondary_personal', 'primary_personal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE review_status_enum AS ENUM ('pending_review', 'auto_approved', 'manual_approved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE transfer_state_enum AS ENUM ('unmatched', 'matched', 'ignored');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Accounts Registry ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
    id VARCHAR(64) PRIMARY KEY,
    institution VARCHAR(64) NOT NULL,
    account_type account_type_enum NOT NULL,
    owner_user_id VARCHAR(64) NOT NULL,
    identifier_last4 VARCHAR(8) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Ledger Periods (Statement Batches) ---------------------------------------
CREATE TABLE IF NOT EXISTS ledger_periods (
    period_key VARCHAR(7) PRIMARY KEY, -- Format: YYYY-MM
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_closed BOOLEAN DEFAULT FALSE,
    closed_at TIMESTAMP WITH TIME ZONE
);

-- Uploaded statement files (dedupe + provenance) ---------------------------
CREATE TABLE IF NOT EXISTS statement_uploads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id VARCHAR(64) REFERENCES accounts(id),
    period_key VARCHAR(7) REFERENCES ledger_periods(period_key),
    filename VARCHAR(255) NOT NULL,
    sha256 VARCHAR(64) NOT NULL,
    parser VARCHAR(64),
    transaction_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Master Ledger Transactions -----------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    period_key VARCHAR(7) REFERENCES ledger_periods(period_key),
    account_id VARCHAR(64) REFERENCES accounts(id),
    transaction_date DATE NOT NULL,
    post_date DATE,
    raw_description TEXT NOT NULL,
    cleaned_merchant VARCHAR(255) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL, -- Negative for debit, positive for credit/refund
    currency VARCHAR(3) DEFAULT 'GBP',
    original_currency VARCHAR(3),
    foreign_amount NUMERIC(12, 2),
    category VARCHAR(128) NOT NULL,
    subcategory VARCHAR(128),

    -- Dual Ledger & Settlement Routing
    claim_type claim_type_enum NOT NULL DEFAULT 'personal',
    is_claimable BOOLEAN GENERATED ALWAYS AS (claim_type != 'personal') STORED,
    allocated_primary_amount NUMERIC(12, 2) NOT NULL,
    allocated_secondary_amount NUMERIC(12, 2) NOT NULL,

    -- State Management
    review_status review_status_enum DEFAULT 'pending_review',
    is_internal_transfer BOOLEAN DEFAULT FALSE,
    linked_transfer_id UUID REFERENCES transactions(id),

    -- Classification provenance (rule | memory | llm | manual | transfer | none)
    classification_source VARCHAR(16) NOT NULL DEFAULT 'none',
    classification_confidence NUMERIC(4, 3),

    -- Idempotent ingestion: sha256 of (account, date, amount, description, occurrence)
    fingerprint VARCHAR(64) UNIQUE,

    -- Split transactions: a parent flagged is_split carries no money of its own;
    -- its parts (split_parent_id -> parent, ordered by split_index) each have their
    -- own amount, category, claim type and allocations and sum to the parent amount.
    is_split BOOLEAN NOT NULL DEFAULT FALSE,
    split_parent_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
    split_index INT,

    -- Auditing & Search
    source_file VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
-- Upgrades for databases created before split transactions existed.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_split BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS split_parent_id UUID REFERENCES transactions(id) ON DELETE CASCADE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS split_index INT;
CREATE INDEX IF NOT EXISTS ix_transactions_period ON transactions (period_key);
CREATE INDEX IF NOT EXISTS ix_transactions_account_date ON transactions (account_id, transaction_date);
CREATE INDEX IF NOT EXISTS ix_transactions_review_status ON transactions (review_status);
CREATE INDEX IF NOT EXISTS ix_transactions_merchant ON transactions (cleaned_merchant);
CREATE INDEX IF NOT EXISTS ix_transactions_split_parent ON transactions (split_parent_id);

-- Vector Memory Store for Agent 2 (Few-Shot Retrieval) ---------------------
CREATE TABLE IF NOT EXISTS merchant_memory (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_pattern TEXT UNIQUE NOT NULL,
    normalized_merchant VARCHAR(255) NOT NULL,
    category VARCHAR(128) NOT NULL,
    default_claim_type claim_type_enum NOT NULL,
    embedding vector(1536), -- Compatible with text-embedding-3-small or equivalent
    review_count INT DEFAULT 1,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_merchant_memory_embedding
    ON merchant_memory USING hnsw (embedding vector_cosine_ops);

-- Partner Manual Expense Claims --------------------------------------------
CREATE TABLE IF NOT EXISTS partner_claims (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    period_key VARCHAR(7) REFERENCES ledger_periods(period_key),
    claim_date DATE NOT NULL,
    paid_by VARCHAR(64) NOT NULL,
    merchant VARCHAR(255) NOT NULL,
    description TEXT,
    amount NUMERIC(12, 2) NOT NULL,
    claim_type claim_type_enum NOT NULL DEFAULT 'shared_proportional',
    primary_owes NUMERIC(12, 2) NOT NULL,
    secondary_owes NUMERIC(12, 2) NOT NULL,
    is_settled BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_partner_claims_period ON partner_claims (period_key);

-- Unmatched Transfer Buffer (Cross-Ledger Timing) --------------------------
CREATE TABLE IF NOT EXISTS transfer_buffer (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
    account_id VARCHAR(64) REFERENCES accounts(id),
    amount NUMERIC(12, 2) NOT NULL,
    transaction_date DATE NOT NULL,
    match_status transfer_state_enum DEFAULT 'unmatched',
    resolved_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS ix_transfer_buffer_status ON transfer_buffer (match_status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_transfer_buffer_transaction ON transfer_buffer (transaction_id);

-- Auditor output per period ------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    period_key VARCHAR(7) REFERENCES ledger_periods(period_key),
    summary_sentence TEXT NOT NULL,
    anomalies JSONB NOT NULL DEFAULT '[]'::jsonb,
    category_comparison JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_audit_reports_period ON audit_reports (period_key, created_at DESC);

-- Settlement ledger: the reconciliation debt recorded when a period is closed ----
CREATE TABLE IF NOT EXISTS settlement_snapshots (
    period_key VARCHAR(7) PRIMARY KEY REFERENCES ledger_periods(period_key),
    net_owed_by_secondary NUMERIC(12, 2) NOT NULL,
    secondary_share_of_primary_paid_shared NUMERIC(12, 2) NOT NULL,
    primary_share_of_secondary_paid_shared NUMERIC(12, 2) NOT NULL,
    secondary_personal_on_primary_paid NUMERIC(12, 2) NOT NULL,
    primary_personal_on_secondary_paid NUMERIC(12, 2) NOT NULL,
    settlement_payments_received NUMERIC(12, 2) NOT NULL DEFAULT 0,
    line_count INT NOT NULL DEFAULT 0,
    snapshot_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Investment cash-basis position -------------------------------------------
-- Transfers into an investment account are recorded on that account as
-- positive amounts (deposits) and transfers out as negative amounts.
CREATE OR REPLACE VIEW investment_position AS
SELECT
    a.id AS account_id,
    COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 0)::NUMERIC(12, 2) AS total_deposits,
    COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0)::NUMERIC(12, 2) AS total_withdrawals,
    COALESCE(SUM(t.amount), 0)::NUMERIC(12, 2) AS net_invested_capital,
    GREATEST(
        COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 0),
        0
    )::NUMERIC(12, 2) AS realized_gain
FROM accounts a
LEFT JOIN transactions t
    ON t.account_id = a.id AND t.is_internal_transfer = TRUE
WHERE a.account_type = 'investment_cash'
GROUP BY a.id;
