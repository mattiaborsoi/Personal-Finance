import type {
  AccountOut,
  AiSettings,
  AuditReportOut,
  CategoriesOut,
  HouseholdOut,
  MetricsOut,
  PeriodOut,
  Rule,
  RulesOut,
  SettlementOut,
  StatementOut,
  SystemInfo,
  TransactionOut,
  TransactionPart,
  UploadResult,
} from '../api';

/** Realistic UUIDs: ids on the wire are never numbers. */
export const ID_OCADO = '3f9a2c1e-8b47-4d6a-9e21-0c5d7a1b2e33';
export const ID_UBER = '7c4d1a92-5e6f-4b3a-8d10-2f9e6c1a4b55';
export const ID_PART_A = 'a1b2c3d4-0001-4e5f-8a9b-0c1d2e3f4a01';
export const ID_PART_B = 'a1b2c3d4-0002-4e5f-8a9b-0c1d2e3f4a02';
export const ID_CLAIM = '5d2c9a10-7e3b-4f8a-b1c4-9a0e6d2f7c11';

export function transaction(overrides: Partial<TransactionOut> = {}): TransactionOut {
  return {
    id: ID_OCADO,
    period_key: '2026-03',
    account_id: 'acc_cc_amex',
    transaction_date: '2026-03-04',
    post_date: '2026-03-05',
    raw_description: 'OCADO RETAIL LTD LONDON',
    cleaned_merchant: 'Ocado',
    amount: '-45.90',
    currency: 'GBP',
    original_currency: null,
    foreign_amount: null,
    category: 'Uncategorized',
    subcategory: null,
    claim_type: 'shared_proportional',
    is_claimable: true,
    allocated_primary_amount: '-27.48',
    allocated_secondary_amount: '-18.42',
    review_status: 'pending_review',
    is_internal_transfer: false,
    linked_transfer_id: null,
    classification_source: 'llm',
    classification_confidence: 0.62,
    source_file: 'statement.pdf',
    created_at: '2026-03-06T10:00:00Z',
    is_split: false,
    split_parent_id: null,
    parts: [],
    ...overrides,
  };
}

/** An account as GET /api/accounts returns it (the primary user's HSBC current account by default). */
export function account(overrides: Partial<AccountOut> = {}): AccountOut {
  return {
    id: 'acc_checking_hsbc',
    institution: 'HSBC',
    label: 'HSBC Premier',
    account_type: 'checking',
    owner_user_id: 'user_primary',
    identifier_last4: '4471',
    default_claim_type: 'personal',
    billed_to: null,
    is_active: true,
    transaction_count: 0,
    created_at: '2026-01-05T09:00:00Z',
    ...overrides,
  };
}

/** GET /api/periods: an open March 2026 with two lines, neither pending. */
export function period(overrides: Partial<PeriodOut> = {}): PeriodOut {
  return {
    period_key: '2026-03',
    start_date: '2026-03-01',
    end_date: '2026-03-31',
    is_closed: false,
    closed_at: null,
    transaction_count: 2,
    pending_review_count: 0,
    ...overrides,
  };
}

/** GET /api/settlement/2026-03 with Sam owing Alex £45.90 across one claim line. */
export function settlement(overrides: Partial<SettlementOut> = {}): SettlementOut {
  return {
    period_key: '2026-03',
    primary_user_id: 'user_primary',
    secondary_user_id: 'user_secondary',
    primary_ratio: '0.555556',
    secondary_ratio: '0.444444',
    secondary_share_of_primary_paid_shared: '120.00',
    primary_share_of_secondary_paid_shared: '60.00',
    secondary_personal_on_primary_paid: '10.00',
    primary_personal_on_secondary_paid: '24.10',
    net_owed_by_secondary: '45.90',
    settlement_payments_received: '0.00',
    pending_review_count: 0,
    unsettled_claim_count: 2,
    settlement_due_date: '2026-04-01',
    snapshot: null,
    lines: [
      {
        source: 'claim',
        id: ID_CLAIM,
        date: '2026-03-04',
        merchant: 'Ocado',
        amount: '-60.00',
        claim_type: 'shared_proportional',
        paid_by: 'user_secondary',
        primary_share: '33.33',
        secondary_share: '26.67',
        effect_on_secondary_owes: '-33.33',
      },
    ],
    ...overrides,
  };
}

