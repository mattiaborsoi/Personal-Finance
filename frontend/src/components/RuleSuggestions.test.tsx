import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { RuleSuggestion, RulesOut, RulesUpdate } from '../api';
import { rule, rules } from '../test/fixtures';
import { jsonResponse, mockFetch, renderWithProviders, type RecordedCall } from '../test/utils';
import { RulesPanel } from './RulesPanel';
import { RuleSuggestions, SUGGESTIONS_TITLE } from './RuleSuggestions';

const URL = '/api/settings/rules';
const SUGGEST_URL = `${URL}/suggestions`;
const DISMISS_URL = `${SUGGEST_URL}/dismiss`;

function suggestion(overrides: Partial<RuleSuggestion> = {}): RuleSuggestion {
  return {
    key: 'fixed:THIRD SPACE:40.00:Health:Gym:personal',
    kind: 'fixed_amount',
    text: 'Third Space, £40.00, filed as Health:Gym 3 times: make it a rule?',
    merchant: 'Third Space',
    category: 'Health:Gym',
    claim_type: 'personal',
    count: 3,
    amount: '40.00',
    rule: rule({ pattern: '(?i)THIRD\\s*SPACE', category: 'Health:Gym', claim_type: 'personal', amount_min: '40.00', amount_max: '40.00' }),
    rule_index: null,
    action: 'add',
    examples: ['THIRD SPACE 0012 LONDON'],
    ...overrides,
  };
}

/** GET /rules answers the document, PUT stores it, the suggestions come from `items`, dismiss records the key. */
function mockAll(initial: RulesOut, items: RuleSuggestion[]) {
  let current = initial;
  const dismissed: string[] = [];
  const { calls } = mockFetch(({ method, url, body }) => {
    if (method === 'GET' && url === URL) return jsonResponse(current);
    if (method === 'PUT' && url === URL) {
      current = { ...current, ...(body as RulesUpdate), stored: true };
      return jsonResponse(current);
    }
    if (method === 'GET' && url === SUGGEST_URL) return jsonResponse({ suggestions: items });
    if (method === 'POST' && url === DISMISS_URL) {
      dismissed.push((body as { key: string }).key);
      return new Response(null, { status: 204 });
    }
    return undefined;
  });
  return { calls, dismissed, current: () => current };
}

function puts(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === 'PUT' && c.url === URL);
}

describe('<RuleSuggestions />', () => {
  it('renders nothing when there is nothing to suggest, or the request fails', async () => {
    mockFetch(({ method, url }) => (method === 'GET' && url === SUGGEST_URL ? jsonResponse({ suggestions: [] }) : undefined));
    renderWithProviders(<RuleSuggestions refreshKey={0} onAccept={async () => {}} />);
    await waitFor(() => expect(screen.queryByRole('region', { name: SUGGESTIONS_TITLE })).not.toBeInTheDocument());
    mockFetch(() => undefined);
    renderWithProviders(<RuleSuggestions refreshKey={1} onAccept={async () => {}} />);
    await waitFor(() => expect(screen.queryByRole('region', { name: SUGGESTIONS_TITLE })).not.toBeInTheDocument());
  });

  it('lists each suggestion with its sentence, its pattern and Accept / Dismiss', async () => {
    const user = userEvent.setup();
    const { dismissed } = mockAll(rules(), [
      suggestion(),
      suggestion({
        key: 'override:(?i)AQUANORTH\\s*WATER:Housing:ServiceCharges:shared_proportional:remove',
        kind: 'override',
        text: 'Rule 1 matched Aquanorth Water but you filed it as Housing:ServiceCharges every time (3): remove the rule?',
        merchant: 'Aquanorth Water',
        category: 'Housing:ServiceCharges',
        rule_index: 0,
        action: 'remove',
        examples: ['AQUANORTH WATER'],
      }),
    ]);
    const accepted: RuleSuggestion[] = [];
    renderWithProviders(<RuleSuggestions refreshKey={0} onAccept={async (s) => void accepted.push(s)} />);

    const card = await screen.findByRole('region', { name: SUGGESTIONS_TITLE });
    const items = within(card).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Third Space, £40.00, filed as Health:Gym 3 times: make it a rule?');
    expect(items[0]).toHaveTextContent('3 approved lines · pattern (?i)THIRD\\s*SPACE · e.g. THIRD SPACE 0012 LONDON');
    expect(within(items[0]).getByRole('button', { name: /^Accept:/ })).toHaveTextContent('Add the rule');
    expect(within(items[1]).getByRole('button', { name: /^Accept:/ })).toHaveTextContent('Remove the rule');

    await user.click(within(items[0]).getByRole('button', { name: /^Accept:/ }));
    expect(accepted.map((s) => s.key)).toEqual([suggestion().key]);
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(1));

    await user.click(within(card).getByRole('button', { name: /^Dismiss:/ }));
    await waitFor(() => expect(screen.queryByRole('region', { name: SUGGESTIONS_TITLE })).not.toBeInTheDocument());
    expect(dismissed).toEqual(['override:(?i)AQUANORTH\\s*WATER:Housing:ServiceCharges:shared_proportional:remove']);
  });
});

describe('<RulesPanel /> with suggestions', () => {
  it('accepting adds the rule and saves the list through the rules API', async () => {
    const user = userEvent.setup();
    const { calls, current } = mockAll(rules(), [suggestion()]);
    renderWithProviders(<RulesPanel />);
    await screen.findByLabelText('Pattern for rule 1');
    const card = await screen.findByRole('region', { name: SUGGESTIONS_TITLE });

    await user.click(within(card).getByRole('button', { name: /^Accept:/ }));

    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    const body = puts(calls)[0].body as RulesUpdate;
    expect(body.rules).toHaveLength(rules().rules.length + 1);
    expect(body.rules?.[body.rules.length - 1]).toMatchObject({ pattern: '(?i)THIRD\\s*SPACE', category: 'Health:Gym', amount_min: '40.00', amount_max: '40.00' });
    expect(current().rules[current().rules.length - 1].pattern).toBe('(?i)THIRD\\s*SPACE');
    expect(await screen.findByLabelText(`Pattern for rule ${rules().rules.length + 1}`)).toHaveValue('(?i)THIRD\\s*SPACE');
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
  });

  it('accepting a removal drops that rule and saves', async () => {
    const user = userEvent.setup();
    const { calls } = mockAll(
      rules(),
      [suggestion({ key: 'override:x', kind: 'override', action: 'remove', rule_index: 0, text: 'Rule 1 is always overridden: remove the rule?' })],
    );
    renderWithProviders(<RulesPanel />);
    await screen.findByLabelText('Pattern for rule 1');
    await user.click(await screen.findByRole('button', { name: /^Accept:/ }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    const body = puts(calls)[0].body as RulesUpdate;
    expect(body.rules).toHaveLength(rules().rules.length - 1);
    expect(body.rules?.[0].pattern).toBe(rules().rules[1].pattern);
  });
});
