import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ApplyRulesBody, ApplyRulesResponse, RulesOut } from '../api';
import { ReviewBadgeContext } from '../hooks/reviewBadge';
import { NOTHING_TO_APPLY_MESSAGE } from '../lib/rules';
import { ID_OCADO, ID_UBER, rules } from '../test/fixtures';
import { fixtureConfig, jsonResponse, mockFetch, renderWithProviders } from '../test/utils';
import { ApplyRulesDialog } from './ApplyRulesDialog';
import { APPLY_BUTTON, RulesPanel } from './RulesPanel';

const APPLY_URL = '/api/settings/rules/apply';

const preview: ApplyRulesResponse = {
  matched: 2,
  changed: 1,
  approved: 2,
  unchanged: 1,
  items: [
    {
      id: ID_UBER,
      cleaned_merchant: 'TFL',
      amount: '-2.80',
      before: { category: 'Dining', claim_type: 'shared_equal' },
      after: { category: 'Transport:Public', claim_type: 'personal' },
      changed: true,
      rule_index: 2,
    },
    {
      id: ID_OCADO,
      cleaned_merchant: 'TFL',
      amount: '-3.10',
      before: { category: 'Transport:Public', claim_type: 'personal' },
      after: { category: 'Transport:Public', claim_type: 'personal' },
      changed: false,
      rule_index: 2,
    },
  ],
};

const nothing: ApplyRulesResponse = { matched: 0, changed: 0, approved: 0, unchanged: 0, items: [] };

const config = { ...fixtureConfig, category_emojis: { Transport: '🚇' } };

function sent(call: { body: unknown }): ApplyRulesBody {
  return call.body as ApplyRulesBody;
}

describe('<ApplyRulesDialog />', () => {
  it('shows the dry run and lists each line before and after on request', async () => {
    const { calls } = mockFetch(({ method, url }) => (method === 'POST' && url === APPLY_URL ? jsonResponse(preview) : undefined));
    const user = userEvent.setup();
    renderWithProviders(<ApplyRulesDialog onClose={() => {}} onApplied={() => {}} />, { config });

    expect(await screen.findByText('2 waiting lines match your rules; 1 would change (2 approved).')).toBeInTheDocument();
    expect(sent(calls[0])).toEqual({ dry_run: true, period: null });

    const toggle = screen.getByRole('button', { name: 'Show the 2 lines' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    const items = within(screen.getByRole('list', { name: 'Lines the rules match' })).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('£2.80');
    expect(items[0]).toHaveTextContent('Dining · 50/50');
    expect(items[0]).toHaveTextContent('becomes🚇 Transport › Public · Personal (not shared)');
    expect(items[1]).toHaveTextContent('already filed this way');
    expect(screen.getByRole('button', { name: 'Apply to 2 lines' })).toBeEnabled();
  });

  it('applies on confirm and hands back the result', async () => {
    const { calls } = mockFetch(({ method, url }) => (method === 'POST' && url === APPLY_URL ? jsonResponse(preview) : undefined));
    const onApplied = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ApplyRulesDialog onClose={() => {}} onApplied={onApplied} />, { config });

    await user.click(await screen.findByRole('button', { name: 'Apply to 2 lines' }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(preview));
    expect(calls.map(sent)).toEqual([
      { dry_run: true, period: null },
      { dry_run: false, period: null },
    ]);
  });

  it('says so when nothing would change and offers no confirm', async () => {
    mockFetch(({ method, url }) => (method === 'POST' && url === APPLY_URL ? jsonResponse(nothing) : undefined));
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ApplyRulesDialog unsaved onClose={onClose} onApplied={() => {}} />, { config });

    expect(await screen.findByText(NOTHING_TO_APPLY_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText(/Unsaved edits on the Rules tab are not included/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Apply/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show the/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('<RulesPanel /> apply to waiting lines', () => {
  it('offers the run after a save, applies it, announces the result and refreshes the Review badge', async () => {
    let current: RulesOut = rules();
    let applied = false;
    mockFetch(({ method, url, body }) => {
      if (method === 'GET' && url === '/api/settings/rules') return jsonResponse(current);
      if (method === 'PUT' && url === '/api/settings/rules') {
        current = { ...current, ...(body as Partial<RulesOut>), stored: true };
        return jsonResponse(current);
      }
      if (method === 'POST' && url === APPLY_URL) {
        if (!(body as ApplyRulesBody).dry_run) applied = true;
        return jsonResponse(preview);
      }
      return undefined;
    });
    const refresh = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <ReviewBadgeContext.Provider value={{ share: () => {}, refresh }}>
        <RulesPanel />
      </ReviewBadgeContext.Provider>,
    );
    await screen.findByLabelText('Pattern for rule 1');
    expect(screen.getByRole('button', { name: APPLY_BUTTON })).toBeEnabled();

    await user.clear(screen.getByLabelText('Match window'));
    await user.type(screen.getByLabelText('Match window'), '10');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const status = await screen.findByRole('status');
    await waitFor(() => expect(status).toHaveTextContent('2 lines already waiting for review match them'));
    await user.click(within(status).getByRole('button', { name: 'Review and apply' }));
    await user.click(await screen.findByRole('button', { name: 'Apply to 2 lines' }));

    expect(await screen.findByText('Rules applied: 2 waiting lines approved, 1 refiled.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(applied).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole('status')).queryByRole('button', { name: 'Review and apply' })).not.toBeInTheDocument();
  });
});
