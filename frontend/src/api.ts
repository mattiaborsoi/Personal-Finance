/**
 * Single typed fetch wrapper for the REST contract in docs/API.md.
 *
 * Money is always a decimal string ("-45.90"); dates are YYYY-MM-DD; periods
 * are YYYY-MM. Sign convention: negative = money out, positive = money in.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Decimal string, e.g. "-45.90". Parse with Number() for display only. */
export type Money = string;
export type Role = 'primary' | 'secondary';
export type ClaimType =
  | 'personal'
  | 'shared_proportional'
  | 'shared_equal'
  | 'secondary_personal'
  | 'primary_personal';
export type ReviewStatus = 'pending_review' | 'auto_approved' | 'manual_approved';
export type ClassificationSource = 'rule' | 'memory' | 'llm' | 'manual' | 'transfer' | 'none';
export type MatchStatus = 'unmatched' | 'matched' | 'ignored' | string;

/**
 * The backend's literal "no category" value. It is always present in
 * `config.categories`; there is no null/empty category on the wire.
 */
export const UNCATEGORIZED = 'Uncategorized';
/** Money moving between the household's own accounts; choosing it ticks the transfer flag. */
export const INTERNAL_TRANSFER_CATEGORY = 'Transfers:Internal';

export interface Session {
  token: string;
  role: Role;
  user_id: string;
  display_name: string;
}

export interface LoginResponse {
  token: string;
  role: Role;
  user_id: string;
  display_name: string;
}

export interface UserRef {
  id: string;
  display_name: string;
}

export interface SplitConfig {
  strategy: string;
  primary_ratio: string | number;
  secondary_ratio: string | number;
  rounding_decimals: number;
  settlement_day_of_month: number;
}

export type AccountType = 'checking' | 'savings' | 'credit' | 'credit_supplementary' | 'investment_cash';

export interface AccountConfig {
  id: string;
  institution: string;
  /** Optional friendlier display name, e.g. "HSBC Premier". */
  label?: string | null;
  account_type: string;
  owner: string;
  identifier_last4: string;
  default_claim_type?: ClaimType | null;
  billed_to?: string | null;
  /** False once archived: kept for history, not offered for uploads. Absent means active. */
  is_active?: boolean;
}

export interface AppConfig {
  base_currency: string;
  currency_symbol: string;
  users: { primary: UserRef; secondary: UserRef };
  split: SplitConfig;
  accounts: AccountConfig[];
  categories: string[];
  claim_types: ClaimType[];
  /**
   * Emoji per category group ("Bills" for "Bills:Water"; a bare name is its own
   * group), only for groups that have one. Optional: an older server leaves it out.
   */
  category_emojis?: Record<string, string>;
  /** True while a model can answer: the Ask box shows only then. Optional: an older server leaves it out. */
  ai_enabled?: boolean;
}

export interface AccountOut {
  /** Stable identifier, e.g. "acc_checking_hsbc"; immutable and referenced by rules. */
  id: string;
  /** The bank as printed on statements, e.g. "HSBC"; used to map uploads. */
  institution: string;
  /** Friendlier display name, e.g. "HSBC Premier". */
  label: string | null;
  account_type: AccountType;
  /** Who spends on it (a user id from `config.users`). */
  owner_user_id: string;
  /** The digits printed on the statement (1–8 characters). */
  identifier_last4: string;
  /** Starting claim type for unclassified lines. */
  default_claim_type: ClaimType;
  /** Who pays the bill; null means the owner (supplementary cards default to the primary user). */
  billed_to: string | null;
  /** False once archived: kept for history, not offered for uploads. */
  is_active: boolean;
  /** How many ledger rows sit on it; a non-zero count blocks deletion. */
  transaction_count: number;
  created_at: string | null;
}

/** `id` is only sent when the user typed one; the server otherwise derives it from institution, type and last four. */
export interface AccountCreate {
  id?: string;
  institution: string;
  label?: string | null;
  account_type: AccountType;
  owner: string;
  identifier_last4: string;
  default_claim_type?: ClaimType;
  billed_to?: string | null;
}

/** Omitted fields are untouched; null clears `label` or `billed_to`. */
export interface AccountUpdate {
  institution?: string;
  label?: string | null;
  account_type?: AccountType;
  owner?: string;
  identifier_last4?: string;
  default_claim_type?: ClaimType;
  billed_to?: string | null;
  is_active?: boolean;
}

export interface PeriodOut {
  period_key: string;
  start_date: string;
  end_date: string;
  is_closed: boolean;
  closed_at: string | null;
  transaction_count: number;
  pending_review_count: number;
  /** Lines filed unlike their merchant usually is on that card; optional on an older server. */
  unusual_count?: number;
}

export interface UploadResult {
  upload_id: string | null;
  account_id: string;
  period_key: string;
  /** First and last month (YYYY-MM) the statement's lines fall in; null when unknown. */
  period_from: string | null;
  period_to: string | null;
  parser: string;
  inserted: number;
  skipped_duplicates: number;
  pending_review: number;
  auto_approved: number;
  transfers_matched: number;
  /** Of `auto_approved`: lines from merchants always filed one way, approved without review. */
  auto_approved_known?: number;
  warnings: string[];
}

export interface StatementOut {
  id: string;
  account_id: string;
  period_key: string;
  /** First and last month (YYYY-MM) the statement's lines fall in; null when unknown. */
  period_from: string | null;
  period_to: string | null;
  filename: string;
  sha256: string;
  parser: string;
  transaction_count: number;
  created_at: string;
  /**
   * False for an upload recorded before lines were linked to uploads whose filename
   * another such upload shares: its lines cannot be told apart, so DELETE answers 409.
   */
  deletable: boolean;
}

export interface TransactionOut {
  /** UUID. */
  id: string;
  period_key: string;
  account_id: string;
  transaction_date: string;
  post_date: string | null;
  raw_description: string;
  cleaned_merchant: string | null;
  amount: Money;
  currency: string;
  original_currency: string | null;
  foreign_amount: Money | null;
  category: string | null;
  subcategory: string | null;
  claim_type: ClaimType | null;
  is_claimable: boolean;
  allocated_primary_amount: Money | null;
  allocated_secondary_amount: Money | null;
  review_status: ReviewStatus;
  is_internal_transfer: boolean;
  linked_transfer_id: string | null;
  classification_source: ClassificationSource;
  classification_confidence: number | string | null;
  source_file: string | null;
  /** The user's own note on what the payment was; `raw_description` is never edited. */
  note: string | null;
  created_at: string;
  /** True once the transaction has been split into parts (see `parts`). */
  is_split: boolean;
  /** Set on a part. Parts never appear in the list; they are embedded in their parent. */
  split_parent_id: string | null;
  /** Populated only when `is_split`; otherwise empty. */
  parts: TransactionPart[];
  /**
   * Set when the line is filed unlike this merchant usually is on the same card: at least
   * four approved lines there, and this (category, claim type) in at most a fifth of them.
   */
  unusual?: UnusualOut | null;
}

