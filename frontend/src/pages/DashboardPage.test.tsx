import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { writeSession, type PeriodOut } from '../api';
import { AuthProvider } from '../auth/AuthProvider';
import { ConfigContext } from '../config/ConfigContext';
import { currentPeriodKey, monthName, periodLabel } from '../lib/dates';
import { household, metrics, period, statement } from '../test/fixtures';
import {
  fixtureConfig,
  jsonResponse,
  mockFetch,
  primarySession,
  renderWithProviders,
  type RecordedCall,
} from '../test/utils';
import { DashboardPage } from './DashboardPage';

function periodsWith(pending: number): PeriodOut[] {
  return [
    period({ period_key: '2026-07', start_date: '2026-07-01', end_date: '2026-07-31', transaction_count: 40, pending_review_count: pending }),
  ];
}

function queueRequests(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.url.includes('status=pending_review'));
}

describe('<DashboardPage />', () => {
  it('keeps the queue on the Review page and does not repeat the waiting count in a card', async () => {
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse(periodsWith(12));
      return undefined;
    });

    renderWithProviders(<DashboardPage />, { route: '/?period=2026-07' });

    // The settlement card's progress chip is the way to Review; no separate card repeats it.
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Waiting for review' })).not.toBeInTheDocument());
    // The queue lives on the Review page now: the dashboard neither shows it nor asks for it.
    expect(screen.queryByRole('region', { name: 'Approval queue' })).not.toBeInTheDocument();
    expect(queueRequests(calls)).toEqual([]);
    // Nothing waits elsewhere, so there is no header note either.
    expect(screen.queryByTestId('pending-elsewhere')).not.toBeInTheDocument();
  });

  it('shows no card when nothing is waiting', async () => {
    mockFetch(({ method, url }) => (method === 'GET' && url === '/api/periods' ? jsonResponse(periodsWith(0)) : undefined));

    renderWithProviders(<DashboardPage />, { route: '/?period=2026-07' });

    expect(await screen.findByRole('option', { name: 'July 2026' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Waiting for review' })).not.toBeInTheDocument();
    expect(screen.queryByText(/waiting for review/)).not.toBeInTheDocument();
  });

  it('leads with the settlement, puts Run audit in the header, and ends with the investments', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse(periodsWith(0));
      if (method === 'GET' && url === '/api/audit/2026-07') return jsonResponse(null);
      return undefined;
    });

    renderWithProviders(<DashboardPage />, { route: '/?period=2026-07' });

    const settlement = await screen.findByRole('region', { name: 'Settlement' });
    const household = screen.getByRole('region', { name: 'Household' });
    const investments = screen.getByRole('region', { name: 'Investments' });
    expect(settlement.compareDocumentPosition(household) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(household.compareDocumentPosition(investments) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run audit' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Audit' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Regular payments' })).toBeInTheDocument();
  });

  it('reads the metric view from ?view= and writes a new choice back, keeping the period', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => (method === 'GET' && url === '/api/periods' ? jsonResponse(periodsWith(0)) : undefined));
    function Search() {
      return <output data-testid="search">{useLocation().search}</output>;
    }

    renderWithProviders(
      <>
        <DashboardPage />
        <Search />
      </>,
      { route: '/?period=2026-07&view=liquidity' },
    );

    const group = await screen.findByRole('group', { name: 'Metric view' });
    expect(within(group).getByRole('button', { name: /Cash flow/ })).toHaveAttribute('aria-pressed', 'true');

    await user.click(within(group).getByRole('button', { name: /My share/ }));
    expect(within(group).getByRole('button', { name: /My share/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('search')).toHaveTextContent('?period=2026-07&view=micro');
  });

  it('switches to the year: its totals and months, the same months of last year, no settlement', async () => {
    const user = userEvent.setup();
    const trend = (period_key: string, v: string) => ({
      period_key, household_burn: v, household_net: v, true_net_expense: v, net_cash_flow: v,
    });
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse(periodsWith(0));
      if (method === 'GET' && url === '/api/metrics/year/2026') {
        return jsonResponse({
          year: 2026,
          totals: metrics({ period_key: '2026' }),
          months: Array.from({ length: 7 }, (_, i) => trend(`2026-0${i + 1}`, '100.00')),
          previous: trend('2025', '500.00'),
        });
      }
      return undefined;
    });
    function Search() {
      return <output data-testid="search">{useLocation().search}</output>;
    }

    renderWithProviders(
      <>
        <DashboardPage />
        <Search />
      </>,
      { route: '/?period=2026-07' },
    );
    await screen.findByRole('region', { name: 'Settlement' });
    await user.click(within(screen.getByRole('group', { name: 'Month or year' })).getByRole('button', { name: 'Year' }));

    expect(screen.getByTestId('search')).toHaveTextContent('?period=2026-07&scope=year');
    expect(await screen.findByText('2026 by month')).toBeInTheDocument();
    expect(screen.getByLabelText('Year')).toHaveValue('2026');
    expect(screen.queryByRole('region', { name: 'Settlement' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run audit' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/metrics/year/2026')).toBe(true);
    // 7 months at 100 against 500 over the same months of 2025.
    expect(screen.getByTestId('headline-change')).toHaveTextContent('up £200.00 (40%) on January to July 2025');
    expect(screen.getByText('All of 2026')).toBeInTheDocument();
  });
});

