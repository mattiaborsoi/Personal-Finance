import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AskOut } from '../api';
import { fixtureConfig, jsonResponse, mockFetch, renderWithProviders } from '../test/utils';
import { AI_OFF_MESSAGE, ASK_EXAMPLES, AskBox, CANNOT_ANSWER_PREFIX } from './AskBox';

const withAi = { ...fixtureConfig, ai_enabled: true };

function answer(overrides: Partial<AskOut> = {}): AskOut {
  return {
    answer: '£230.00 over 3 transactions.',
    interpreted: 'Showing: Travel, Jul 2026 to Aug 2026, money out, approved and pending',
    query: {
      kind: 'spend',
      metric: 'sum',
      date_from: null,
      date_to: null,
      months: ['2026-07', '2026-08'],
      categories: ['Travel'],
      merchant_text: null,
      accounts: [],
      claim_types: [],
      people: [],
      direction: 'out',
      status: 'all',
      group_by: null,
      settlement_period: null,
    },
    link: '/transactions?category=Travel&include_transfers=false',
    value: '230.00',
    count: 3,
    rows: [],
    ...overrides,
  };
}

describe('<AskBox />', () => {
  it('is not rendered while AI is off', () => {
    mockFetch(() => undefined);
    renderWithProviders(<AskBox />);
    expect(screen.queryByRole('region', { name: 'Ask' })).not.toBeInTheDocument();
  });

  it('sends the question and shows the answer, the filters as interpreted and the link', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => (method === 'POST' && url === '/api/ask' ? jsonResponse(answer()) : undefined));
    renderWithProviders(<AskBox />, { config: withAi });

    const box = screen.getByRole('region', { name: 'Ask' });
    expect(within(box).getByRole('button', { name: 'Ask' })).toBeDisabled();
    await user.type(within(box).getByLabelText('Your question'), 'How much did we spend on travel?');
    await user.click(within(box).getByRole('button', { name: 'Ask' }));

    const result = await screen.findByRole('status', { name: 'Answer' });
    expect(result).toHaveTextContent('£230.00 over 3 transactions.');
    expect(result).toHaveTextContent('Showing: Travel, Jul 2026 to Aug 2026, money out, approved and pending');
    expect(within(result).getByRole('link', { name: 'Open in Transactions' })).toHaveAttribute(
      'href',
      '/transactions?category=Travel&include_transfers=false',
    );
    expect(calls.filter((c) => c.url === '/api/ask').map((c) => c.body)).toEqual([{ question: 'How much did we spend on travel?' }]);
  });

  it('offers example questions that fill the box', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    renderWithProviders(<AskBox />, { config: withAi });
    await user.click(screen.getByRole('button', { name: ASK_EXAMPLES[0] }));
    expect(screen.getByLabelText('Your question')).toHaveValue(ASK_EXAMPLES[0]);
  });

  it('shows grouped totals as a table with readable labels', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) =>
      method === 'POST' && url === '/api/ask'
        ? jsonResponse(
            answer({
              answer: '2 months, totalling £230.00 in all.',
              query: { ...answer().query, group_by: 'month' },
              rows: [
                { label: '2026-07', amount: '120.00', count: 1 },
                { label: '2026-08', amount: '110.00', count: 2 },
              ],
            }),
          )
        : undefined,
    );
    renderWithProviders(<AskBox />, { config: withAi });
    await user.type(screen.getByLabelText('Your question'), 'travel by month');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row').map((r) => r.textContent)).toEqual([
      'monthAmountLines',
      'July 2026£120.001',
      'August 2026£110.002',
    ]);
  });

  it('explains when the question cannot be expressed, and when AI was switched off meanwhile', async () => {
    const user = userEvent.setup();
    let status = 422;
    mockFetch(({ method, url }) =>
      method === 'POST' && url === '/api/ask' ? jsonResponse({ detail: 'Settl does not know the weather.' }, status) : undefined,
    );
    renderWithProviders(<AskBox />, { config: withAi });
    await user.type(screen.getByLabelText('Your question'), 'Is it raining?');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(`${CANNOT_ANSWER_PREFIX}: Settl does not know the weather.`);
    expect(screen.queryByRole('status', { name: 'Answer' })).not.toBeInTheDocument();

    status = 409;
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(AI_OFF_MESSAGE);
  });
});