export interface UnusualOut {
  usual_category: string;
  usual_claim_type: ClaimType;
  /** How often the line's own filing appears in that history. */
  times: number;
  /** The history's size. */
  total: number;
}

/**
 * One part of a split transaction. Its amount is signed like the parent
 * (negative for spend) and `PATCH /transactions/{id}` works on it.
 */
export interface TransactionPart {
  /** UUID. */
  id: string;
  /** 0-based order within the parent. */
  split_index: number;
  amount: Money;
  category: string;
  subcategory: string | null;
  claim_type: ClaimType;
  is_claimable: boolean;
  allocated_primary_amount: Money;
  allocated_secondary_amount: Money;
  /** Each part may carry its own note. */
  note: string | null;
}

/** One part as sent to `PUT /transactions/{id}/split`; the amount is signed like the parent. */
export interface SplitPartInput {
  amount: Money;
  category: string;
  subcategory?: string | null;
  claim_type: ClaimType;
}

export interface SplitBody {
  parts: SplitPartInput[];
}

export interface TransactionListResponse {
  items: TransactionOut[];
  total: number;
}

export interface TransactionQuery {
  period?: string;
  status?: ReviewStatus | '';
  account_id?: string;
  category?: string;
  q?: string;
  include_transfers?: boolean;
  /** Only lines filed unlike their merchant usually is (`unusual=true`). */
  unusual?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Corrections accepted by PATCH and approve. The backend ignores nulls and
 * rejects an empty category with 422, so a "no category" is sent as the
 * literal `UNCATEGORIZED` and there is never a null classification.
 */
export interface TransactionPatch {
  category?: string;
  subcategory?: string | null;
  claim_type?: ClaimType;
  cleaned_merchant?: string;
  is_internal_transfer?: boolean;
  /** Trimmed by the server; `""` or `null` clears it; at most `NOTE_MAX_LENGTH` characters. Never changes the status. */
  note?: string | null;
}

/** The longest note the server accepts (longer is a 422). */
export const NOTE_MAX_LENGTH = 500;

export interface ApproveBody extends TransactionPatch {
  remember: boolean;
}

export interface ApproveBatchBody {
  ids: string[];
  remember: boolean;
}

export interface ApproveBatchResponse {
  approved: number;
  items: TransactionOut[];
}

/** Why a line stays in the queue when known merchants are approved. */
export type AutoApproveReason =
  | 'new_merchant'
  | 'new_on_this_card'
  | 'few_approvals'
  | 'mixed_history'
  | 'unusual_amount'
  | 'other_sign'
  | 'transfer'
  | 'split'
  | 'closed_period';

export interface AutoApproveBody {
  /** One month (YYYY-MM), or null for every month with lines waiting. */
  period: string | null;
  dry_run: boolean;
}

export interface AutoApproveItem {
  id: string;
  cleaned_merchant: string;
  amount: Money;
  category: string;
  claim_type: ClaimType;
}

export interface AutoApproveResponse {
  approved: number;
  considered: number;
  skipped: Partial<Record<AutoApproveReason, number>>;
  /** The lines approved or, on a dry run, that would be. */
  items: AutoApproveItem[];
}

export interface TransferBufferOut {
  id: string;
  transaction_id: string | null;
  account_id: string;
  amount: Money;
  transaction_date: string;
  match_status: MatchStatus;
  resolved_at: string | null;
  description: string | null;
}

export interface ClaimCreate {
  claim_date: string;
  amount: Money;
  merchant: string;
  description?: string;
  claim_type: ClaimType;
  paid_by?: string;
}

export interface ClaimOut {
  id: string;
  period_key: string;
  claim_date: string;
  paid_by: string;
  merchant: string;
  description: string | null;
  amount: Money;
  claim_type: ClaimType;
  primary_owes: Money;
  secondary_owes: Money;
  is_settled: boolean;
  created_at: string;
}

export interface SettlementLine {
  source: string;
  id: string;
  date: string;
  merchant: string;
  amount: Money;
  claim_type: ClaimType | null;
  paid_by: string;
  primary_share: Money;
  secondary_share: Money;
  effect_on_secondary_owes: Money;
}

export interface SettlementOut {
  period_key: string;
  primary_user_id: string;
  secondary_user_id: string;
  primary_ratio: string | number;
  secondary_ratio: string | number;
  secondary_share_of_primary_paid_shared: Money;
  primary_share_of_secondary_paid_shared: Money;
  secondary_personal_on_primary_paid: Money;
  primary_personal_on_secondary_paid: Money;
  net_owed_by_secondary: Money;
  settlement_payments_received: Money;
  pending_review_count: number;
  unsettled_claim_count: number;
  /** YYYY-MM-DD: the configured settlement day in the month after the period. */
  settlement_due_date: string | null;
  /** The figures recorded when the period was closed; null while it is open. */
  snapshot: SettlementSnapshot | null;
  lines: SettlementLine[];
  /** The running balance: what was carried in, the month, payments, adjustments and what is outstanding. */
  balance: SettlementBalance;
  /** Payments, adjustments and the agreed balance recorded by hand against this month. */
  entries: SettlementEntry[];
  /** Approved Transfers:Settlement transactions in this month; `description` is the cleaned merchant name. */
  ledger_payments: SettlementLedgerPayment[];
}

/**
 * The running settlement balance for a month, all in "secondary owes primary"
 * terms (positive = the secondary owes the primary, negative = the other way).
 * `balance_out` = `carried_in` + `net` - (`payments_ledger` + `payments_manual`) + `adjustments`,
 * unless the month has a checkpoint, when it is the checkpoint's amount.
 */
export interface SettlementBalance {
  carried_in: Money;
  net: Money;
  payments_ledger: Money;
  payments_manual: Money;
  adjustments: Money;
  balance_out: Money;
  /** The month the balance was carried in from; the month itself when nothing came before it. */
  from_period: string | null;
  checkpoint: SettlementCheckpoint | null;
  /** A later month has a checkpoint: this month is history and is not carried forward. */
  before_checkpoint: boolean;
  /** That later month (the first one with a set balance), when `before_checkpoint`. */
  later_checkpoint_period?: string | null;
  /** The set balance in an earlier month that `carried_in` starts from, if any. */
  anchored_on?: { period_key: string; entry_date: string; amount: Money } | null;
}

export interface SettlementCheckpoint {
  id: string;
  /** The agreed balance at the end of the month (secondary-owes terms). */
  amount: Money;
  entry_date: string;
  note: string | null;
  /** The month's net when the balance was set. */
  net_at_checkpoint: Money;
  /** The month's net now less `net_at_checkpoint`: how far it has moved since (secondary-owes terms). */
  drift: Money;
  drifted: boolean;
}

export type SettlementEntryKind = 'payment' | 'adjustment' | 'checkpoint';

export interface SettlementEntry {
  id: string;
  period_key: string;
  kind: SettlementEntryKind;
  entry_date: string;
  /** Payment: positive, paid by `paid_by`. Adjustment: signed change to what the secondary owes. Checkpoint: the agreed balance. */
  amount: Money;
  paid_by: string | null;
  note: string | null;
  /** Checkpoints only: the month's net when the balance was set. */
  net_at_checkpoint: Money | null;
  created_by: string | null;
  created_at: string;
}

export interface SettlementEntryCreate {
  kind: SettlementEntryKind;
  entry_date: string;
  amount: Money;
  /** Payments only: a 422 on an adjustment or checkpoint. */
  paid_by?: string;
  note?: string;
}

export interface SettlementLedgerPayment {
  transaction_id: string;
  date: string;
  amount: Money;
  account_id: string;
  description: string;
  /** Positive when the line takes money off what the secondary owes (the secondary paid), negative the other way. */
  effect: Money;
}

export interface SettlementSnapshot {
  period_key: string;
  net_owed_by_secondary: Money;
  secondary_share_of_primary_paid_shared: Money;
  primary_share_of_secondary_paid_shared: Money;
  secondary_personal_on_primary_paid: Money;
  primary_personal_on_secondary_paid: Money;
  settlement_payments_received: Money;
  line_count: number;
  /** The running balance at close; missing or null on snapshots taken before it existed. */
  carried_in?: Money | null;
  payments?: Money | null;
  adjustments?: Money | null;
  balance_out?: Money | null;
  snapshot_at: string | null;
}

export interface CategoryAmount {
  category: string;
  amount: Money;
}

export interface AccountFlow {
  account_id: string;
  credits: Money;
  debits: Money;
  net: Money;
}

/** The pseudo-category both `by_category` lists use for partner claims. */
export const PARTNER_CLAIMS_CATEGORY = 'Partner claims';

/** One household member's side of the month (Household view). */
export interface PersonSpend {
  user_id: string;
  /** Gross debits on the accounts billed to them, plus the claims they paid. */
  paid: Money;
  /** Their net share after the split (refunds netted), plus their side of the claims. */
  bears: Money;
}

export interface MetricsOut {
  period_key: string;
  macro: {
    household_burn: Money;
    primary_accounts_burn: Money;
    partner_claims_burn: Money;
    /** How many partner claims the month has; absent on an older server. */
    partner_claims_count?: number;
    /** Gross debits per category plus a `PARTNER_CLAIMS_CATEGORY` row, summing to `household_burn`. */
    by_category: CategoryAmount[];
    /** Refunds received in the period (positive); the headline deliberately does not deduct them. */
    refunds: Money;
    /** Primary then secondary; absent on an older server. */
    by_person?: PersonSpend[];
  };
  micro: {
    true_net_expense: Money;
    from_transactions: Money;
    from_partner_claims: Money;
    by_category: CategoryAmount[];
  };
  liquidity: {
    credits: Money;
    debits: Money;
    net_cash_flow: Money;
    by_account: AccountFlow[];
  };
}

export interface TrendPoint {
  period_key: string;
  household_burn: Money;
  true_net_expense: Money;
  net_cash_flow: Money;
}

export interface InvestmentAccountMetrics {
  account_id: string;
  total_deposits: Money;
  total_withdrawals: Money;
  net_invested_capital: Money;
  realized_gain: Money;
}

export interface InvestmentMetrics {
  accounts: InvestmentAccountMetrics[];
  total_deposits: Money;
  total_withdrawals: Money;
  net_invested_capital: Money;
  realized_gain: Money;
}

// Subscriptions: recurring payments found from the ledger, no AI (GET /api/subscriptions).
export type SubscriptionCadence = 'monthly' | 'yearly';
export type SubscriptionStatus = 'active' | 'new' | 'stopped';

/** The newest charge differs from the one before it; `month` is the newest charge's YYYY-MM. */
export interface SubscriptionChange {
  from: Money;
  to: Money;
  month: string;
}

export interface SubscriptionOut {
  merchant: string;
  category: string;
  cadence: SubscriptionCadence;
  /** The latest charge, a positive magnitude. */
  amount: Money;
  /** `amount` for a monthly subscription, a twelfth of it for a yearly one. */
  monthly_cost: Money;
  charges: number;
  first_date: string;
  last_date: string;
  next_expected: string;
  /** `new`: first charged within the last 90 days; `stopped`: the next charge is well overdue. */
  status: SubscriptionStatus;
  change: SubscriptionChange | null;
}

export interface SubscriptionsOut {
  /** Running ones first, by monthly cost; stopped ones last. */
  items: SubscriptionOut[];
  /** The monthly cost of every subscription that has not stopped. */
  total_monthly: Money;
  /** The newest transaction date in the ledger; null when the ledger is empty. */
  as_of: string | null;
}

export interface AuditAnomaly {
  transaction_id: string | null;
  merchant: string;
  issue: string;
  current_amount: Money | null;
  /** Median of the merchant's prior per-period totals. */
  baseline_amount: Money | null;
  /** Population standard deviation of those totals; null when unavailable. */
  baseline_stddev: Money | null;
  /** Fraction (0.35 = 35 % above baseline); null when no baseline exists. */
  deviation: number | string | null;
}

export interface AuditCategoryComparison {
  category: string;
  current: Money;
  baseline_average: Money;
  change_pct: number | string | null;
}

export interface AuditReportOut {
  period_key: string;
  summary_sentence: string;
  anomalies: AuditAnomaly[];
  category_comparison: AuditCategoryComparison[];
  created_at: string;
}

export interface MemoryOut {
  id: string;
  raw_pattern: string;
  normalized_merchant: string;
  category: string;
  /** The split last approved for this merchant on any card; not used to pre-fill (decided per card). */
  default_claim_type: ClaimType | null;
  review_count: number;
  last_updated: string;
  /** Lines of this merchant (any review status; no split parents or transfers). */
  transaction_count?: number;
  /** Net spend on those lines: money out is positive, refunds reduce it. */
  total_spent?: Money;
}

export type UpdaterState = 'idle' | 'running' | 'succeeded' | 'failed';

/** One commit on GitHub; `message` is its first line. */
export interface CommitInfo {
  commit: string;
  short: string;
  date: string | null;
  message: string;
}

export interface SystemInfo {
  /** `version` is the running commit's date as YYYY.MM.DD; null when it is not known. */
  app: { name: string; version: string | null };
  /** "owner/repo" on GitHub. */
  repository: string;
  branch: string;
  /** The commit the server was built from; null when unknown. */
  running: { commit: string | null; short: string | null; date?: string | null };
  /** The newest commit on GitHub; null until checked, or when checks are disabled. */
  latest: CommitInfo | null;
  /**
   * The commits newer than the running one, newest first: the changelog of every update skipped.
   * When the running commit is unknown, the newest commits on the branch; empty when up to date.
   */
  changes: CommitInfo[];
  /** True when the running commit is older than everything fetched, so `changes` is only the newest few. */
  changes_truncated: boolean;
  /** null when either side is unknown. */
  update_available: boolean | null;
  /** false: the server never contacts GitHub. */
  update_check_enabled: boolean;
  updater: {
    /** false: the updater container is not reachable, so self-update is off. */
    available: boolean;
    state: UpdaterState;
    started_at: string | null;
    finished_at: string | null;
    /** The last few thousand characters of the updater's output. */
    log: string | null;
    error: string | null;
  };
  /** Database backups (pg_dump files on the server). */
  backups: BackupsSummary;
}

/** How the server's 409 detail starts when the pre-update backup failed (and the update was not started). */
export const BACKUP_BEFORE_UPDATE_FAILED = 'The backup before updating failed';

/** Why a backup was taken: by the nightly schedule, from "Back up now", or just before an update. */
export type BackupKind = 'nightly' | 'manual' | 'pre-update';

export interface BackupItem {
  /** settl-YYYYMMDD-HHMMSS-<kind>.dump */
  name: string;
  kind: BackupKind;
  created_at: string;
  bytes: number;
}

export interface BackupsSummary {
  /** false: scheduled (nightly) backups are turned off on the server; manual ones still work. */
  enabled: boolean;
  count: number;
  last: BackupItem | null;
  /** true when there is no backup, or the newest is more than 36 hours old. */
  stale: boolean;
  /** The newest few, newest first. */
  recent: BackupItem[];
}

export interface UpdateStarted {
  state: 'running';
  started_at: string;
}

/**
 * `transactions` empties the ledger (transactions, uploads, audit reports, settlement
 * snapshots, periods without claims) and keeps claims, merchant memory, accounts and
 * settings; `everything` empties all of it and sets the accounts up again from config.yaml.
 */
export type ResetScope = 'transactions' | 'everything';

/** The phrase `confirm` must carry, exactly, for each scope. */
export const RESET_PHRASES: Record<ResetScope, string> = {
  transactions: 'DELETE TRANSACTIONS',
  everything: 'DELETE EVERYTHING',
};

export interface ResetBody {
  scope: ResetScope;
  confirm: string;
}

/** Rows removed, per kind. */
export interface ResetCounts {
  transactions: number;
  uploads: number;
  claims: number;
  periods: number;
  memory: number;
  accounts: number;
  settings: number;
}

export interface ResetOut {
  scope: ResetScope;
  deleted: ResetCounts;
}

/** "hash" turns merchants into vectors offline, without an AI call. */
export type EmbeddingProvider = 'litellm' | 'hash';
export type AiJob = 'chat' | 'extraction' | 'audit' | 'embedding';

/** A model the LiteLLM proxy offers; `mode` is null when the proxy does not say what it is for. */
export interface AiModelOption {
  name: string;
  mode: 'chat' | 'embedding' | null;
  /** Human name of the provider behind it, e.g. "Anthropic"; null when unknown. */
  provider: string | null;
  /** The provider's own model id; null when unknown. */
  model: string | null;
}

/** Which proxy model does each job (names from `available_models`). */
export interface AiModels {
  chat: string;
  extraction: string;
  audit: string;
  embedding: string;
}

export interface AiThresholds {
  /** 0.5–0.99: below this a remembered merchant is not trusted and the AI is asked. */
  similarity_threshold: number;
  /** 1–10 remembered merchants shown to the AI as examples. */
  top_k: number;
  /** 0.05–1.0 as a fraction: a regular bill is flagged when it moves more than this. */
  deviation_threshold: number;
  /** 1–12 months of history the summary compares against. */
  lookback_periods: number;
}

/** "bundled": the LiteLLM container that ships with the app; "external": one the user already runs, saved in the app. */
export type ProxyMode = 'bundled' | 'external';

export interface AiProxy {
  mode: ProxyMode;
  /** The URL in use: the bundled container's, or the external proxy's (saved, else from `.env`). */
  url: string;
  /** Where the bundled container answers (`BUNDLED_LITELLM_URL`). */
  bundled_url: string;
  /** What `LITELLM_URL` in `.env` offers for the external option; null when unset. */
  env_url: string | null;
  reachable: boolean;
  /** Whether an API key is stored for the proxy; the key itself is never returned. */
  has_key: boolean;
}

export interface AiSettings {
  /** Off: only rules and the merchants already learnt are used. */
  enabled: boolean;
  embedding_provider: EmbeddingProvider;
  models: AiModels;
  thresholds: AiThresholds;
  available_models: AiModelOption[];
  proxy: AiProxy;
  /** Learnt merchants in the vector memory. */
  memory_rows: number;
  /** False until something is saved: the values shown are the config/.env defaults. */
  stored: boolean;
  /**
   * Extra words masked before any text goes to a model, on top of the household's
   * names, long numbers, postcodes, e-mails and phone numbers that are always masked.
   */
  redact_words: string[];
  /** How the AI is doing: acceptance over the last 90 days and this month's usage. */
  stats: AiStats;
  /** PDF layouts learnt from the model, replayed without AI; delete one to learn it afresh. */
  layouts: PdfLayoutOut[];
}

/** Requests, failures and tokens the proxy reported for one job this month; never prompts. */
export interface AiJobUsage {
  job: 'chat' | 'extraction' | 'audit' | 'ask' | string;
  requests: number;
  failures: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface AiStats {
  window_days: number;
  /** Lines a model classified in the window. */
  classified: number;
  /** Of those, approved so far. */
  approved: number;
  /** Of those approved, with the suggested category and claim type kept unchanged. */
  accepted: number;
  /** accepted / approved, or null before anything was approved. */
  acceptance_rate: number | null;
  /** YYYY-MM the usage rows are for. */
  month: string;
  usage: AiJobUsage[];
}

export interface PdfLayoutOut {
  id: string;
  institution: string | null;
  created_at: string | null;
  last_used_at: string | null;
  times_used: number;
}

/** A blank or omitted `api_key` keeps the stored key; `url` must start with http:// or https://. */
export interface AiProxyUpdate {
  mode?: ProxyMode;
  url?: string;
  api_key?: string;
}

/** Any subset; inside `models`, `thresholds` and `proxy` only the fields sent change. */
export interface AiUpdate {
  enabled?: boolean;
  embedding_provider?: EmbeddingProvider;
  models?: Partial<AiModels>;
  thresholds?: Partial<AiThresholds>;
  proxy?: AiProxyUpdate;
  /** The whole list; it replaces the saved one. Blank entries are dropped, the rest trimmed. */
  redact_words?: string[];
  /** Required (true) when the embedding model or provider changes while `memory_rows` > 0. */
  clear_memory?: boolean;
}

// ---------------------------------------------------------------------------
// Ask: a plain-English question turned into a local query (POST /api/ask)
// ---------------------------------------------------------------------------

export type AskMetric = 'sum' | 'count' | 'average' | 'list';
export type AskGroupBy = 'month' | 'category' | 'merchant' | 'account';

/** The query the model answered with, validated by the server; the only thing the model produced. */
export interface AskQuery {
  kind: 'spend' | 'settlement';
  metric: AskMetric;
  date_from: string | null;
  date_to: string | null;
  months: string[];
  categories: string[];
  merchant_text: string | null;
  accounts: string[];
  claim_types: string[];
  people: Array<'primary' | 'secondary'>;
  direction: 'out' | 'in' | 'any';
  status: 'approved' | 'pending' | 'all';
  group_by: AskGroupBy | null;
  settlement_period: string | null;
}

/** A grouped total (`label`, `amount`, `count`) or a listed line (`date`, `merchant`, `amount`, `category`, `account_id`). */
export type AskRow = Record<string, string | number | null>;

export interface AskOut {
  answer: string;
  /** "Showing: Travel, Jan 2026 to Sep 2026, money out, approved and pending" */
  interpreted: string;
  query: AskQuery;
  /** The closest Transactions view (or the dashboard month for a settlement question). */
  link: string | null;
  value: Money | null;
  count: number;
  rows: AskRow[];
}

// ---------------------------------------------------------------------------
// Rule suggestions (GET /api/settings/rules/suggestions), worked out from approvals without AI
// ---------------------------------------------------------------------------

export type RuleSuggestionKind = 'fixed_amount' | 'always_same' | 'override';

export interface RuleSuggestion {
  /** Stable identity, sent back to dismiss it. */
  key: string;
  kind: RuleSuggestionKind;
  /** One plain sentence: "Third Space, £40.00, filed as Health:Gym 3 times: make it a rule?" */
  text: string;
  merchant: string;
  category: string;
  claim_type: ClaimType;
  /** Approved lines behind it. */
  count: number;
  amount: Money | null;
  /** The rule to add, or (for `override`) the existing rule as it would be after the edit. */
  rule: Rule;
  /** For `override`: the position of the existing rule in the saved list. */
  rule_index: number | null;
  action: 'add' | 'edit' | 'remove';
  /** Up to three raw descriptions the pattern covers. */
  examples: string[];
}

export interface RuleSuggestionsOut {
  suggestions: RuleSuggestion[];
}

export interface AiJobTest {
  ok: boolean;
  /** Round-trip time; null when the call failed before it could be timed. */
  ms: number | null;
  model: string;
  error: string | null;
}

export interface AiEmbeddingTest extends AiJobTest {
  /** The vector length the model returned; must be 1536. */
  dimensions: number | null;
}

/** One entry per job; null for a job that is switched off. */
export interface AiTestResult {
  chat: AiJobTest | null;
  extraction: AiJobTest | null;
  audit: AiJobTest | null;
  embedding: AiEmbeddingTest | null;
}

// ---------------------------------------------------------------------------
// Settings: household, categories and rules (primary only)
// ---------------------------------------------------------------------------

export type SplitStrategy = 'salary_proportional' | 'equal_50_50';

/** One of the two people, with the incomes the proportional split is worked out from. */
export interface HouseholdUser {
  id: string;
  display_name: string;
  /** Per year, as a decimal string. */
  base_salary_pa: Money;
  additional_income_pa: Money;
}

export interface HouseholdOut {
  users: { primary: HouseholdUser; secondary: HouseholdUser };
  split_strategy: SplitStrategy;
  /** 0–6 decimal places settlement figures are rounded to. */
  rounding_decimals: number;
  /** 1–28: the day of the month after a period by which it is settled. */
  settlement_day_of_month: number;
  /** ISO 4217, e.g. "GBP". */
  base_currency: string;
  /** 1–3 characters, e.g. "£". */
  currency_symbol: string;
  /** Fractions that follow from the strategy and the incomes; they sum to 1. */
  primary_ratio: number;
  secondary_ratio: number;
  /** False until something is saved: the values shown are config.yaml's. */
  stored: boolean;
}

export interface HouseholdUserUpdate {
  display_name?: string;
  base_salary_pa?: Money;
  additional_income_pa?: Money;
}

/** Any subset; inside `users` only the people and fields sent change. */
export interface HouseholdUpdate {
  users?: { primary?: HouseholdUserUpdate; secondary?: HouseholdUserUpdate };
  split_strategy?: SplitStrategy;
  rounding_decimals?: number;
  settlement_day_of_month?: number;
  base_currency?: string;
  currency_symbol?: string;
}

/** Where a category is referenced; a category with any of these cannot be removed. */
export interface CategoryUsage {
  transactions: number;
  /** Remembered merchants. */
  memory: number;
  rules: number;
}

export interface CategoryOut {
  name: string;
  in_use: CategoryUsage;
}

/** The taxonomy in the order the category menus show it; `UNCATEGORIZED` is always present. */
export interface CategoriesOut {
  categories: CategoryOut[];
  /** The effective emoji per group; "" (or a missing key) means the group has none. */
  emojis?: Record<string, string>;
  /**
   * What each group would show with nothing saved, when the server says so; the
   * emoji fields use it as their placeholder. Optional: not every server sends it.
   */
  default_emojis?: Record<string, string>;
  stored: boolean;
}

/** PUT /api/settings/categories. In `emojis`, "" means "no emoji for this group", overriding a default. */
export interface CategoriesUpdate {
  categories: string[];
  emojis?: Record<string, string>;
}

/** How often a category has been used, for the category picker's shortcuts. */
export interface CategoryCount {
  category: string;
  count: number;
}

/** GET /api/categories/suggestions: the merchant's own history, then the household's most used. */
export interface CategorySuggestions {
  merchant: CategoryCount[];
  frequent: CategoryCount[];
}

/** A deterministic rule: the first whose `pattern` matches the raw description classifies the line without the AI. */
export interface Rule {
  /** A Python regular expression, e.g. "(?i)ACME\\s*WATER". */
  pattern: string;
  category: string;
  claim_type: ClaimType;
  /** The cleaned merchant name to store; null keeps what the parser found. */
  merchant: string | null;
  subcategory: string | null;
  /** Marks the line as an internal transfer and feeds the transfer buffer. */
  is_internal_transfer: boolean;
  /** The account that receives the money; a mirror transaction is written there. */
  transfer_to_account: string | null;
  /**
   * Smallest and largest line amount the rule applies to, ignoring the sign, both
   * inclusive, as decimal strings; null (or absent) leaves that side open. A rule
   * with either bound only matches a line whose amount is known and inside them.
   */
  amount_min?: Money | null;
  amount_max?: Money | null;
}

export interface RulesOut {
  rules: Rule[];
  /** Regular expressions that identify a card payment on a statement. */
  payment_patterns: string[];
  /** How many days apart the two sides of a card payment may be. */
  match_window_days: number;
  /** How much the two amounts may differ, as a decimal string. */
  amount_tolerance: Money;
  stored: boolean;
}

/** Any subset; a list sent replaces the whole list. */
export interface RulesUpdate {
  rules?: Rule[];
  payment_patterns?: string[];
  match_window_days?: number;
  amount_tolerance?: Money;
}

/** `rules` and `payment_patterns` test the unsaved lists when given; otherwise the saved ones. */
export interface RuleTestBody {
  description: string;
  /** The line's amount, either sign; without it a rule with an amount range is skipped. */
  amount?: Money;
  rules?: Rule[];
  payment_patterns?: string[];
}

export interface RuleTestResult {
  /** 0-based index into the rules tested; null when none matches. */
  rule_index: number | null;
  rule: Rule | null;
  /** True when a payment pattern matches, so the line would go to the transfer buffer. */
  is_payment: boolean;
}

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

export const SESSION_STORAGE_KEY = 'pf.session';

export function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (typeof parsed.token !== 'string' || !parsed.token) return null;
    if (parsed.role !== 'primary' && parsed.role !== 'secondary') return null;
    return {
      token: parsed.token,
      role: parsed.role,
      user_id: String(parsed.user_id ?? ''),
      display_name: String(parsed.display_name ?? ''),
    };
  } catch {
    return null;
  }
}