/** The month `back` months before this one, as YYYY-MM. */
function monthsBack(back: number): string {
  const now = new Date();
  return currentPeriodKey(new Date(now.getFullYear(), now.getMonth() - back, 1));
}

describe('<DashboardPage /> pending card across months', () => {
  const current = monthsBack(0);
  const last = monthsBack(1);
  const before = monthsBack(2);

  function serve(pending: Record<string, number>) {
    mockFetch(({ method, url }) =>
      method === 'GET' && url === '/api/periods'
        ? jsonResponse(Object.entries(pending).map(([period_key, n]) => period({ period_key, pending_review_count: n })))
        : undefined,
    );
  }

  it('notes lines waiting in earlier months in one quiet line, without naming them, while the month on show has none', async () => {
    serve({ [current]: 0, [last]: 5, [before]: 3 });

    renderWithProviders(<DashboardPage />, { route: '/' });

    const note = await screen.findByTestId('pending-elsewhere');
    expect(note).toHaveTextContent('8 lines still to review in 2 earlier months');
    expect(note).not.toHaveTextContent(monthName(last));
    expect(within(note).getByRole('link', { name: 'Review them' })).toHaveAttribute('href', '/review');
    expect(screen.queryByRole('region', { name: 'Waiting for review' })).not.toBeInTheDocument();
  });

  it('notes lines waiting in other months', async () => {
    serve({ [current]: 2, [last]: 1 });

    renderWithProviders(<DashboardPage />, { route: '/' });

    expect(await screen.findByTestId('pending-elsewhere')).toHaveTextContent('1 line still to review in 1 earlier month');
  });

  it('calls them other months when one of them is later than the month on show', async () => {
    serve({ [current]: 4, [last]: 0, [before]: 0 });

    renderWithProviders(<DashboardPage />, { route: `/?period=${last}` });

    expect(await screen.findByTestId('pending-elsewhere')).toHaveTextContent('4 lines still to review in 1 other month');
  });

  it('shows no card when no month has anything waiting', async () => {
    serve({ [current]: 0, [last]: 0 });

    renderWithProviders(<DashboardPage />, { route: '/' });

    expect(await screen.findByRole('option', { name: periodLabel(current) })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Waiting for review' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('pending-elsewhere')).not.toBeInTheDocument();
  });
});

describe('<DashboardPage /> first-run checklist', () => {
  function serve({ stored, uploads, periods = [] }: { stored: boolean; uploads: number; periods?: PeriodOut[] }) {
    return mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse(periods);
      if (method === 'GET' && url === '/api/settings/household') return jsonResponse(household({ stored }));
      if (method === 'GET' && url === '/api/statements') {
        return jsonResponse(Array.from({ length: uploads }, () => statement()));
      }
      return undefined;
    });
  }

  /** Like `renderWithProviders`, with a config that has no accounts yet (a fresh install). */
  function renderFresh() {
    writeSession(primarySession);
    render(
      <MemoryRouter initialEntries={['/']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider initialSession={primarySession}>
          <ConfigContext.Provider value={{ ...fixtureConfig, accounts: [] }}>
            <DashboardPage />
          </ConfigContext.Provider>
        </AuthProvider>
      </MemoryRouter>,
    );
  }

  it('lists all three steps on a fresh install, each linking to where it is done', async () => {
    serve({ stored: false, uploads: 0 });

    renderFresh();

    const checklist = await screen.findByRole('region', { name: 'Get started' });
    expect(checklist).toHaveTextContent('0 of 3 done');
    expect(within(checklist).getByRole('link', { name: 'Name the two of you and set incomes' })).toHaveAttribute(
      'href',
      '/settings?tab=household',
    );
    expect(within(checklist).getByRole('link', { name: 'Add the accounts your statements come from' })).toHaveAttribute(
      'href',
      '/settings?tab=accounts',
    );
    expect(within(checklist).getByRole('link', { name: 'Upload your first statement' })).toHaveAttribute('href', '/upload');
    // The empty state no longer sends a fresh install straight to an upload that would fail.
    expect(await screen.findByText(/Once the steps above are done/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Upload a statement' })).not.toBeInTheDocument();
  });

  it('ticks the steps that are done', async () => {
    serve({ stored: true, uploads: 0 });

    renderWithProviders(<DashboardPage />, { route: '/' });

    const checklist = await screen.findByRole('region', { name: 'Get started' });
    expect(checklist).toHaveTextContent('2 of 3 done');
    expect(within(checklist).getByText('Name the two of you and set incomes')).toBeInTheDocument();
    expect(within(checklist).queryByRole('link', { name: 'Name the two of you and set incomes' })).not.toBeInTheDocument();
    expect(within(checklist).getAllByText('(done)')).toHaveLength(2);
    expect(within(checklist).getByRole('link', { name: 'Upload your first statement' })).toBeInTheDocument();
  });

  it('is gone once every step is done', async () => {
    serve({ stored: true, uploads: 1, periods: [period({ period_key: monthsBack(0) })] });

    renderWithProviders(<DashboardPage />, { route: '/' });

    expect(await screen.findByRole('combobox', { name: 'Period' })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole('region', { name: 'Get started' })).not.toBeInTheDocument();
  });
});
