import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ClaimOut } from '../api';
import { FUTURE_DATE_MESSAGE } from '../lib/claims';
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

  it('submits the expected body for a secondary session', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'POST' && url === '/api/claims') return jsonResponse(created, 201);
      return undefined;
    });

    renderWithProviders(<ClaimForm onCreated={onCreated} />, { session: secondarySession });

    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-03-05' } });
    await user.type(screen.getByLabelText(/Amount/), '12.5');
    await user.type(screen.getByLabelText('Merchant or description'), 'Tesco');
    await user.click(screen.getByRole('radio', { name: /50\/50/ }));
    await user.click(screen.getByRole('button', { name: 'Log claim' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/claims');
    expect(post?.headers.Authorization).toBe('Bearer secondary-token');
    expect(post?.body).toEqual({
      claim_date: '2026-03-05',
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

    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-03-05' } });
    await user.type(screen.getByLabelText(/Amount/), '£40');
    await user.type(screen.getByLabelText('Merchant or description'), 'Boots');
    await user.type(screen.getByLabelText(/Notes/), 'Prescription');
    await user.click(screen.getByRole('radio', { name: /Sam's personal item/ }));
    await user.click(screen.getByRole('button', { name: 'Log claim' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      claim_date: '2026-03-05',
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
    fireEvent.change(date, { target: { value: '2026-03-05' } });
    expect(screen.queryByText(FUTURE_DATE_MESSAGE)).not.toBeInTheDocument();
  });

  it('turns a 409 from a closed period into a plain sentence', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'POST' && url === '/api/claims') return jsonResponse({ detail: 'period 2026-03 is closed' }, 409);
      return undefined;
    });
    renderWithProviders(<ClaimForm onCreated={() => {}} />, { session: secondarySession });

    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-03-05' } });
    await user.type(screen.getByLabelText(/Amount/), '5');
    await user.type(screen.getByLabelText('Merchant or description'), 'Tesco');
    await user.click(screen.getByRole('button', { name: 'Log claim' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This period is closed, so it can no longer be edited.');
  });
});