export function writeSession(session: Session | null): void {
  try {
    if (session) localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode etc.) - the app still works for the tab.
  }
}

let unauthorizedHandler: (() => void) | null = null;

/** Registered by the auth provider; called after a 401 clears the session. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, detail: unknown, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

/** Turns a FastAPI-style `detail` (string | object | array) into a sentence. */
export function describeDetail(detail: unknown): string {
  if (detail == null) return '';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'msg' in item) {
          const loc = Array.isArray((item as { loc?: unknown[] }).loc)
            ? (item as { loc: unknown[] }).loc.filter((l) => l !== 'body').join('.')
            : '';
          return loc ? `${loc}: ${String((item as { msg: unknown }).msg)}` : String((item as { msg: unknown }).msg);
        }
        return JSON.stringify(item);
      })
      .join('; ');
  }
  if (typeof detail === 'object') {
    const obj = detail as Record<string, unknown>;
    for (const key of ['message', 'msg', 'error', 'detail']) {
      if (typeof obj[key] === 'string') return obj[key] as string;
    }
    return JSON.stringify(detail);
  }
  return String(detail);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong. Try again, and reload the page if it keeps happening.';
}

export function isApiError(err: unknown, status?: number): err is ApiError {
  return err instanceof ApiError && (status === undefined || err.status === status);
}

