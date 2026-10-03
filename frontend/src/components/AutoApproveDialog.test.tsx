import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AutoApproveResponse } from '../api';
import { ID_OCADO, ID_UBER, transaction } from '../test/fixtures';
import { fixtureConfig, jsonResponse, mockFetch, renderWithProviders } from '../test/utils';
import { ApprovalQueue } from './ApprovalQueue';
import { AutoApproveDialog } from './AutoApproveDialog';

const monthPreview: AutoApproveResponse = {
  approved: 2,
  considered: 5,
  skipped: { new_merchant: 2, mixed_history: 1 },
  items: [
    { id: ID_OCADO, cleaned_merchant: 'Ocado', amount: '-64.00', category: 'Groceries', claim_type: 'shared_proportional' },
    { id: ID_UBER, cleaned_merchant: 'Iron Works Gym', amount: '-40.00', category: 'Health:Gym', claim_type: 'personal' },
  ],
};

const allPreview: AutoApproveResponse = {
  approved: 812,
  considered: 1205,
  skipped: { new_merchant: 330, mixed_history: 51, unusual_amount: 9, other_sign: 3 },
  items: [],
};

const config = { ...fixtureConfig, category_emojis: { Health: '🩺', Groceries: '🛒' } };

function body(call: { body: unknown }) {
  return call.body as { period: string | null; dry_run: boolean };
}

describe('<AutoApproveDialog />', () => {
  it('shows the dry run for this month with what stays, and lists the lines on request', async () => {
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'POST' && url === '/api/transactions/auto-approve') return jsonResponse(monthPreview);
      return undefined;
    });
    const user = userEvent.setup();
    renderWithProviders(<AutoApproveDialog period="2026-08" onClose={() => {}} onApproved={() => {}} />, { config });

    expect(await screen.findByText('2 lines from merchants you know can be approved')).toBeInTheDocument();
    expect(body(calls[0])).toEqual({ period: '2026-08', dry_run: true });
    expect(screen.getByText(/New merchants 2 · Filed different ways 1/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'This month' })).toBeChecked();

    const toggle = screen.getByRole('button', { name: 'Show the 2 lines' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list', { name: 'Lines to approve' })).not.toBeInTheDocument();
    await user.click(toggle);
    const list = screen.getByRole('list', { name: 'Lines to approve' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveTextContent('Iron Works Gym');
    expect(items[1]).toHaveTextContent('£40.00');
    expect(items[1]).toHaveTextContent('🩺 Health › Gym · Personal (not shared)');
    expect(items[0]).toHaveTextContent('🛒 Groceries · Split by income');
    expect(screen.getByRole('button', { name: 'Hide the lines' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('asks again for every month when the scope changes', async () => {
    const { calls } = mockFetch(({ method, url, body: sent }) => {
      if (method !== 'POST' || url !== '/api/transactions/auto-approve') return undefined;
      return jsonResponse((sent as { period: string | null }).period ? monthPreview : allPreview);
    });
    const user = userEvent.setup();
    renderWithProviders(<AutoApproveDialog period="2026-08" onClose={() => {}} onApproved={() => {}} />, { config });
    await screen.findByText('2 lines from merchants you know can be approved');

    await user.click(screen.getByRole('radio', { name: 'All months with lines waiting' }));
    expect(await screen.findByText('812 lines from merchants you know can be approved')).toBeInTheDocument();
    expect(body(calls[1])).toEqual({ period: null, dry_run: true });
    expect(screen.getByText(/New merchants 330 · Filed different ways 51 · Unusual amount 9 · Other sign 3/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve 812 lines' })).toBeEnabled();
  });

  it('runs for the chosen scope on confirm and hands back the result', async () => {
    const done = { ...monthPreview };
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'POST' && url === '/api/transactions/auto-approve') return jsonResponse(done);
      return undefined;
    });
    const onApproved = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<AutoApproveDialog period="2026-08" onClose={() => {}} onApproved={onApproved} />, { config });
    await user.click(await screen.findByRole('button', { name: 'Approve 2 lines' }));
    await waitFor(() => expect(onApproved).toHaveBeenCalledWith(done));
    expect(body(calls[1])).toEqual({ period: '2026-08', dry_run: false });
  });

  it('shows errors inline: a failed preview can be retried, a failed run keeps the dialog open', async () => {
    let previewFails = true;
    mockFetch(({ method, url, body: sent }) => {
      if (method !== 'POST' || url !== '/api/transactions/auto-approve') return undefined;
      if ((sent as { dry_run: boolean }).dry_run) {
        return previewFails ? jsonResponse({ detail: 'database unavailable' }, 503) : jsonResponse(monthPreview);
      }
      return jsonResponse({ detail: 'period 2026-08 is closed; reopen it first' }, 409);
    });
    const onApproved = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<AutoApproveDialog period="2026-08" onClose={() => {}} onApproved={onApproved} />, { config });

    const alert = await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    previewFails = false;
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    await user.click(await screen.findByRole('button', { name: 'Approve 2 lines' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/closed/i);
    expect(onApproved).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('<ApprovalQueue /> approve known merchants', () => {
  it('opens the dialog from the header, then announces the result and loads the queue again', async () => {
    let listed = 0;
    const onChanged = vi.fn();
    mockFetch(({ method, url, body: sent }) => {
      if (method === 'GET' && url.startsWith('/api/transactions?')) {
        listed += 1;
        const rows = listed === 1 ? [transaction({ id: ID_OCADO, cleaned_merchant: 'Ocado' })] : [];
        return jsonResponse({ items: rows, total: rows.length });
      }
      if (method === 'POST' && url === '/api/transactions/auto-approve') {
        return jsonResponse((sent as { dry_run: boolean }).dry_run ? monthPreview : { ...monthPreview });
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderWithProviders(<ApprovalQueue period="2026-08" onChanged={onChanged} />, { config });

    await user.click(await screen.findByRole('button', { name: 'Approve known merchants' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve known merchants' });
    await user.click(await within(dialog).findByRole('button', { name: 'Approve 2 lines' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('2 lines from merchants you know were approved')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
    expect(await screen.findByText('Nothing to review. All caught up.')).toBeInTheDocument();
    expect(listed).toBe(2);
  });
});
