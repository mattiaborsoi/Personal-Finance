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

export interface MeResponse {
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

export interface HealthOut {
  status: string;
  database: string;
}

export interface PeriodOut {
  period_key: string;
  start_date: string;
  end_date: string;
  is_closed: boolean;
  closed_at: string | null;
  transaction_count: number;
  pending_review_count: number;
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
  created_at: string;
  /** True once the transaction has been split into parts (see `parts`). */
  is_split: boolean;
  /** Set on a part. Parts never appear in the list; they are embedded in their parent. */
  split_parent_id: string | null;
  /** Populated only when `is_split`; otherwise empty. */
  parts: TransactionPart[];
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
}

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
  snapshot_at: string | null;
}

export interface MarkSettledResponse {
  settled_claims: number;
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

export interface MetricsOut {
  period_key: string;
  macro: {
    household_burn: Money;
    primary_accounts_burn: Money;
    partner_claims_burn: Money;
    /** Gross debits per category plus a `PARTNER_CLAIMS_CATEGORY` row, summing to `household_burn`. */
    by_category: CategoryAmount[];
    /** Refunds received in the period (positive); the headline deliberately does not deduct them. */
    refunds: Money;
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
  default_claim_type: ClaimType | null;
  review_count: number;
  last_updated: string;
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
  app: { name: string; version: string };
  /** "owner/repo" on GitHub. */
  repository: string;
  branch: string;
  /** The commit the server was built from; null when unknown. */
  running: { commit: string | null; short: string | null };
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
}

export interface UpdateStarted {
  state: 'running';
  started_at: string;
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
  /** Required (true) when the embedding model or provider changes while `memory_rows` > 0. */
  clear_memory?: boolean;
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
  return 'Something went wrong.';
}

export function isApiError(err: unknown, status?: number): err is ApiError {
  return err instanceof ApiError && (status === undefined || err.status === status);
}

export const PERIOD_CLOSED_MESSAGE = 'This period is closed, so it can no longer be edited.';

/**
 * Like `errorMessage`, for edits to transactions and claims: the backend
 * answers 409 when the period is closed, which deserves a plain sentence
 * rather than the server's wording.
 */
export function editErrorMessage(err: unknown): string {
  if (isApiError(err, 409)) return PERIOD_CLOSED_MESSAGE;
  return errorMessage(err);
}

export const FILE_TOO_LARGE_MESSAGE = 'File too large (limit 25 MB).';

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
    const message = describeDetail(detail) || `Request failed (${response.status})`;
    throw new ApiError(response.status, detail, message);
  }

  return data as T;
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
  me: () => request<MeResponse>('GET', '/auth/me'),

  // Reference
  getConfig: () => request<AppConfig>('GET', '/config'),
  health: () => request<HealthOut>('GET', '/health'),

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

  // Transactions
  listTransactions: (query: TransactionQuery) =>
    request<TransactionListResponse>('GET', '/transactions', { query: { ...query } }),
  getTransaction: (id: string) => request<TransactionOut>('GET', `/transactions/${enc(id)}`),
  patchTransaction: (id: string, patch: TransactionPatch) =>
    request<TransactionOut>('PATCH', `/transactions/${enc(id)}`, { body: patch }),
  approveTransaction: (id: string, body: ApproveBody) =>
    request<TransactionOut>('POST', `/transactions/${enc(id)}/approve`, { body }),
  approveBatch: (body: ApproveBatchBody) =>
    request<ApproveBatchResponse>('POST', '/transactions/approve-batch', { body }),
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
  markSettled: (periodKey: string) =>
    request<MarkSettledResponse>('POST', `/settlement/${enc(periodKey)}/mark-settled`),

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

  // Merchant memory
  listMemory: (limit = 200) => request<MemoryOut[]>('GET', '/memory', { query: { limit } }),
  deleteMemory: (id: string) => request<void>('DELETE', `/memory/${enc(id)}`),

  // System (version and self-update)
  getSystem: () => request<SystemInfo>('GET', '/system'),
  /** Same body as `getSystem`, after a fresh look at GitHub (bypasses the server's cache). */
  checkForUpdates: () => request<SystemInfo>('POST', '/system/check'),
  /** 202 once started; 409 when an update is already running, 503 when the updater is unavailable. */
  startUpdate: () => request<UpdateStarted>('POST', '/system/update'),

  // AI setup (primary only)
  getAi: () => request<AiSettings>('GET', '/ai'),
  /** 409 when the embedding change would orphan the merchant memory (send `clear_memory`); 422 for bad values or a bad proxy URL. */
  updateAi: (body: AiUpdate) => request<AiSettings>('PUT', '/ai', { body }),
  /** Calls each model once, through the proxy on the form (a freshly typed key included), saved or not. */
  testAi: (body: AiUpdate) => request<AiTestResult>('POST', '/ai/test', { body }),
};

export type Api = typeof api;
