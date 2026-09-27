import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ClaimOut } from '../api';
import { FUTURE_DATE_MESSAGE, TOO_OLD_DATE_MESSAGE, earliestClaimDate } from '../lib/claims';
import { todayIso } from '../lib/dates';
import { jsonResponse, mockFetch, renderWithProviders, secondarySession } from '../test/utils';
import { ClaimForm } from './ClaimForm';

const created: ClaimOut = {
  id: 'c0ffee00-1234-4abc-9def-000000000010',
  period_key: '2026-03',
  claim_date: '2026-03-05',
  paid_by: 'user_secondary',
  merchant: 'Tesco',
  description: null,
  amount: '12.50',
  claim_type: 'shared_equal',
  primary_owes: '6.25',
  secondary_owes: '6.25',
  is_settled: false,
  created_at: '2026-03-05T12:00:00Z',
};

/** A date well inside the 12-month window whatever today is. */
function recentDate(): string {
  return todayIso(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
}

describe('<ClaimForm />', () => {
  it('shows the split options using display names from config, never hard-coded names', () => {
    mockFetch(() => undefined);
    renderWithProviders(<ClaimForm onCreated={() => {}} />, { session: secondarySession });

    expect(screen.getByRole('radio', { name: /Split by income/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /50\/50/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Alex's personal item/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Sam's personal item/ })).toBeInTheDocument();
    // A secondary session cannot choose who paid.
    expect(screen.queryByLabelText('Paid by')).not.toBeInTheDocument();
  });

  it('limits the date picker to the last 12 months up to today', () => {
    mockFetch(() => undefined);
    renderWithProviders(<ClaimForm onCreated={() => {}} />, { session: secondarySession });

    const date = screen.getByLabelText('Date');
    expect(date).toHaveAttribute('max', todayIso());
    expect(date).toHaveAttribute('min', earliestClaimDate());
  });

  it('submits the expected body for a secondary session', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'POST' && url === '/api/claims') return jsonResponse(created, 201);
      return undefined;
    });

    renderWithProviders(<ClaimForm onCreated={onCreated} />, { session: secondarySession });

    fireEvent.change(screen.getByLabelText('Date'), { target: { value: recentDate() } });
    await user.type(screen.getByLabelText(/Amount/), '12.5');
    await user.type(screen.getByLabelText('Merchant or description'), 'Tesco');
    await user.click(screen.getByRole('radio', { name: /50\/50/ }));
    await user.click(screen.getByRole('button', { name: 'Log claim' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/claims');
    expect(post?.headers.Authorization).toBe('Bearer secondary-token');
    expect(post?.body).toEqual({
      claim_date: recentDate(),
      amount: '12.50',
      merchant: 'Tesco',
      claim_type: 'shared_equal',
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Logged £12.50 at Tesco.');
  });

  it('includes notes and paid_by when the primary user logs on the partner’s behalf', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'POST' && url === '/api/claims') return jsonResponse(created, 201);
      return undefined;
    });

    renderWithProviders(<ClaimForm onCreated={() => {}} />);

    fireEvent.change(screen.getByLabelText('Date'), { target: { value: recentDate() } });
    await user.type(screen.getByLabelText(/Amount/), '£40');
    await user.type(screen.getByLabelText('Merchant or description'), 'Boots');
    await user.type(screen.getByLabelText(/Notes/), 'Prescription');
    await user.click(screen.getByRole('radio', { name: /Sam's personal item/ }));
    await user.click(screen.getByRole('button', { name: 'Log claim' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      claim_date: recentDate(),
      amount: '40.00',
      merchant: 'Boots',
      description: 'Prescription',
      claim_type: 'secondary_personal',
      paid_by: 'user_secondary',
    });
  });

  it('validates the amount before calling the API', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(() => undefined);
    renderWithProviders(<ClaimForm onCreated={() => {}} />, { session: secondarySession });

    await user.type(screen.getByLabelText('Merchant or description'), 'Tesco');
    await user.click(screen.getByRole('button', { name: 'Log claim' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter an amount greater than zero.');
    expect(calls).toHaveLength(0);
  });

  it('asks before logging an amount above £1,000 and only posts once confirmed', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'POST' && url === '/api/claims') return jsonResponse({ ...created, amount: '99999999.00' }, 201);
      return undefined;
    });
    renderWithProviders(<ClaimForm onCreated={() => {}} />, { session: secondarySession });

    fireEvent.change(screen.getByLabelText('Date'), { target: { value: recentDate() } });
    await user.type(screen.getByLabelText(/Amount/), '99999999');
    await user.type(screen.getByLabelText('Merchant or description'), 'Kitchen');
    await user.click(screen.getByRole('button', { name: 'Log claim' }));

    const prompt = await screen.findByRole('group', { name: 'That is £99,999,999.00. Log it?' });
    expect(prompt).toHaveTextContent('That is £99,999,999.00. Log it?');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Log claim' })).not.toBeInTheDocument();

    // Cancel brings the form back untouched, still without a request.
    await user.click(within(prompt).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Log claim' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Amount/)).toHaveValue('99999999');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Log claim' }));
    await user.click(within(await screen.findByRole('group', { name: /Log it\?/ })).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ amount: '99999999.00', merchant: 'Kitchen' });
    expect(await screen.findByRole('status')).toHaveTextContent('Logged £99,999,999.00 at Kitchen.');
    expect(screen.getByRole('button', { name: 'Log claim' })).toBeInTheDocument();
  });

  it('withdraws the question when the amount is edited, and never asks at £1,000 or below', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'POST' && url === '/api/claims') return jsonResponse(created, 201);
      return undefined;
    });
    renderWithProviders(<ClaimForm onCreated={() => {}} />, { session: secondarySession });

    fireEvent.change(screen.getByLabelText('Date'), { target: { value: recentDate() } });
    await user.type(screen.getByLabelText(/Amount/), '1500');
    await user.type(screen.getByLabelText('Merchant or description'), 'Sofa');
    await user.click(screen.getByRole('button', { name: 'Log claim' }));
    await screen.findByRole('group', { name: 'That is £1,500.00. Log it?' });

    await user.clear(screen.getByLabelText(/Amount/));
    await user.type(screen.getByLabelText(/Amount/), '1000');
    expect(screen.queryByRole('group', { name: /Log it\?/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Log claim' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ amount: '1000.00' });
  });

  it('rejects a claim date in the future inline and never calls the API', async () => {
    const user = userEvent.setup();
    const onDateChange = vi.fn();
    const { calls } = mockFetch(() => undefined);
    renderWithProviders(<ClaimForm onCreated={() => {}} onDateChange={onDateChange} />, {
      session: secondarySession,
    });

    const date = screen.getByLabelText('Date');
    fireEvent.change(date, { target: { value: '2999-01-01' } });
    // The message appears as soon as the date is chosen, not only after submit.
    expect(screen.getByText(FUTURE_DATE_MESSAGE)).toBeInTheDocument();
    expect(date).toHaveAttribute('aria-invalid', 'true');
    expect(onDateChange).toHaveBeenCalledWith('2999-01-01');

    await user.type(screen.getByLabelText(/Amount/), '5');
    await user.type(screen.getByLabelText('Merchant or description'), 'Tesco');
    await user.click(screen.getByRole('button', { name: 'Log claim' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(FUTURE_DATE_MESSAGE);
    expect(calls).toHaveLength(0);

    // Correcting the date clears the inline message.
    fireEvent.change(date, { target: { value: recentDate() } });
    expect(screen.queryByText(FUTURE_DATE_MESSAGE)).not.toBeInTheDocument();
  });

  it('rejects a claim date more than 12 months ago inline and never calls the API', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(() => undefined);
    renderWithProviders(<ClaimForm onCreated={() => {}} />, { session: secondarySession });

    const date = screen.getByLabelText('Date');
    fireEvent.change(date, { target: { value: '2020-01-15' } });
    expect(screen.getByText(TOO_OLD_DATE_MESSAGE)).toBeInTheDocument();
    expect(date).toHaveAttribute('aria-invalid', 'true');

    await user.type(screen.getByLabelText(/Amount/), '5');
    await user.type(screen.getByLabelText('Merchant or description'), 'Tesco');
    await user.click(screen.getByRole('button', { name: 'Log claim' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(TOO_OLD_DATE_MESSAGE);
    expect(calls).toHaveLength(0);
  });

  it('surfaces the server’s 422 for a date it refuses, beside the date as well as in the form', async () => {
    const user = userEvent.setup();
    const detail = 'claim_date cannot be more than 12 months in the past';
    mockFetch(({ method, url }) => {
      if (method === 'POST' && url === '/api/claims') return jsonResponse({ detail }, 422);
      return undefined;
    });
    renderWithProviders(<ClaimForm onCreated={() => {}} />, { session: secondarySession });

    fireEvent.change(screen.getByLabelText('Date'), { target: { value: recentDate() } });
    await user.type(screen.getByLabelText(/Amount/), '5');
    await user.type(screen.getByLabelText('Merchant or description'), 'Tesco');
    await user.click(screen.getByRole('button', { name: 'Log claim' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(detail);
    expect(screen.getByLabelText('Date')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Date')).toHaveAccessibleDescription(detail);
    expect(screen.getByRole('button', { name: 'Log claim' })).toBeEnabled();
  });

  it('turns a 409 from a closed period into a plain sentence', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'POST' && url === '/api/claims') return jsonResponse({ detail: 'period 2026-03 is closed' }, 409);
      return undefined;
    });
    renderWithProviders(<ClaimForm onCreated={() => {}} />, { session: secondarySession });

    fireEvent.change(screen.getByLabelText('Date'), { target: { value: recentDate() } });
    await user.type(screen.getByLabelText(/Amount/), '5');
    await user.type(screen.getByLabelText('Merchant or description'), 'Tesco');
    await user.click(screen.getByRole('button', { name: 'Log claim' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This period is closed, so it can no longer be edited.');
  });
});
