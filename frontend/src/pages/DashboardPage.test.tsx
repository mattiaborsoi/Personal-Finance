import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { writeSession, type PeriodOut } from '../api';
import { AuthProvider } from '../auth/AuthProvider';
import { ConfigContext } from '../config/ConfigContext';
import { currentPeriodKey, monthName, periodLabel } from '../lib/dates';
import { household, period, statement } from '../test/fixtures';
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
  it('says how many lines are waiting and in which months, and links to the Review page, without the queue itself', async () => {
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/periods') return jsonResponse(periodsWith(12));
      return undefined;
    });

    renderWithProviders(<DashboardPage />, { route: '/?period=2026-07' });

    const card = await screen.findByRole('region', { name: 'Waiting for review' });
    expect(card).toHaveTextContent(/12 lines waiting for review in July( 2026)?/);
    expect(card).toHaveTextContent('The figures below may change until they are approved.');
    // The Review page opens on the oldest month with lines waiting.
    expect(within(card).getByRole('link', { name: 'Review now' })).toHaveAttribute('href', '/review');
    // The queue lives on the Review page now: the dashboard neither shows it nor asks for it.
    expect(screen.queryByRole('region', { name: 'Approval queue' })).not.toBeInTheDocument();
    expect(queueRequests(calls)).toEqual([]);
  });

  it('uses the singular for one line', async () => {
    mockFetch(({ method, url }) => (method === 'GET' && url === '/api/periods' ? jsonResponse(periodsWith(1)) : undefined));

    renderWithProviders(<DashboardPage />, { route: '/?period=2026-07' });

    expect(await screen.findByRole('region', { name: 'Waiting for review' })).toHaveTextContent('1 line waiting for review');
  });

  it('shows no card when nothing is waiting', async () => {
    mockFetch(({ method, url }) => (method === 'GET' && url === '/api/periods' ? jsonResponse(periodsWith(0)) : undefined));

    renderWithProviders(<DashboardPage />, { route: '/?period=2026-07' });

    expect(await screen.findByRole('option', { name: 'July 2026' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Waiting for review' })).not.toBeInTheDocument();
    expect(screen.queryByText(/waiting for review/)).not.toBeInTheDocument();
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

    await user.click(within(group).getByRole('button', { name: /Personal/ }));
    expect(within(group).getByRole('button', { name: /Personal/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('search')).toHaveTextContent('?period=2026-07&view=micro');
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

  it('shows lines waiting in older months while the current month, on show, has none', async () => {
    serve({ [current]: 0, [last]: 5, [before]: 3 });

    renderWithProviders(<DashboardPage />, { route: '/' });

    const card = await screen.findByRole('region', { name: 'Waiting for review' });
    expect(card).toHaveTextContent(`8 lines waiting for review in ${monthName(before)} and ${monthName(last)}`);
    expect(card).toHaveTextContent('Figures for those months may change until they are approved.');
    expect(within(card).getByRole('link', { name: 'Review now' })).toHaveAttribute('href', '/review');
  });

  it('counts the current month with the others when lines wait there too', async () => {
    serve({ [current]: 2, [last]: 1 });

    renderWithProviders(<DashboardPage />, { route: '/' });

    const card = await screen.findByRole('region', { name: 'Waiting for review' });
    expect(card).toHaveTextContent(`3 lines waiting for review in ${monthName(last)} and ${monthName(current)}`);
    expect(card).toHaveTextContent('The figures below may change until they are approved.');
  });

  it('shows no card when no month has anything waiting', async () => {
    serve({ [current]: 0, [last]: 0 });

    renderWithProviders(<DashboardPage />, { route: '/' });

    expect(await screen.findByRole('option', { name: periodLabel(current) })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Waiting for review' })).not.toBeInTheDocument();
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
