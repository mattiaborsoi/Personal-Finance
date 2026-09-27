import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS_MESSAGE, type HouseholdOut, type HouseholdUpdate } from '../api';
import { ConfigProvider } from '../config/ConfigProvider';
import { BLANK_NAME_MESSAGE, CURRENCY_CODE_MESSAGE, NO_INCOME_MESSAGE, SETTLEMENT_DAY_MESSAGE } from '../lib/household';
import { household } from '../test/fixtures';
import { fixtureConfig, jsonResponse, mockFetch, renderWithProviders, type RecordedCall } from '../test/utils';
import { EQUAL_LABEL, HOUSEHOLD_SAVED_MESSAGE, HouseholdPanel, PROPORTIONAL_LABEL } from './HouseholdPanel';

const URL = '/api/settings/household';

/** What the server would store for a PUT body: the changed fields over the current document, ratios recomputed. */
function applyUpdate(current: HouseholdOut, body: HouseholdUpdate): HouseholdOut {
  const users = {
    primary: { ...current.users.primary, ...body.users?.primary },
    secondary: { ...current.users.secondary, ...body.users?.secondary },
  };
  const next: HouseholdOut = { ...current, ...body, users, stored: true };
  const primary = Number(users.primary.base_salary_pa) + Number(users.primary.additional_income_pa);
  const secondary = Number(users.secondary.base_salary_pa) + Number(users.secondary.additional_income_pa);
  if (next.split_strategy === 'equal_50_50' || primary + secondary <= 0) {
    next.primary_ratio = 0.5;
    next.secondary_ratio = 0.5;
  } else {
    next.primary_ratio = primary / (primary + secondary);
    next.secondary_ratio = secondary / (primary + secondary);
  }
  return next;
}

/** GET answers the current document; a PUT stores the body and answers the result; the config reload is answered too. */
function mockHousehold(initial: HouseholdOut) {
  let current = initial;
  return mockFetch(({ method, url, body }) => {
    if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
    if (method === 'GET' && url === URL) return jsonResponse(current);
    if (method === 'PUT' && url === URL) {
      current = applyUpdate(current, body as HouseholdUpdate);
      return jsonResponse(current);
    }
    return undefined;
  });
}

function puts(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === 'PUT' && c.url === URL);
}

function configFetches(calls: RecordedCall[]): number {
  return calls.filter((c) => c.method === 'GET' && c.url === '/api/config').length;
}

/** The panel under the real ConfigProvider, so `useReloadConfig()` really re-fetches GET /api/config. */
async function renderPanel() {
  renderWithProviders(
    <ConfigProvider>
      <HouseholdPanel />
    </ConfigProvider>,
  );
  return screen.findByRole('region', { name: 'Alex' });
}

const saveButton = () => screen.getByRole('button', { name: 'Save changes' });
const discardButton = () => screen.getByRole('button', { name: 'Discard changes' });
const sam = () => screen.getByRole('region', { name: 'Sam' });