/**
 * GET /api/metrics/2026-03. The macro categories are gross debits plus the
 * "Partner claims" pseudo-row, so they sum to `household_burn`; `refunds` is
 * what came back in the period and is not deducted from the headline.
 */
export function metrics(overrides: Partial<MetricsOut> = {}): MetricsOut {
  return {
    period_key: '2026-03',
    macro: {
      household_burn: '1200.00',
      primary_accounts_burn: '900.00',
      partner_claims_burn: '300.00',
      by_category: [
        { category: 'Groceries', amount: '650.00' },
        { category: 'Dining', amount: '250.00' },
        { category: 'Partner claims', amount: '300.00' },
      ],
      refunds: '0.00',
    },
    micro: {
      true_net_expense: '800.00',
      from_transactions: '650.00',
      from_partner_claims: '150.00',
      by_category: [
        { category: 'Groceries', amount: '650.00' },
        { category: 'Partner claims', amount: '150.00' },
      ],
    },
    liquidity: {
      credits: '517.27',
      debits: '617.27',
      net_cash_flow: '-100.00',
      by_account: [{ account_id: 'acc_checking_hsbc', credits: '517.27', debits: '617.27', net: '-100.00' }],
    },
    ...overrides,
  };
}

/** POST /api/statements/upload: a one-month Amex statement. */
export function uploadResult(overrides: Partial<UploadResult> = {}): UploadResult {
  return {
    upload_id: 'b7e1d2c3-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
    account_id: 'acc_cc_amex',
    period_key: '2026-07',
    period_from: '2026-07',
    period_to: '2026-07',
    parser: 'amex_pdf',
    inserted: 12,
    skipped_duplicates: 0,
    pending_review: 3,
    auto_approved: 9,
    transfers_matched: 0,
    warnings: [],
    ...overrides,
  };
}

/** GET /api/statements: one previous upload. */
export function statement(overrides: Partial<StatementOut> = {}): StatementOut {
  return {
    id: 'b7e1d2c3-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
    account_id: 'acc_cc_amex',
    period_key: '2026-07',
    period_from: '2026-07',
    period_to: '2026-07',
    filename: 'amex-july.pdf',
    sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    parser: 'amex_pdf',
    transaction_count: 12,
    created_at: '2026-08-02T09:15:00Z',
    deletable: true,
    ...overrides,
  };
}

/** GET /api/audit/2026-03 once a report exists. */
export function auditReport(overrides: Partial<AuditReportOut> = {}): AuditReportOut {
  return {
    period_key: '2026-03',
    summary_sentence: 'March 2026 spend was £1,200.00, 4% above the three-month baseline.',
    anomalies: [],
    category_comparison: [{ category: 'Groceries', current: '650.00', baseline_average: '600.00', change_pct: 8.3 }],
    created_at: '2026-04-01T08:00:00Z',
    ...overrides,
  };
}

export const COMMIT_RUNNING = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
export const COMMIT_LATEST = 'f9e8d7c6b5a40312f1e0d9c8b7a6958473625140';

/** GET /api/system as it reads when the running commit is the latest and the updater is idle. */
export function systemInfo(overrides: Partial<SystemInfo> = {}): SystemInfo {
  return {
    app: { name: 'Settl', version: '0.1.0' },
    repository: 'example/personal-finance',
    branch: 'main',
    running: { commit: COMMIT_RUNNING, short: 'a1b2c3d' },
    latest: { commit: COMMIT_RUNNING, short: 'a1b2c3d', date: '2026-09-20T10:15:00Z', message: 'Tidy the dashboard' },
    changes: [],
    changes_truncated: false,
    update_available: false,
    update_check_enabled: true,
    updater: { available: true, state: 'idle', started_at: null, finished_at: null, log: null, error: null },
    ...overrides,
  };
}

/**
 * GET /api/ai with AI on, a reachable proxy that offers two chat models, one
 * embedding model and one it says nothing about, and eight learnt merchants.
 */