export const PERIOD_CLOSED_MESSAGE = 'This period is closed. It needs reopening from the dashboard before it can change.';

/**
 * Like `errorMessage`, for edits to transactions and claims: the backend
 * answers 409 when the period is closed, which deserves a plain sentence
 * rather than the server's wording.
 */
export function editErrorMessage(err: unknown): string {
  if (isApiError(err, 409)) return PERIOD_CLOSED_MESSAGE;
  return errorMessage(err);
}

export const FILE_TOO_LARGE_MESSAGE = 'This file is over the 25\u00a0MB limit. Choose a smaller file and try again.';

/** Shown by the settings tabs whose document has `stored: false`. */
export const CONFIG_DEFAULTS_MESSAGE = 'Nothing saved yet: these are the defaults from config.yaml.';

// ---------------------------------------------------------------------------
// Core request
// ---------------------------------------------------------------------------

export const API_BASE = '/api';

type QueryValue = string | number | boolean | null | undefined;
type Query = Record<string, QueryValue>;

interface RequestOptions {
  body?: unknown;
  form?: FormData;
  query?: Query;
  /** For the login route: a 401 there is a wrong password, not an expired session. */
  allow401?: boolean;
}

function buildUrl(path: string, query?: Query): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const session = readSession();
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;

  let body: BodyInit | undefined;
  if (options.form) {
    body = options.form;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), { method, headers, body });
  } catch {
    throw new ApiError(0, null, 'Could not reach the server. Check your connection and try again.');
  }

  if (response.status === 401 && !options.allow401) {
    writeSession(null);
    unauthorizedHandler?.();
    throw new ApiError(401, null, 'Your session has expired. Please sign in again.');
  }

  if (response.status === 204) return undefined as T;

  // nginx answers an oversized upload itself, with an HTML page, before the
  // backend ever sees it; the backend's own 413 carries a JSON detail.
  if (response.status === 413) {
    throw new ApiError(413, null, FILE_TOO_LARGE_MESSAGE);
  }

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // A non-JSON body is a proxy or gateway page, never something to show verbatim.
      data = looksLikeMarkup(text) ? null : text;
    }
  }

  if (!response.ok) {
    const detail =
      data && typeof data === 'object' && 'detail' in (data as Record<string, unknown>)
        ? (data as { detail: unknown }).detail
        : data;
    const message =
      describeDetail(detail) ||
      (response.status >= 500
        ? `The server had a problem (${response.status}). Try again in a moment.`
        : `The request could not be completed (${response.status}). Reload the page and try again.`);
    throw new ApiError(response.status, detail, message);
  }

  return data as T;
}

