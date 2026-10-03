import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SettlementCheckpoint, SettlementEntry, SettlementLedgerPayment, SettlementOut } from '../api';
import { period, settlement, settlementBalance } from '../test/fixtures';
import { jsonResponse, mockFetch, renderWithProviders, secondarySession } from '../test/utils';
import { SettlementBanner } from './SettlementBanner';

const snapshot = {
  period_key: '2026-03',
  net_owed_by_secondary: '45.90',
  secondary_share_of_primary_paid_shared: '120.00',
  primary_share_of_secondary_paid_shared: '60.00',
  secondary_personal_on_primary_paid: '10.00',
  primary_personal_on_secondary_paid: '24.10',
  settlement_payments_received: '0.00',
  line_count: 1,
  snapshot_at: '2026-04-01T08:00:00Z',
};

const ledgerPayment: SettlementLedgerPayment = {
  transaction_id: 'b7e1c2d3-0001-4a5b-8c9d-0e1f2a3b4c01',
  date: '2026-03-18',
  amount: '100.00',
  account_id: 'acc_checking_hsbc',
  description: 'Transfer from Sam',
  effect: '100.00',
};

const manualPayment: SettlementEntry = {
  id: 'c8f2d3e4-0002-4b6c-9d0e-1f2a3b4c5d02',
  period_key: '2026-03',
  kind: 'payment',
  entry_date: '2026-03-10',
  amount: '50.00',
  paid_by: 'user_secondary',
  note: 'Cash for the plumber',
  net_at_checkpoint: null,
  created_by: 'user_primary',
  created_at: '2026-03-10T09:00:00Z',
};

const adjustment: SettlementEntry = {
  id: 'd9a3e4f5-0003-4c7d-8e1f-2a3b4c5d6e03',
  period_key: '2026-03',
  kind: 'adjustment',
  entry_date: '2026-03-31',
  amount: '5.00',
  paid_by: null,
  note: 'Rounding',
  net_at_checkpoint: null,
  created_by: 'user_primary',
  created_at: '2026-03-31T09:00:00Z',
};

const checkpoint: SettlementCheckpoint = {
  id: 'e0b4f5a6-0004-4d8e-9f2a-3b4c5d6e7f04',
  amount: '300.00',
  entry_date: '2026-03-31',
  note: 'Agreed over dinner',
  net_at_checkpoint: '45.90',
  drift: '0.00',
  drifted: false,
};

/** A running balance: £266.50 carried in from February, £45.90 this month, £100 paid through the ledger. */
function running(overrides: Partial<SettlementOut> = {}): SettlementOut {
  return settlement({
    balance: settlementBalance({
      carried_in: '266.50',
      payments_ledger: '100.00',
      balance_out: '212.40',
      from_period: '2026-02',
    }),
    ledger_payments: [ledgerPayment],
    settlement_payments_received: '-100.00',
    ...overrides,
  });
}

/** A period whose every line is still pending: zero sums, no lines, nothing outstanding. */
function nothingApproved(overrides: Partial<SettlementOut> = {}): SettlementOut {
  return settlement({
    secondary_share_of_primary_paid_shared: '0.00',
    primary_share_of_secondary_paid_shared: '0.00',
    secondary_personal_on_primary_paid: '0.00',
    primary_personal_on_secondary_paid: '0.00',
    net_owed_by_secondary: '0.00',
    pending_review_count: 3,
    unsettled_claim_count: 0,
    lines: [],
    balance: settlementBalance({ net: '0.00', balance_out: '0.00' }),
    ...overrides,
  });
}

/** The working is collapsed by default; tests about its contents open it first. */
async function openWorking() {
  fireEvent.click(await screen.findByRole('button', { name: 'Show the working' }));
}

function serve(body: SettlementOut | (() => SettlementOut)) {
  return mockFetch(({ method, url }) => {
    if (method === 'GET' && url === '/api/settlement/2026-03') return jsonResponse(typeof body === 'function' ? body() : body);
    return undefined;
  });
}