export function aiSettings(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    enabled: true,
    embedding_provider: 'litellm',
    models: { chat: 'default-chat', extraction: 'default-chat', audit: 'default-chat', embedding: 'default-embedding' },
    thresholds: { similarity_threshold: 0.82, top_k: 3, deviation_threshold: 0.15, lookback_periods: 3 },
    available_models: [
      { name: 'default-chat', mode: 'chat', provider: 'Anthropic', model: 'claude-opus-5' },
      { name: 'cheap-chat', mode: 'chat', provider: 'Anthropic', model: 'claude-haiku-4-5' },
      { name: 'default-embedding', mode: 'embedding', provider: 'OpenAI', model: 'text-embedding-3-small' },
      { name: 'local-anything', mode: null, provider: null, model: null },
    ],
    proxy: { mode: 'bundled', url: 'http://litellm:4000', bundled_url: 'http://litellm:4000', env_url: null, reachable: true, has_key: true },
    memory_rows: 8,
    stored: true,
    ...overrides,
  };
}

/** GET /api/settings/household: Alex on £100,000 and Sam on £80,000, split in proportion (55.6 % / 44.4 %). */
export function household(overrides: Partial<HouseholdOut> = {}): HouseholdOut {
  return {
    users: {
      primary: { id: 'user_primary', display_name: 'Alex', base_salary_pa: '100000.00', additional_income_pa: '0.00' },
      secondary: { id: 'user_secondary', display_name: 'Sam', base_salary_pa: '80000.00', additional_income_pa: '0.00' },
    },
    split_strategy: 'salary_proportional',
    rounding_decimals: 2,
    settlement_day_of_month: 1,
    base_currency: 'GBP',
    currency_symbol: '£',
    primary_ratio: 0.555556,
    secondary_ratio: 0.444444,
    stored: true,
    ...overrides,
  };
}

/**
 * GET /api/settings/categories: two Bills, two bare names and Uncategorized.
 * Water is in use everywhere, Energy only by a rule, Dining and Taxi not at all.
 */
export function categories(overrides: Partial<CategoriesOut> = {}): CategoriesOut {
  return {
    categories: [
      { name: 'Bills:Water', in_use: { transactions: 12, memory: 3, rules: 1 } },
      { name: 'Bills:Energy', in_use: { transactions: 0, memory: 0, rules: 1 } },
      { name: 'Groceries', in_use: { transactions: 40, memory: 6, rules: 0 } },
      { name: 'Dining', in_use: { transactions: 0, memory: 0, rules: 0 } },
      { name: 'Transport:Taxi', in_use: { transactions: 0, memory: 0, rules: 0 } },
      { name: 'Uncategorized', in_use: { transactions: 2, memory: 0, rules: 0 } },
    ],
    stored: true,
    ...overrides,
  };
}

/** A deterministic rule filing the water bill as a shared cost. */
export function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    pattern: '(?i)AQUANORTH\\s*WATER',
    category: 'Bills:Water',
    claim_type: 'shared_proportional',
    merchant: null,
    subcategory: null,
    is_internal_transfer: false,
    transfer_to_account: null,
    ...overrides,
  };
}

/** GET /api/settings/rules: the water rule, a transfer to the investment account, and two card-payment patterns. */
export function rules(overrides: Partial<RulesOut> = {}): RulesOut {
  return {
    rules: [
      rule(),
      // A category the fixture config does not list, as after a config edit; the select keeps it.
      rule({
        pattern: '(?i)ROBINHOOD',
        category: 'Transfers:Investment',
        claim_type: 'personal',
        merchant: 'Robinhood',
        is_internal_transfer: true,
        transfer_to_account: 'acc_invest_robinhood',
      }),
    ],
    payment_patterns: ['(?i)PAYMENT\\s+RECEIVED\\s*-?\\s*THANK\\s*YOU', '(?i)AMEX\\s*(DD|PAYMENT)'],
    match_window_days: 7,
    amount_tolerance: '0.01',
    stored: true,
    ...overrides,
  };
}

/** One part of a split transaction, signed like its parent (spend is negative). */
export function part(overrides: Partial<TransactionPart> = {}): TransactionPart {
  return {
    id: ID_PART_A,
    split_index: 0,
    amount: '-30.00',
    category: 'Groceries',
    subcategory: null,
    claim_type: 'shared_proportional',
    is_claimable: true,
    allocated_primary_amount: '-17.96',
    allocated_secondary_amount: '-12.04',
    ...overrides,
  };
}