describe('<HouseholdPanel />', () => {
  it('shows both people, the split with its preview, settlement and currency', async () => {
    const { calls } = mockHousehold(household());

    const alex = await renderPanel();

    const load = calls.find((c) => c.url === URL);
    expect(load?.headers.Authorization).toBe('Bearer primary-token');
    expect(within(alex).getByLabelText('Name')).toHaveValue('Alex');
    expect(within(alex).getByLabelText('Annual salary')).toHaveValue('100000');
    expect(within(alex).getByLabelText('Other annual income')).toHaveValue('0');
    expect(alex).toHaveTextContent('The primary user: uploads statements and reviews them.');
    expect(within(sam()).getByLabelText('Name')).toHaveValue('Sam');
    expect(within(sam()).getByLabelText('Annual salary')).toHaveValue('80000');
    expect(sam()).toHaveTextContent('The partner: logs claims and settles up.');

    expect(screen.getByRole('radio', { name: PROPORTIONAL_LABEL })).toBeChecked();
    expect(screen.getByRole('radio', { name: EQUAL_LABEL })).not.toBeChecked();
    expect(screen.getByText('Alex 55.6 % · Sam 44.4 %')).toBeInTheDocument();

    expect(screen.getByLabelText('Settle by')).toHaveValue(1);
    expect(screen.getByLabelText('Rounding')).toHaveValue(2);
    expect(screen.getByLabelText('Code')).toHaveValue('GBP');
    expect(screen.getByLabelText('Symbol')).toHaveValue('£');

    expect(saveButton()).toBeDisabled();
    expect(discardButton()).toBeDisabled();
    expect(screen.queryByText(CONFIG_DEFAULTS_MESSAGE)).not.toBeInTheDocument();
  });

  it('says when nothing has been saved yet', async () => {
    mockHousehold(household({ stored: false }));

    await renderPanel();

    expect(screen.getByText(CONFIG_DEFAULTS_MESSAGE)).toBeInTheDocument();
  });

  it('sends only the fields that changed, confirms, and refreshes the config', async () => {
    const user = userEvent.setup();
    const { calls } = mockHousehold(household());

    await renderPanel();
    expect(configFetches(calls)).toBe(1);

    const salary = within(sam()).getByLabelText('Annual salary');
    await user.clear(salary);
    await user.type(salary, '90000');
    // The preview follows the form, not the saved figures.
    expect(screen.getByText('Alex 52.6 % · Sam 47.4 %')).toBeInTheDocument();
    const day = screen.getByLabelText('Settle by');
    await user.clear(day);
    await user.type(day, '5');
    expect(discardButton()).toBeEnabled();
    await user.click(saveButton());

    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toEqual({ users: { secondary: { base_salary_pa: '90000.00' } }, settlement_day_of_month: 5 });
    expect(await screen.findByRole('status')).toHaveTextContent(HOUSEHOLD_SAVED_MESSAGE);
    expect(within(sam()).getByLabelText('Annual salary')).toHaveValue('90000');
    expect(saveButton()).toBeDisabled();
    await waitFor(() => expect(configFetches(calls)).toBe(2));
  });

  it('previews 50–50, and refuses a proportional split with no income to go on', async () => {
    const user = userEvent.setup();
    const { calls } = mockHousehold(household());

    const alex = await renderPanel();
    await user.click(screen.getByRole('radio', { name: EQUAL_LABEL }));
    expect(screen.getByText('Alex 50.0 % · Sam 50.0 %')).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();

    await user.click(screen.getByRole('radio', { name: PROPORTIONAL_LABEL }));
    expect(screen.getByText('Alex 55.6 % · Sam 44.4 %')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    await user.clear(within(alex).getByLabelText('Annual salary'));
    await user.clear(within(sam()).getByLabelText('Annual salary'));
    expect(screen.getByText(NO_INCOME_MESSAGE)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    // 50–50 needs no incomes, so the same form saves.
    await user.click(screen.getByRole('radio', { name: EQUAL_LABEL }));
    expect(screen.queryByText(NO_INCOME_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByText('Alex 50.0 % · Sam 50.0 %')).toBeInTheDocument();
    await user.click(saveButton());
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toEqual({
      users: { primary: { base_salary_pa: '0.00' }, secondary: { base_salary_pa: '0.00' } },
      split_strategy: 'equal_50_50',
    });
  });

  it('points out a blank name, a day outside 1–28 and a bad currency code before anything is sent', async () => {
    const user = userEvent.setup();
    const { calls } = mockHousehold(household());

    const alex = await renderPanel();
    const name = within(alex).getByLabelText('Name');
    await user.clear(name);
    expect(within(alex).getByText(BLANK_NAME_MESSAGE)).toBeInTheDocument();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(saveButton()).toBeDisabled();
    // The preview falls back to a role while the name is blank.
    expect(screen.getByText('Primary 55.6 % · Sam 44.4 %')).toBeInTheDocument();
    await user.type(name, 'Alexandra');
    expect(within(alex).queryByText(BLANK_NAME_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByText('Alexandra 55.6 % · Sam 44.4 %')).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();

    const day = screen.getByLabelText('Settle by');
    await user.clear(day);
    await user.type(day, '31');
    expect(screen.getByText(SETTLEMENT_DAY_MESSAGE)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    await user.clear(day);
    await user.type(day, '1');
    expect(screen.queryByText(SETTLEMENT_DAY_MESSAGE)).not.toBeInTheDocument();

    const code = screen.getByLabelText('Code');
    await user.clear(code);
    await user.type(code, 'gb');
    expect(code).toHaveValue('GB');
    expect(screen.getByText(CURRENCY_CODE_MESSAGE)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(puts(calls)).toHaveLength(0);
  });

  it('shows a 422 next to the field it names, whether by a validation loc or by its words', async () => {
    const user = userEvent.setup();
    const longName = 'S'.repeat(65);
    const { calls } = mockFetch(({ method, url, body }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method === 'GET' && url === URL) return jsonResponse(household());
      if (method === 'PUT' && url === URL) {
        const update = body as HouseholdUpdate;
        if (update.users?.secondary?.display_name) return jsonResponse({ detail: 'display_name must be at most 64 characters' }, 422);
        if (update.base_currency) {
          return jsonResponse(
            { detail: [{ loc: ['body', 'base_currency'], msg: 'GBX is not a currency', type: 'value_error' }] },
            422,
          );
        }
        return jsonResponse({ detail: 'something the form did not expect' }, 422);
      }
      return undefined;
    });

    await renderPanel();
    const name = within(sam()).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, longName);
    await user.click(saveButton());

    // The server does not say whose name, but only Sam's was sent.
    await waitFor(() => expect(within(sam()).getByText('display_name must be at most 64 characters')).toBeInTheDocument());
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription('display_name must be at most 64 characters');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(name).toHaveValue(longName);
    expect(saveButton()).toBeEnabled();
    // Editing the field clears the complaint.
    await user.type(name, '{Backspace}');
    expect(within(sam()).queryByText(/at most 64 characters/)).not.toBeInTheDocument();

    await user.clear(name);
    await user.type(name, 'Sam');
    const code = screen.getByLabelText('Code');
    await user.clear(code);
    await user.type(code, 'GBX');
    await user.click(saveButton());

    await waitFor(() => expect(code).toHaveAttribute('aria-invalid', 'true'));
    expect(code).toHaveAccessibleDescription('base_currency: GBX is not a currency');
    expect(puts(calls)).toHaveLength(2);

    // A refusal that names no field is shown as a plain error.
    await user.clear(code);
    await user.type(code, 'GBP');
    await user.click(screen.getByRole('radio', { name: EQUAL_LABEL }));
    await user.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('something the form did not expect');
    expect(configFetches(calls)).toBe(1);
  });

  it('discards edits back to the saved household', async () => {
    const user = userEvent.setup();
    const { calls } = mockHousehold(household());

    const alex = await renderPanel();
    const name = within(alex).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Alexandra');
    const symbol = screen.getByLabelText('Symbol');
    await user.clear(symbol);
    await user.type(symbol, '€');
    expect(saveButton()).toBeEnabled();

    await user.click(discardButton());

    expect(within(alex).getByLabelText('Name')).toHaveValue('Alex');
    expect(screen.getByLabelText('Symbol')).toHaveValue('£');
    expect(saveButton()).toBeDisabled();
    expect(discardButton()).toBeDisabled();

    // A change that cannot be sent can still be put back.
    await user.clear(within(alex).getByLabelText('Name'));
    expect(saveButton()).toBeDisabled();
    expect(discardButton()).toBeEnabled();
    await user.click(discardButton());
    expect(within(alex).getByLabelText('Name')).toHaveValue('Alex');
    expect(within(alex).queryByText(BLANK_NAME_MESSAGE)).not.toBeInTheDocument();
    expect(puts(calls)).toHaveLength(0);
  });

  it('shows a load error with a retry that fetches again', async () => {
    const user = userEvent.setup();
    let failed = false;
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method !== 'GET' || url !== URL) return undefined;
      if (failed) return jsonResponse(household());
      failed = true;
      return jsonResponse({ detail: 'database unavailable' }, 500);
    });

    renderWithProviders(<HouseholdPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent('database unavailable');
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('region', { name: 'Alex' })).toBeInTheDocument();
    expect(calls.filter((c) => c.url === URL)).toHaveLength(2);
  });
});