describe('<SettlementBanner />', () => {
  it('stacks the actions under the figure on a phone and keeps each chip whole', async () => {
    serve(settlement());
    renderWithProviders(<SettlementBanner period="2026-03" />);

    const headline = await screen.findByTestId('settlement-headline');
    // Smaller on a phone, so the headline does not wrap one word per line.
    expect(headline).toHaveClass('text-xl', 'sm:text-4xl');
    expect(screen.getByTestId('settlement-top')).toHaveClass('flex-col', 'sm:flex-row');
    expect(screen.getByRole('button', { name: 'Record a payment' })).toHaveClass('w-full', 'sm:w-auto');
    expect(screen.getByRole('button', { name: 'Set the balance' })).toHaveClass('w-full', 'sm:w-auto');
    expect(screen.queryByRole('button', { name: 'Mark claims settled' })).not.toBeInTheDocument();
    expect(screen.getByText('Settle by 1 Apr 2026').closest('li')).toHaveClass('whitespace-nowrap');
    for (const half of screen.getByText(/Split 55\.6% Alex/).closest('li')!.querySelectorAll('span > span')) {
      expect(half).toHaveClass('whitespace-nowrap');
    }
  });

  it('keeps the working behind a disclosure, and shows the claims and the review progress as chips', async () => {
    serve(settlement({ unsettled_claim_count: 1 }));
    renderWithProviders(
      <SettlementBanner period="2026-03" periodInfo={period({ transaction_count: 40, pending_review_count: 1 })} />,
    );

    await screen.findByTestId('settlement-headline');
    expect(screen.queryByTestId('settlement-working')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show the working' })).toHaveAttribute('aria-expanded', 'false');
    // One claim in the lines, £60.00: count and amount, with how many are unsettled.
    expect(screen.getByTestId('settlement-claims')).toHaveTextContent('1 partner claim · £60.00, 1 unsettled');
    const progress = screen.getByTestId('settlement-progress');
    expect(progress).toHaveTextContent('97% approved · 1 to review');
    expect(within(progress).getByRole('link')).toHaveAttribute('href', '/review?period=2026-03');
    expect(progress).not.toHaveTextContent('unusual');

    await openWorking();
    expect(screen.getByTestId('settlement-working')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide the working' }));
    expect(screen.queryByTestId('settlement-working')).not.toBeInTheDocument();
  });

  it('counts the lines that look unusual in the progress chip, linking to the filtered Transactions view', async () => {
    serve(settlement());
    renderWithProviders(
      <SettlementBanner
        period="2026-03"
        periodInfo={period({ transaction_count: 40, pending_review_count: 0, unusual_count: 3 })}
      />,
    );
    await screen.findByTestId('settlement-headline');
    const progress = screen.getByTestId('settlement-progress');
    expect(progress).toHaveTextContent('100% approved · 3 lines look unusual');
    expect(within(progress).getByRole('link', { name: '3 lines look unusual' })).toHaveAttribute(
      'href',
      '/transactions?period=2026-03&unusual=true',
    );
  });

  it('headlines the outstanding balance, not the month’s gross, with the working in one line', async () => {
    serve(running({ balance: settlementBalance({ carried_in: '266.50', balance_out: '312.40', from_period: '2026-02' }), ledger_payments: [] }));
    renderWithProviders(<SettlementBanner period="2026-03" />);

    expect(await screen.findByTestId('settlement-headline')).toHaveTextContent('Sam owes Alex £312.40');
    expect(screen.getByTestId('settlement-headline-label')).toHaveTextContent('Outstanding at end of March 2026');
    expect(screen.getByTestId('settlement-working-line')).toHaveTextContent(
      'Carried in £266.50 owed by Sam · this month £45.90 owed by Sam · paid £0.00',
    );
    // The payments live in the working now, not in a chip.
    expect(screen.queryByText(/Payments received/)).not.toBeInTheDocument();
  });

  it('takes payments off: a month already paid says so instead of "owes"', async () => {
    serve(
      settlement({
        balance: settlementBalance({ payments_ledger: '45.90', balance_out: '0.00' }),
        ledger_payments: [{ ...ledgerPayment, amount: '45.90', effect: '45.90' }],
      }),
    );
    renderWithProviders(<SettlementBanner period="2026-03" />);
    expect(await screen.findByTestId('settlement-headline')).toHaveTextContent('Settled up');
    expect(screen.getByTestId('settlement-working-line')).toHaveTextContent('Sam paid £45.90');
  });

  it('lists every payment in the working with its date, account, description and effect', async () => {
    serve(
      running({
        balance: settlementBalance({
          carried_in: '266.50',
          payments_ledger: '100.00',
          payments_manual: '50.00',
          adjustments: '5.00',
          balance_out: '167.40',
          from_period: '2026-02',
        }),
        entries: [manualPayment, adjustment],
      }),
    );
    renderWithProviders(<SettlementBanner period="2026-03" />);
    await screen.findByTestId('settlement-headline');
    await openWorking();

    const working = screen.getByTestId('settlement-working');
    expect(within(working).getByText('From February 2026')).toBeInTheDocument();
    const payments = screen.getByTestId('settlement-payments');
    expect(payments).toHaveTextContent('18 Mar 2026');
    expect(payments).toHaveTextContent('HSBC Premier ··4471');
    expect(payments).toHaveTextContent('Transfer from Sam');
    expect(payments).toHaveTextContent('-£100.00');
    expect(payments).toHaveTextContent('Sam paid Alex');
    expect(payments).toHaveTextContent('Cash for the plumber');
    expect(payments).toHaveTextContent('-£50.00');
    // The section total: £150 off what Sam owes.
    expect(payments).toHaveTextContent('-£150.00');
    expect(screen.getByTestId('settlement-adjustments')).toHaveTextContent('+£5.00');
    expect(screen.getByTestId('settlement-outstanding')).toHaveTextContent('£167.40 owed by Sam');
    expect(screen.getByTestId('settlement-working-line')).toHaveTextContent(
      'Sam paid £150.00 · adjusted £5.00 in Alex’s favour',
    );
  });

  it('renders the reverse phrasing for a negative balance and "Settled up" for zero', async () => {
    let out = '-12.00';
    serve(() => settlement({ balance: settlementBalance({ balance_out: out }) }));

    const view = renderWithProviders(<SettlementBanner period="2026-03" />);
    expect(await screen.findByTestId('settlement-headline')).toHaveTextContent('Alex owes Sam £12.00');

    view.unmount();
    out = '0.00';
    renderWithProviders(<SettlementBanner period="2026-03" />);
    expect(await screen.findByTestId('settlement-headline')).toHaveTextContent('Settled up');
  });

  it('renders the components, split ratio, due date and pending warning from the API', async () => {
    serve(settlement({ pending_review_count: 3 }));
    renderWithProviders(<SettlementBanner period="2026-03" />);

    expect(await screen.findByTestId('settlement-headline')).toHaveTextContent('Sam owes Alex £45.90');
    expect(screen.getByText(/Split 55\.6% Alex \//).closest('li')).toHaveTextContent('Split 55.6% Alex / 44.4% Sam');
    expect(screen.getByText(/3 transactions are still pending review/)).toBeInTheDocument();
    await openWorking();
    expect(screen.getByText('Sam’s share of shared items Alex paid')).toBeInTheDocument();
    expect(screen.getByText('Alex’s personal items on Sam’s cards')).toBeInTheDocument();
    expect(screen.getByText('£24.10')).toBeInTheDocument();
    expect(screen.queryByTestId('settlement-snapshot')).not.toBeInTheDocument();
  });

  it('opens the lines panel from the button and from ?lines=open in the URL', async () => {
    const user = userEvent.setup();
    serve(settlement());

    const view = renderWithProviders(<SettlementBanner period="2026-03" />, { route: '/?period=2026-03' });
    await openWorking();
    const toggle = await screen.findByRole('button', { name: /^Show \d/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: /^Hide \d/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Ocado')).toBeInTheDocument();

    view.unmount();
    renderWithProviders(<SettlementBanner period="2026-03" />, { route: '/?period=2026-03&lines=open' });
    // The lines live inside the working, so the link opens both.
    expect(await screen.findByRole('button', { name: /^Hide \d/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Hide the working' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('says nothing is approved yet, not "Settled up", while every line is still pending', async () => {
    serve(nothingApproved());
    renderWithProviders(
      <SettlementBanner period="2026-03" periodInfo={period({ transaction_count: 3, pending_review_count: 3 })} />,
    );

    expect(await screen.findByTestId('settlement-headline')).toHaveTextContent('Nothing approved yet');
    expect(screen.queryByText('Settled up')).not.toBeInTheDocument();
    expect(screen.getByTestId('settlement-awaiting')).toHaveTextContent('3 lines are waiting for review');
    expect(screen.getByRole('link', { name: 'Review the queue' })).toHaveAttribute('href', '/review?period=2026-03');
    // The zero sums and the empty working would only dress up a figure that does not exist.
    expect(screen.queryByText('Sam’s share of shared items Alex paid')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settlement-working')).not.toBeInTheDocument();
    expect(screen.queryByText(/still pending review/)).not.toBeInTheDocument();
  });

  it('still shows a carried-in balance while this month has nothing approved', async () => {
    serve(nothingApproved({ balance: settlementBalance({ carried_in: '80.00', net: '0.00', balance_out: '80.00', from_period: '2026-02' }) }));
    renderWithProviders(
      <SettlementBanner period="2026-03" periodInfo={period({ transaction_count: 3, pending_review_count: 3 })} />,
    );
    expect(await screen.findByTestId('settlement-headline')).toHaveTextContent('Sam owes Alex £80.00');
    expect(screen.getByTestId('settlement-awaiting')).toHaveTextContent('Nothing from March 2026 is approved yet.');
  });

  it('keeps "Settled up" once something is approved, even with lines still pending', async () => {
    serve(nothingApproved());
    renderWithProviders(
      <SettlementBanner period="2026-03" periodInfo={period({ transaction_count: 4, pending_review_count: 3 })} />,
    );

    expect(await screen.findByTestId('settlement-headline')).toHaveTextContent('Settled up');
    expect(screen.queryByTestId('settlement-awaiting')).not.toBeInTheDocument();
    expect(screen.getByText(/3 transactions are still pending review/)).toBeInTheDocument();
    await openWorking();
    expect(screen.getByRole('button', { name: /show 0 lines/i })).toBeInTheDocument();
  });

  it('shows the figure recorded at close and warns only when the live figure has drifted', async () => {
    let net = '45.90';
    serve(() => settlement({ net_owed_by_secondary: net, snapshot }));

    const view = renderWithProviders(<SettlementBanner period="2026-03" />);
    await openWorking();
    const recorded = await screen.findByTestId('settlement-snapshot');
    expect(recorded).toHaveTextContent('Recorded at close: Sam owes Alex £45.90 (1 Apr 2026)');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();

    view.unmount();
    net = '52.00';
    renderWithProviders(<SettlementBanner period="2026-03" />);
    await openWorking();
    expect(await screen.findByRole('note')).toHaveTextContent(/live figure differs/i);
  });

  it('compares the outstanding balance with the one recorded at close when the snapshot has it', async () => {
    serve(running({ snapshot: { ...snapshot, balance_out: '212.40' } }));
    renderWithProviders(<SettlementBanner period="2026-03" />);
    await openWorking();
    expect(await screen.findByTestId('settlement-snapshot')).toHaveTextContent('Recorded at close: Sam owes Alex £212.40');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('records a payment: the POST body, the result announced, and one refetch', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url, body }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') return jsonResponse(settlement());
      if (method === 'POST' && url === '/api/settlement/entries') {
        return jsonResponse({ ...manualPayment, ...(body as object), id: 'new', created_at: '2026-03-20T10:00:00Z' }, 201);
      }
      return undefined;
    });

    renderWithProviders(<SettlementBanner period="2026-03" />);
    await user.click(await screen.findByRole('button', { name: 'Record a payment' }));
    const dialog = screen.getByRole('dialog', { name: 'Record a payment' });
    // Sam owes, so Sam is the one paying by default, and "the full amount" is on offer.
    expect(within(dialog).getByLabelText('Sam paid Alex')).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'The full £45.90' }));
    expect(within(dialog).getByLabelText('Amount')).toHaveValue('45.90');
    await user.clear(within(dialog).getByLabelText('Amount'));
    await user.type(within(dialog).getByLabelText('Amount'), '40');
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-03-20' } });
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Bank transfer');
    await user.click(within(dialog).getByRole('button', { name: 'Record payment' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({
      kind: 'payment',
      entry_date: '2026-03-20',
      amount: '40.00',
      paid_by: 'user_secondary',
      note: 'Bank transfer',
    });
    expect(post?.headers.Authorization).toBe('Bearer primary-token');
    expect(await screen.findByRole('status')).toHaveTextContent('Payment recorded: Sam paid £40.00 on 20 Mar 2026.');

    const gets = () => calls.filter((c) => c.method === 'GET').length;
    await waitFor(() => expect(gets()).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(gets()).toBe(2);
  });

  it('says there is nothing earlier when the balance is carried in from the month itself', async () => {
    serve(settlement({ balance: settlementBalance({ from_period: '2026-03' }) }));
    renderWithProviders(<SettlementBanner period="2026-03" />);
    await openWorking();
    expect(await screen.findByTestId('settlement-working')).toHaveTextContent('Nothing earlier on record');
  });

  it('refuses more than two decimal places rather than rounding them away', async () => {
    const user = userEvent.setup();
    const { calls } = serve(settlement());
    renderWithProviders(<SettlementBanner period="2026-03" />);
    await user.click(await screen.findByRole('button', { name: 'Record a payment' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Amount'), '10.005');
    await user.click(within(dialog).getByRole('button', { name: 'Record payment' }));
    expect(within(dialog).getByText('Use at most two decimal places.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('checks the payment form inline before sending anything', async () => {
    const user = userEvent.setup();
    const { calls } = serve(settlement());
    renderWithProviders(<SettlementBanner period="2026-03" />);
    await user.click(await screen.findByRole('button', { name: 'Record a payment' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Record payment' }));
    const amount = within(dialog).getByLabelText('Amount');
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    expect(amount).toHaveFocus();
    expect(within(dialog).getByText('Enter an amount above zero.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('warns, without blocking, when the ledger already has the same payment within a week', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') return jsonResponse(running());
      if (method === 'POST' && url === '/api/settlement/entries') return jsonResponse({ ...manualPayment, amount: '100.00' }, 201);
      return undefined;
    });
    renderWithProviders(<SettlementBanner period="2026-03" />);
    await user.click(await screen.findByRole('button', { name: 'Record a payment' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-03-22' } });
    await user.type(within(dialog).getByLabelText('Amount'), '100');

    expect(within(dialog).getByRole('note')).toHaveTextContent(
      'The ledger already has an approved settlement payment of £100.00 on 18 Mar 2026 (HSBC Premier ··4471)',
    );
    expect(within(dialog).getByRole('note')).toHaveTextContent('count it twice');
    // The other direction is a different payment.
    await user.click(within(dialog).getByLabelText('Alex paid Sam'));
    expect(within(dialog).queryByRole('note')).not.toBeInTheDocument();
    await user.click(within(dialog).getByLabelText('Sam paid Alex'));

    await user.click(within(dialog).getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  });

  it('shows a refused payment inside the dialog', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') return jsonResponse(settlement());
      if (method === 'POST') return jsonResponse({ detail: 'Period 2026-03 is closed.' }, 409);
      return undefined;
    });
    renderWithProviders(<SettlementBanner period="2026-03" />);
    await user.click(await screen.findByRole('button', { name: 'Record a payment' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Amount'), '10');
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-03-20' } });
    await user.click(within(dialog).getByRole('button', { name: 'Record payment' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Period 2026-03 is closed.');
  });

  it('sets the balance with the "Settled up" shortcut at the end of the month', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') return jsonResponse(settlement());
      if (method === 'POST' && url === '/api/settlement/entries') return jsonResponse({ ...checkpoint, kind: 'checkpoint' }, 201);
      return undefined;
    });
    renderWithProviders(<SettlementBanner period="2026-03" onChanged={onChanged} />);
    await user.click(await screen.findByRole('button', { name: 'Set the balance' }));
    const dialog = screen.getByRole('dialog', { name: 'Set the balance' });
    expect(dialog).toHaveAccessibleDescription('As at the end of March 2026, who owes whom and how much?');
    expect(dialog).toHaveTextContent('months before it become history and are not carried forward');
    await user.click(within(dialog).getByLabelText('Settled up (£0.00)'));
    expect(within(dialog).queryByLabelText('Amount')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Set the balance' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      kind: 'checkpoint',
      entry_date: '2026-03-31',
      amount: '0.00',
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Balance at the end of March 2026 set: Settled up.');
    // The parent refreshes; the card does not refetch on its own.
    expect(calls.filter((c) => c.method === 'GET').length).toBe(1);
  });

  it('sets a balance owed the other way as a negative amount', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') return jsonResponse(settlement());
      if (method === 'POST') return jsonResponse({ ...checkpoint, kind: 'checkpoint' }, 201);
      return undefined;
    });
    renderWithProviders(<SettlementBanner period="2026-03" />);
    await user.click(await screen.findByRole('button', { name: 'Set the balance' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByLabelText('Alex owes Sam'));
    await user.type(within(dialog).getByLabelText('Amount'), '25.5');
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Agreed');
    await user.click(within(dialog).getByRole('button', { name: 'Set the balance' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      kind: 'checkpoint',
      entry_date: '2026-03-31',
      amount: '-25.50',
      note: 'Agreed',
    });
  });

  it('shows a set balance as a chip and edits it by posting it again', async () => {
    const user = userEvent.setup();
    const withCheckpoint = settlement({
      balance: settlementBalance({ carried_in: '0.00', balance_out: '300.00', checkpoint }),
      entries: [
        { ...checkpoint, period_key: '2026-03', kind: 'checkpoint', paid_by: null, created_by: 'user_primary', created_at: '2026-04-02T10:00:00Z' },
      ],
    });
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') return jsonResponse(withCheckpoint);
      if (method === 'POST' && url === '/api/settlement/entries') return jsonResponse({ ...checkpoint, amount: '250.00' }, 201);
      return undefined;
    });
    renderWithProviders(<SettlementBanner period="2026-03" />);

    expect(await screen.findByText('Balance set on 31 Mar 2026')).toBeInTheDocument();
    await openWorking();
    expect(screen.getByTestId('settlement-outstanding')).toHaveTextContent(
      'Balance set on 31 Mar 2026: £300.00 owed by Sam (Agreed over dinner)',
    );
    expect(screen.getByTestId('settlement-working-line')).toHaveTextContent('Balance set on 31 Mar 2026: £300.00 owed by Sam');
    expect(screen.getByTestId('settlement-working')).toHaveTextContent('Not used: the balance set for this month replaces it');
    // The checkpoint is not a payment or an adjustment.
    expect(screen.queryByTestId('settlement-adjustments')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Set the balance' }));
    const dialog = screen.getByRole('dialog', { name: 'Change the balance' });
    expect(within(dialog).getByLabelText('Sam owes Alex')).toBeChecked();
    const amount = within(dialog).getByLabelText('Amount');
    expect(amount).toHaveValue('300.00');
    expect(within(dialog).getByLabelText('Note (optional)')).toHaveValue('Agreed over dinner');
    await user.clear(amount);
    await user.type(amount, '250');
    await user.click(within(dialog).getByRole('button', { name: 'Save the balance' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const writes = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url}`);
    // Posting a checkpoint replaces the month's one; nothing is deleted first.
    expect(writes).toEqual(['POST /api/settlement/entries']);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      kind: 'checkpoint',
      entry_date: '2026-03-31',
      amount: '250.00',
      note: 'Agreed over dinner',
    });
  });

  it('removes a set balance after confirmation', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') {
        return jsonResponse(settlement({ balance: settlementBalance({ balance_out: '300.00', checkpoint }) }));
      }
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return undefined;
    });
    renderWithProviders(<SettlementBanner period="2026-03" />);
    await user.click(await screen.findByRole('button', { name: 'Set the balance' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove it' }));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([`/api/settlement/entries/${checkpoint.id}`]);
    expect(await screen.findByRole('status')).toHaveTextContent('The balance set for March 2026 was removed.');
  });

  it('warns when lines were approved after the balance was set, and offers to set it again', async () => {
    const user = userEvent.setup();
    serve(settlement({ balance: settlementBalance({ balance_out: '300.00', checkpoint: { ...checkpoint, drift: '20.00', drifted: true } }) }));
    renderWithProviders(<SettlementBanner period="2026-03" />);

    expect(
      await screen.findByText('£20.00 approved in March 2026 since the balance was set (in Alex’s favour).'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set it again' }));
    const dialog = screen.getByRole('dialog', { name: 'Change the balance' });
    expect(within(dialog).getByLabelText('Amount')).toHaveValue('320.00');
  });

  it('labels a month before a later set balance as history', async () => {
    serve(settlement({ balance: settlementBalance({ before_checkpoint: true }) }));
    renderWithProviders(<SettlementBanner period="2026-03" />);

    expect(await screen.findByTestId('settlement-headline')).toHaveTextContent('Sam owes Alex £45.90');
    expect(screen.getByTestId('settlement-headline-label')).toHaveTextContent(
      'At the end of March 2026, before the balance was set',
    );
    expect(screen.getByText(/Before the balance was set in a later month: March 2026 is history, not carried forward/)).toBeInTheDocument();
  });

  it('names the month whose set balance made this one history, and where carried-in starts', async () => {
    serve(
      settlement({
        balance: settlementBalance({ before_checkpoint: true, later_checkpoint_period: '2026-05' }),
      }),
    );
    renderWithProviders(<SettlementBanner period="2026-03" />);
    expect(
      await screen.findByText('The balance was set in May 2026, so March 2026 is history, not carried forward.'),
    ).toBeInTheDocument();
  });

  it('says the carried-in figure starts from an earlier set balance', async () => {
    const user = userEvent.setup();
    serve(
      settlement({
        balance: settlementBalance({
          from_period: '2026-01',
          anchored_on: { period_key: '2026-01', entry_date: '2026-01-31', amount: '0.00' },
        }),
      }),
    );
    renderWithProviders(<SettlementBanner period="2026-03" />);
    await screen.findByTestId('settlement-headline');
    const toggle = screen.queryByRole('button', { name: /Show the working|working/i });
    if (toggle) await user.click(toggle);
    expect(await screen.findByText('From the balance set on 31 Jan 2026')).toBeInTheDocument();
  });

  it('deletes a payment recorded by hand after confirmation', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settlement/2026-03') {
        return jsonResponse(
          settlement({ balance: settlementBalance({ payments_manual: '50.00', balance_out: '-4.10' }), entries: [manualPayment] }),
        );
      }
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return undefined;
    });
    renderWithProviders(<SettlementBanner period="2026-03" />);
    await openWorking();

    await user.click(await screen.findByRole('button', { name: 'Delete the payment of £50.00 on 10 Mar 2026' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'DELETE')?.url).toBe(`/api/settlement/entries/${manualPayment.id}`),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Payment removed.');
  });

  it('hides the actions and the deletes from the partner', async () => {
    serve(running({ entries: [manualPayment, adjustment] }));
    renderWithProviders(<SettlementBanner period="2026-03" />, { session: secondarySession });

    await screen.findByTestId('settlement-headline');
    await openWorking();
    expect(screen.getByTestId('settlement-payments')).toHaveTextContent('Cash for the plumber');
    expect(screen.queryByRole('button', { name: 'Record a payment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set the balance' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
  });
});
