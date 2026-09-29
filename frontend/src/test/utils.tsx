import { render, screen, type RenderResult } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { writeSession, type AppConfig, type Session } from '../api';
import { AuthProvider } from '../auth/AuthProvider';
import { ConfigContext } from '../config/ConfigContext';

export const fixtureConfig: AppConfig = {
  base_currency: 'GBP',
  currency_symbol: '£',
  users: {
    primary: { id: 'user_primary', display_name: 'Alex' },
    secondary: { id: 'user_secondary', display_name: 'Sam' },
  },
  split: {
    strategy: 'salary_proportional',
    primary_ratio: '0.555556',
    secondary_ratio: '0.444444',
    rounding_decimals: 2,
    settlement_day_of_month: 1,
  },
  // Mirrors the accounts in config.example.yaml.
  accounts: [
    {
      id: 'acc_checking_hsbc',
      institution: 'HSBC',
      label: 'HSBC Premier',
      account_type: 'checking',
      owner: 'user_primary',
      identifier_last4: '4471',
      is_active: true,
    },
    {
      id: 'acc_checking_barclays',
      institution: 'Barclays',
      label: 'Barclays Premier',
      account_type: 'checking',
      owner: 'user_secondary',
      identifier_last4: '2093',
      is_active: true,
    },
    {
      id: 'acc_cc_amex',
      institution: 'Amex',
      label: 'Amex Platinum',
      account_type: 'credit',
      owner: 'user_primary',
      identifier_last4: '7715',
      is_active: true,
    },
    {
      id: 'acc_cc_amex_supp',
      institution: 'Amex',
      label: 'Amex Platinum (supplementary)',
      account_type: 'credit_supplementary',
      owner: 'user_secondary',
      identifier_last4: '3348',
      default_claim_type: 'shared_proportional',
      billed_to: 'user_primary',
      is_active: true,
    },
    {
      id: 'acc_cc_virgin',
      institution: 'Virgin',
      label: 'Virgin Money credit card',
      account_type: 'credit',
      owner: 'user_primary',
      identifier_last4: '5502',
      is_active: true,
    },
    {
      id: 'acc_invest_robinhood',
      institution: 'Robinhood',
      label: 'Robinhood',
      account_type: 'investment_cash',
      owner: 'user_primary',
      identifier_last4: 'INVEST',
      is_active: true,
    },
  ],
  categories: ['Groceries', 'Dining', 'Bills:Water', 'Transport:Taxi', 'Uncategorized'],
  claim_types: ['personal', 'shared_proportional', 'shared_equal', 'secondary_personal', 'primary_personal'],
};

export const primarySession: Session = {
  token: 'primary-token',
  role: 'primary',
  user_id: 'user_primary',
  display_name: 'Alex',
};

export const secondarySession: Session = {
  token: 'secondary-token',
  role: 'secondary',
  user_id: 'user_secondary',
  display_name: 'Sam',
};

interface Options {
  session?: Session | null;
  route?: string;
  /** Replaces `fixtureConfig`, e.g. to give the category groups emojis. */
  config?: AppConfig;
}

export function renderWithProviders(
  ui: ReactElement,
  { session = primarySession, route = '/', config = fixtureConfig }: Options = {},
): RenderResult {
  writeSession(session);
  return render(
    <MemoryRouter initialEntries={[route]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider initialSession={session}>
        <ConfigContext.Provider value={config}>{ui}</ConfigContext.Provider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export type RouteHandler = (call: RecordedCall) => Response | Promise<Response> | undefined;

/**
 * Installs a fetch stub. `handler` receives each call and returns a Response;
 * an undefined return falls through to a 404. Returns the recorded calls.
 */
export function mockFetch(handler: RouteHandler): { calls: RecordedCall[]; fetch: ReturnType<typeof vi.fn> } {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init?.body instanceof FormData) {
      body = init.body;
    }
    const call: RecordedCall = { method: (init?.method ?? 'GET').toUpperCase(), url, headers, body };
    calls.push(call);
    const response = await handler(call);
    return response ?? jsonResponse({ detail: `No mock for ${call.method} ${url}` }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetch: fetchMock };
}

/** A control by its accessible name, or the element itself. */
function control(target: string | HTMLElement, role: string): HTMLElement {
  return typeof target === 'string' ? screen.getByRole(role, { name: target }) : target;
}

/** Opens a category picker (by its name or element) and clicks the option for `category` (the stored name, e.g. "Bills:Water"). */
export async function pickCategory(user: UserEvent, target: string | HTMLElement, category: string): Promise<void> {
  await user.click(control(target, 'button'));
  const listbox = await screen.findByRole('listbox', { name: 'Categories' });
  const option = Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"][data-kind="option"]')).find(
    (o) => o.dataset.value === category,
  );
  if (!option) throw new Error(`No option for ${category}`);
  await user.click(option);
}

/** The stored category a picker shows. */
export function categoryValue(target: string | HTMLElement): string {
  return (control(target, 'button') as HTMLButtonElement).value;
}

/** Clicks the segment for `claimType` in a claim-type radio group (by its name or element). */
export async function pickClaimType(user: UserEvent, target: string | HTMLElement, claimType: string): Promise<void> {
  const radio = control(target, 'radiogroup').querySelector<HTMLElement>(`[role="radio"][data-value="${claimType}"]`);
  if (!radio) throw new Error(`No segment for ${claimType}`);
  await user.click(radio);
}

/** The claim type a radio group has checked, or "" when none is. */
export function claimTypeValue(target: string | HTMLElement): string {
  return control(target, 'radiogroup').querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.dataset.value ?? '';
}