/** A file download (GET) with the session header; errors are reported like `request`'s. */
async function requestBlob(path: string): Promise<Blob> {
  const headers: Record<string, string> = {};
  const session = readSession();
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  let response: Response;
  try {
    response = await fetch(buildUrl(path), { method: 'GET', headers });
  } catch {
    throw new ApiError(0, null, 'Could not reach the server. Check your connection and try again.');
  }
  if (response.status === 401) {
    writeSession(null);
    unauthorizedHandler?.();
    throw new ApiError(401, null, 'Your session has expired. Please sign in again.');
  }
  if (!response.ok) {
    let detail: unknown;
    try {
      detail = ((await response.json()) as { detail?: unknown }).detail ?? null;
    } catch {
      detail = null;
    }
    throw new ApiError(
      response.status,
      detail,
      describeDetail(detail) || `The download could not be completed (${response.status}). Try again.`,
    );
  }
  return response.blob();
}

function looksLikeMarkup(text: string): boolean {
  return /^\s*</.test(text);
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const api = {
  // Auth
  login: (password: string) =>
    request<LoginResponse>('POST', '/auth/login', { body: { password }, allow401: true }),

  // Reference
  getConfig: () => request<AppConfig>('GET', '/config'),

  // Accounts (every account, archived included)
  listAccounts: () => request<AccountOut[]>('GET', '/accounts'),
  createAccount: (body: AccountCreate) => request<AccountOut>('POST', '/accounts', { body }),
  updateAccount: (id: string, body: AccountUpdate) =>
    request<AccountOut>('PATCH', `/accounts/${enc(id)}`, { body }),
  /** 409 when the account has transactions or uploads, or a rule references it: archive it instead. */
  deleteAccount: (id: string) => request<void>('DELETE', `/accounts/${enc(id)}`),

  // Periods
  listPeriods: () => request<PeriodOut[]>('GET', '/periods'),
  closePeriod: (periodKey: string, force = false) =>
    request<PeriodOut>('POST', `/periods/${enc(periodKey)}/close`, { query: { force } }),
  reopenPeriod: (periodKey: string) => request<PeriodOut>('POST', `/periods/${enc(periodKey)}/reopen`),

  // Statements
  uploadStatement: (file: File, accountId?: string) => {
    const form = new FormData();
    form.append('file', file, file.name);
    if (accountId) form.append('account_id', accountId);
    return request<UploadResult>('POST', '/statements/upload', { form });
  },
  listStatements: () => request<StatementOut[]>('GET', '/statements'),
  /**
   * Removes the upload with every line it brought in (split parts and mirror legs included),
   * so the same file can be uploaded again. 409 while a line sits in a closed period, or for
   * an upload with `deletable: false`; 404 unknown.
   */
  deleteStatement: (id: string) => request<void>('DELETE', `/statements/${enc(id)}`),

  // Transactions
  listTransactions: (query: TransactionQuery) =>
    request<TransactionListResponse>('GET', '/transactions', { query: { ...query } }),
  patchTransaction: (id: string, patch: TransactionPatch) =>
    request<TransactionOut>('PATCH', `/transactions/${enc(id)}`, { body: patch }),
  approveTransaction: (id: string, body: ApproveBody) =>
    request<TransactionOut>('POST', `/transactions/${enc(id)}/approve`, { body }),
  approveBatch: (body: ApproveBatchBody) =>
    request<ApproveBatchResponse>('POST', '/transactions/approve-batch', { body }),
  /** Approves (or, with `dry_run`, lists) pending lines from merchants always filed one way. */
  autoApprove: (body: AutoApproveBody) =>
    request<AutoApproveResponse>('POST', '/transactions/auto-approve', { body }),
  deleteTransaction: (id: string) => request<void>('DELETE', `/transactions/${enc(id)}`),
  /** Splits (or re-splits) a transaction; the parent comes back approved with `parts` filled. */
  splitTransaction: (id: string, parts: SplitPartInput[]) =>
    request<TransactionOut>('PUT', `/transactions/${enc(id)}/split`, { body: { parts } satisfies SplitBody }),
  /** Removes a split; the parent comes back whole and still approved. */
  unsplitTransaction: (id: string) => request<TransactionOut>('DELETE', `/transactions/${enc(id)}/split`),

  // Transfers
  listUnmatchedTransfers: () => request<TransferBufferOut[]>('GET', '/transfers/unmatched'),
  rematchTransfers: () => request<{ matched: number }>('POST', '/transfers/rematch'),
  ignoreTransfer: (bufferId: string) => request<TransferBufferOut>('POST', `/transfers/${enc(bufferId)}/ignore`),
  matchTransfers: (bufferIdA: string, bufferIdB: string) =>
    request<[TransferBufferOut, TransferBufferOut]>('POST', '/transfers/match', {
      body: { buffer_id_a: bufferIdA, buffer_id_b: bufferIdB },
    }),

  // Claims
  createClaim: (body: ClaimCreate) => request<ClaimOut>('POST', '/claims', { body }),
  listClaims: (query: { period?: string; settled?: boolean } = {}) =>
    request<ClaimOut[]>('GET', '/claims', { query: { ...query } }),
  deleteClaim: (id: string) => request<void>('DELETE', `/claims/${enc(id)}`),

  // Settlement
  getSettlement: (periodKey: string) => request<SettlementOut>('GET', `/settlement/${enc(periodKey)}`),
  /** 201. 409 for a payment or adjustment in a closed period; a checkpoint is allowed there and replaces the month's one. Recording a payment settles the month's claims. 422 for more than two decimals. */
  createSettlementEntry: (body: SettlementEntryCreate) =>
    request<SettlementEntry>('POST', '/settlement/entries', { body }),
  /** 204. 409 for a payment or adjustment in a closed period; a checkpoint may be removed there. */
  deleteSettlementEntry: (id: string) => request<void>('DELETE', `/settlement/entries/${enc(id)}`),

  // Metrics
  getMetrics: (periodKey: string) => request<MetricsOut>('GET', `/metrics/${enc(periodKey)}`),
  /** `ending` is the last period of the window (YYYY-MM); the server defaults to the newest. */
  getTrends: (periods = 6, ending?: string) =>
    request<TrendPoint[]>('GET', '/metrics/trends', { query: { periods, ending } }),
  getInvestmentMetrics: () => request<InvestmentMetrics>('GET', '/metrics/investment'),

  // Audit
  runAudit: (periodKey: string) => request<AuditReportOut>('POST', `/audit/${enc(periodKey)}/run`),
  /** The latest report, or null (200 with a JSON `null` body) when none has been run for the period. */
  getAudit: (periodKey: string) => request<AuditReportOut | null>('GET', `/audit/${enc(periodKey)}`),

  // Subscriptions (no AI): recurring payments, price changes, new and stopped ones
  getSubscriptions: () => request<SubscriptionsOut>('GET', '/subscriptions'),

  // Merchant memory
  listMemory: (limit = 200) => request<MemoryOut[]>('GET', '/memory', { query: { limit } }),
  deleteMemory: (id: string) => request<void>('DELETE', `/memory/${enc(id)}`),

  // System (version and self-update)
  getSystem: () => request<SystemInfo>('GET', '/system'),
  /** Same body as `getSystem`, after a fresh look at GitHub (bypasses the server's cache). */
  checkForUpdates: () => request<SystemInfo>('POST', '/system/check'),
  /**
   * 202 once started. The server takes a pre-update backup first: 409 when that fails
   * (`BACKUP_BEFORE_UPDATE_FAILED`; pass `skipBackup` to update without one) or when an
   * update is already running; 503 when the updater is unavailable.
   */
  startUpdate: (skipBackup = false) =>
    request<UpdateStarted>('POST', '/system/update', { query: { skip_backup: skipBackup || undefined } }),
  /** Every backup, newest first. */
  listBackups: () => request<BackupItem[]>('GET', '/system/backups'),
  /** Takes a manual backup now (waits for one already running); 500 when pg_dump fails. */
  createBackup: () => request<BackupItem>('POST', '/system/backups'),
  /** The dump file itself, for saving. */
  downloadBackup: (name: string) => requestBlob(`/system/backups/${enc(name)}`),
  deleteBackup: (name: string) => request<void>('DELETE', `/system/backups/${enc(name)}`),
  /** 422 when `confirm` is not the scope's phrase (`RESET_PHRASES`); logins stay valid either way. */
  resetSystem: (body: ResetBody) => request<ResetOut>('POST', '/system/reset', { body }),

  // AI setup (primary only)
  getAi: () => request<AiSettings>('GET', '/ai'),
  /** 409 when the embedding change would orphan the merchant memory (send `clear_memory`); 422 for bad values or a bad proxy URL. */
  updateAi: (body: AiUpdate) => request<AiSettings>('PUT', '/ai', { body }),
  /** Calls each model once, through the proxy on the form (a freshly typed key included), saved or not. */
  testAi: (body: AiUpdate) => request<AiTestResult>('POST', '/ai/test', { body }),
  /** Forgets a learnt PDF layout; the next statement of that kind goes to the model again. 404 unknown. */
  deleteLayout: (id: string) => request<void>('DELETE', `/ai/layouts/${enc(id)}`),
  /** 409 while AI is off, 422 when the question cannot be expressed (the detail says why), 502 when the model failed. */
  ask: (question: string) => request<AskOut>('POST', '/ask', { body: { question } }),

  // Household, categories and rules (primary only)
  getHousehold: () => request<HouseholdOut>('GET', '/settings/household'),
  /** 422 names the field: a blank name, a negative income, proportional with no income, a bad currency code or symbol. */
  updateHousehold: (body: HouseholdUpdate) => request<HouseholdOut>('PUT', '/settings/household', { body }),
  getCategories: () => request<CategoriesOut>('GET', '/settings/categories'),
  /** The whole list: adds, removes and reorders. 422 for a blank, duplicate or long name; 409 when a removed one is in use. */
  updateCategories: (categories: string[], emojis?: Record<string, string>) =>
    request<CategoriesOut>('PUT', '/settings/categories', {
      body: (emojis ? { categories, emojis } : { categories }) satisfies CategoriesUpdate,
    }),
  /** The categories a merchant was filed under before, and the most used overall (primary only). */
  getCategorySuggestions: (merchant: string, limit = 3) =>
    request<CategorySuggestions>('GET', '/categories/suggestions', { query: { merchant, limit } }),
  /** Renames it everywhere. 404 unknown; 409 when `to` exists or `from` is `UNCATEGORIZED`; 422 blank. */
  renameCategory: (from: string, to: string) =>
    request<CategoriesOut>('POST', '/settings/categories/rename', { body: { from, to } }),
  getRules: () => request<RulesOut>('GET', '/settings/rules'),
  /** 422 names the item: "rule 3: invalid regex …", "payment pattern 2: …". */
  updateRules: (body: RulesUpdate) => request<RulesOut>('PUT', '/settings/rules', { body }),
  /** Which rule a description would hit, and whether it counts as a card payment; tests unsaved lists when given. */
  testRule: (body: RuleTestBody) => request<RuleTestResult>('POST', '/settings/rules/test', { body }),
  /** Rules the approvals suggest (no AI); reading changes nothing. */
  getRuleSuggestions: () => request<RuleSuggestionsOut>('GET', '/settings/rules/suggestions'),
  /** Remembers that this suggestion is not wanted; it is not shown again. */
  dismissRuleSuggestion: (key: string) => request<void>('POST', '/settings/rules/suggestions/dismiss', { body: { key } }),
};

export type Api = typeof api;
