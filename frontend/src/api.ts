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

export interface AccountConfig {
  id: string;
  institution: string;
  /** Optional friendlier display name from config.yaml, e.g. "HSBC Premier". */
  label?: string | null;
  account_type: string;
  owner: string;
  identifier_last4: string;
  default_claim_type?: ClaimType | null;
  billed_to?: string | null;
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
  id: string;
  institution: string;
  account_type: string;
  owner_user_id: string;
  identifier_last4: string;
}

export interface HealthOut {
  status: string;
  database: string;
  llm_provider: string;
  embedding_provider: string;
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

export interface MetricsOut {
  period_key: string;
  macro: {
    household_burn: Money;
    primary_accounts_burn: Money;
    partner_claims_burn: Money;
    by_category: CategoryAmount[];
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
  listAccounts: () => request<AccountOut[]>('GET', '/accounts'),
  health: () => request<HealthOut>('GET', '/health'),

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
  getAudit: (periodKey: string) => request<AuditReportOut>('GET', `/audit/${enc(periodKey)}`),

  // Merchant memory
  listMemory: (limit = 200) => request<MemoryOut[]>('GET', '/memory', { query: { limit } }),
  deleteMemory: (id: string) => request<void>('DELETE', `/memory/${enc(id)}`),
};

export type Api = typeof api;
