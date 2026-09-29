import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS_MESSAGE, type Rule, type RuleTestBody, type RuleTestResult, type RulesOut, type RulesUpdate } from '../api';
import { ConfigProvider } from '../config/ConfigProvider';
import { BLANK_PATTERN_MESSAGE, MISSING_ACCOUNT_MESSAGE, WINDOW_MESSAGE } from '../lib/rules';
import { rule, rules } from '../test/fixtures';
import { categoryValue, fixtureConfig, jsonResponse, mockFetch, pickCategory, renderWithProviders, type RecordedCall } from '../test/utils';
import {
  CARD_PAYMENT_MESSAGE,
  NO_MATCH_MESSAGE,
  NOT_CARD_PAYMENT_MESSAGE,
  RULES_SAVED_MESSAGE,
  RulesPanel,
  TRY_BLOCKED_MESSAGE,
  TRY_HINT,
  UNKNOWN_ACCOUNT_SUFFIX,
} from './RulesPanel';

const URL = '/api/settings/rules';
const TEST_URL = `${URL}/test`;

const WATER = rule();
const ROBINHOOD: Rule = rules().rules[1];

type Tester = (body: RuleTestBody) => RuleTestResult;

/** GET answers the current document; a PUT stores the body and answers the result; POST /test asks `tester`. */
function mockRules(initial: RulesOut, tester?: Tester) {
  let current = initial;
  return mockFetch(({ method, url, body }) => {
    if (method === 'GET' && url === URL) return jsonResponse(current);
    if (method === 'PUT' && url === URL) {
      current = { ...current, ...(body as RulesUpdate), stored: true };
      return jsonResponse(current);
    }
    if (method === 'POST' && url === TEST_URL && tester) return jsonResponse(tester(body as RuleTestBody));
    return undefined;
  });
}

function puts(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === 'PUT' && c.url === URL);
}

function tests(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === 'POST' && c.url === TEST_URL);
}

async function renderPanel() {
  renderWithProviders(<RulesPanel />);
  return screen.findByLabelText('Pattern for rule 1');
}

/** Opens a category picker, reads the categories it offers in order, and closes it again. */
async function pickerValues(user: UserEvent, picker: HTMLElement): Promise<string[]> {
  await user.click(picker);
  const values = within(screen.getByRole('listbox', { name: 'Categories' }))
    .getAllByRole('option')
    .map((o) => o.dataset.value ?? '');
  await user.keyboard('{Escape}');
  return values;
}

function optionLabels(select: HTMLElement): string[] {
  return within(select)
    .getAllByRole('option')
    .map((o) => o.textContent ?? '');
}

const saveButton = () => screen.getByRole('button', { name: 'Save changes' });
const discardButton = () => screen.getByRole('button', { name: 'Discard changes' });
const testButton = () => screen.getByRole('button', { name: 'Test' });

describe('<RulesPanel />', () => {
  it('lays each rule out as one block that can stack on a phone, with one control per field and labels hidden from screen readers', async () => {
    mockRules(rules());

    const pattern1 = await renderPanel();

    const row = pattern1.closest('tr') as HTMLTableRowElement;
    // "Rule 1" heads the stacked block; the table's own # column still reads 1.
    expect(row.cells[0]).toHaveTextContent('Rule 1');
    // The visible labels for the stacked view are hidden from assistive tech, so nothing is announced twice.
    for (const label of ['Pattern', 'Category', 'Claim type', 'Merchant', 'Transfer']) {
      expect(within(row).getByText(label)).toHaveAttribute('aria-hidden', 'true');
    }
    // One element per control, whatever the width: nothing is rendered twice for the phone layout.
    expect(screen.getAllByLabelText('Pattern for rule 1')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Remove rule 1' })).toHaveLength(1);
    expect(within(row).getByRole('button', { name: 'Move rule 1 down' })).toBeInTheDocument();
  });

  it('shows the rules in order with their fields, the payment patterns and the matching numbers', async () => {
    const user = userEvent.setup();
    const { calls } = mockRules(rules());

    const pattern1 = await renderPanel();

    expect(calls[0].headers.Authorization).toBe('Bearer primary-token');
    expect(screen.getByRole('region', { name: 'Rules' })).toHaveTextContent('the first match wins');
    expect(pattern1).toHaveValue('(?i)AQUANORTH\\s*WATER');
    const category1 = screen.getByLabelText('Category for rule 1');
    expect(categoryValue(category1)).toBe('Bills:Water');
    expect(category1).toHaveTextContent('Bills › Water');
    expect(await pickerValues(user, category1)).toEqual(['Groceries', 'Dining', 'Bills:Water', 'Transport:Taxi', 'Uncategorized']);
    expect(screen.getByLabelText('Claim type for rule 1')).toHaveValue('shared_proportional');
    expect(screen.getByLabelText('Merchant for rule 1')).toHaveValue('');
    expect(screen.getByLabelText('Internal transfer for rule 1')).not.toBeChecked();
    expect(screen.queryByLabelText('Transfer account for rule 1')).not.toBeInTheDocument();

    expect(screen.getByLabelText('Pattern for rule 2')).toHaveValue('(?i)ROBINHOOD');
    // A category the config no longer lists stays in the select rather than being silently changed.
    const category2 = screen.getByLabelText('Category for rule 2');
    expect(categoryValue(category2)).toBe('Transfers:Investment');
    expect((await pickerValues(user, category2))[0]).toBe('Transfers:Investment');
    expect(screen.getByLabelText('Claim type for rule 2')).toHaveValue('personal');
    expect(screen.getByLabelText('Merchant for rule 2')).toHaveValue('Robinhood');
    expect(screen.getByLabelText('Internal transfer for rule 2')).toBeChecked();
    const account2 = screen.getByLabelText('Transfer account for rule 2');
    expect(account2).toHaveValue('acc_invest_robinhood');
    expect(optionLabels(account2)).toContain('Robinhood ··INVEST');

    expect(screen.getByRole('button', { name: 'Move rule 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move rule 2 down' })).toBeDisabled();

    expect(screen.getByLabelText('Payment pattern 1')).toHaveValue('(?i)PAYMENT\\s+RECEIVED\\s*-?\\s*THANK\\s*YOU');
    expect(screen.getByLabelText('Payment pattern 2')).toHaveValue('(?i)AMEX\\s*(DD|PAYMENT)');
    expect(screen.getByLabelText('Match window')).toHaveValue(7);
    expect(screen.getByText('7 days')).toBeInTheDocument();
    expect(screen.getByLabelText('Amount tolerance')).toHaveValue('0.01');

    expect(saveButton()).toBeDisabled();
    expect(discardButton()).toBeDisabled();
    expect(testButton()).toBeDisabled();
    expect(screen.queryByText(CONFIG_DEFAULTS_MESSAGE)).not.toBeInTheDocument();
  });

  it('offers to add the first rule when there are none, and says when nothing has been saved yet', async () => {
    const user = userEvent.setup();
    mockRules(rules({ rules: [], stored: false }));

    renderWithProviders(<RulesPanel />);

    expect(await screen.findByText('No rules yet')).toBeInTheDocument();
    expect(screen.getByText(CONFIG_DEFAULTS_MESSAGE)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(screen.getByLabelText('Pattern for rule 1')).toHaveValue('');
    expect(categoryValue('Category for rule 1')).toBe('Groceries');
  });

  it('sends only the list or number that changed', async () => {
    const user = userEvent.setup();
    const { calls } = mockRules(rules());

    await renderPanel();
    await pickCategory(user, 'Category for rule 1', 'Groceries');
    expect(discardButton()).toBeEnabled();
    await user.click(saveButton());

    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toEqual({ rules: [{ ...WATER, category: 'Groceries' }, ROBINHOOD] });
    expect(await screen.findByRole('status')).toHaveTextContent(RULES_SAVED_MESSAGE);
    expect(categoryValue('Category for rule 1')).toBe('Groceries');
    expect(saveButton()).toBeDisabled();

    const window = screen.getByLabelText('Match window');
    await user.clear(window);
    await user.type(window, '10');
    expect(screen.getByText('10 days')).toBeInTheDocument();
    await user.click(saveButton());

    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(puts(calls)[1].body).toEqual({ match_window_days: 10 });

    // The same value typed differently is not a change.
    const tolerance = screen.getByLabelText('Amount tolerance');
    await user.clear(tolerance);
    await user.type(tolerance, '0.010');
    expect(saveButton()).toBeDisabled();
    await user.clear(tolerance);
    await user.type(tolerance, '0.05');
    await user.click(saveButton());
    await waitFor(() => expect(puts(calls)).toHaveLength(3));
    expect(puts(calls)[2].body).toEqual({ amount_tolerance: '0.05' });
  });

  it('reorders, adds and removes rules, refusing a blank pattern until it is typed', async () => {
    const user = userEvent.setup();
    const { calls } = mockRules(rules());

    await renderPanel();
    const robinhood = screen.getByLabelText('Pattern for rule 2');
    await user.click(screen.getByRole('button', { name: 'Move rule 2 up' }));
    expect(screen.getByLabelText('Pattern for rule 1')).toHaveValue('(?i)ROBINHOOD');
    expect(screen.getByLabelText('Pattern for rule 2')).toHaveValue('(?i)AQUANORTH\\s*WATER');
    // The row moves rather than being rebuilt, so a control keeps its focus and any half-typed text.
    expect(screen.getByLabelText('Pattern for rule 1')).toBe(robinhood);
    expect(saveButton()).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    const pattern3 = screen.getByLabelText('Pattern for rule 3');
    expect(pattern3).toHaveValue('');
    expect(screen.getByText(BLANK_PATTERN_MESSAGE)).toBeInTheDocument();
    expect(pattern3).toHaveAttribute('aria-invalid', 'true');
    // Save points at the blank pattern rather than sending it.
    await user.click(saveButton());
    expect(pattern3).toHaveFocus();
    expect(puts(calls)).toHaveLength(0);
    await user.type(pattern3, '(?i)OCADO');
    await pickCategory(user, 'Category for rule 3', 'Dining');
    await user.selectOptions(screen.getByLabelText('Claim type for rule 3'), 'shared_equal');
    await user.type(screen.getByLabelText('Merchant for rule 3'), 'Ocado');
    expect(screen.queryByText(BLANK_PATTERN_MESSAGE)).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Remove rule 1' }));
    expect(screen.getByLabelText('Pattern for rule 1')).toHaveValue('(?i)AQUANORTH\\s*WATER');
    expect(screen.getByLabelText('Pattern for rule 2')).toHaveValue('(?i)OCADO');
    expect(screen.queryByLabelText('Pattern for rule 3')).not.toBeInTheDocument();
    await user.click(saveButton());

    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toEqual({
      rules: [
        WATER,
        {
          pattern: '(?i)OCADO',
          category: 'Dining',
          claim_type: 'shared_equal',
          merchant: 'Ocado',
          subcategory: null,
          is_internal_transfer: false,
          transfer_to_account: null,
        },
      ],
    });
  });

  it('asks for the account behind an internal transfer, and drops it when the transfer is unticked', async () => {
    const user = userEvent.setup();
    const { calls } = mockRules(rules());

    await renderPanel();
    await user.click(screen.getByLabelText('Internal transfer for rule 1'));
    const account = screen.getByLabelText('Transfer account for rule 1');
    expect(account).toHaveValue('');
    expect(screen.getByText(MISSING_ACCOUNT_MESSAGE)).toBeInTheDocument();
    // The note is about the account, not the pattern.
    expect(account).toHaveAttribute('aria-invalid', 'true');
    expect(account).toHaveAccessibleDescription(MISSING_ACCOUNT_MESSAGE);
    expect(screen.getByLabelText('Pattern for rule 1')).not.toHaveAttribute('aria-invalid');
    await user.click(saveButton());
    expect(account).toHaveFocus();
    expect(puts(calls)).toHaveLength(0);
    // Every active account is offered.
    expect(optionLabels(account)).toEqual([
      'Choose the account it goes to',
      'HSBC Premier ··4471',
      'Barclays Premier ··2093',
      'Amex Platinum ··7715',
      'Amex Platinum (supplementary) ··3348',
      'Virgin Money credit card ··5502',
      'Robinhood ··INVEST',
    ]);
    await user.selectOptions(account, 'acc_checking_hsbc');
    expect(screen.queryByText(MISSING_ACCOUNT_MESSAGE)).not.toBeInTheDocument();
    expect(account).not.toHaveAttribute('aria-invalid');

    await user.click(screen.getByLabelText('Internal transfer for rule 2'));
    expect(screen.queryByLabelText('Transfer account for rule 2')).not.toBeInTheDocument();
    await user.click(saveButton());

    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toEqual({
      rules: [
        { ...WATER, is_internal_transfer: true, transfer_to_account: 'acc_checking_hsbc' },
        { ...ROBINHOOD, is_internal_transfer: false, transfer_to_account: null },
      ],
    });
  });

  it('tries a description against the unsaved rules and says what would happen', async () => {
    const user = userEvent.setup();
    const { calls } = mockRules(rules(), (body) => {
      if (/WATER/.test(body.description)) return { rule_index: 0, rule: body.rules?.[0] ?? null, is_payment: false };
      return { rule_index: null, rule: null, is_payment: /PAYMENT/.test(body.description) };
    });

    await renderPanel();
    await pickCategory(user, 'Category for rule 1', 'Groceries');
    const input = screen.getByLabelText('Statement description');
    expect(testButton()).toBeDisabled();
    await user.type(input, 'AQUANORTH WATER 0123');
    expect(testButton()).toBeEnabled();
    await user.click(testButton());

    const result = await screen.findByRole('status', { name: 'Test result' });
    expect(tests(calls)).toHaveLength(1);
    expect(tests(calls)[0].body).toEqual({
      description: 'AQUANORTH WATER 0123',
      rules: [{ ...WATER, category: 'Groceries' }, ROBINHOOD],
      payment_patterns: rules().payment_patterns,
    });
    expect(result).toHaveTextContent('Matches rule 1 → Groceries, Split by income');
    expect(result).toHaveTextContent(NOT_CARD_PAYMENT_MESSAGE);
    // Testing never saves.
    expect(puts(calls)).toHaveLength(0);

    // Enter in the box tests rather than submitting the form.
    await user.clear(input);
    await user.type(input, 'PAYMENT RECEIVED - THANK YOU{Enter}');
    const next = await screen.findByRole('status', { name: 'Test result' });
    expect(tests(calls)).toHaveLength(2);
    expect(next).toHaveTextContent(NO_MATCH_MESSAGE);
    expect(next).toHaveTextContent(CARD_PAYMENT_MESSAGE);
    expect(puts(calls)).toHaveLength(0);

    // The result described the rules as they were.
    await pickCategory(user, 'Category for rule 1', 'Dining');
    expect(screen.queryByRole('status', { name: 'Test result' })).not.toBeInTheDocument();

    // A form that cannot be sent cannot be tried either, and says why.
    await user.clear(screen.getByLabelText('Pattern for rule 2'));
    expect(testButton()).toBeDisabled();
    expect(input).toHaveAccessibleDescription(TRY_BLOCKED_MESSAGE);
    await user.type(screen.getByLabelText('Pattern for rule 2'), '(?i)ROBINHOOD');
    expect(testButton()).toBeEnabled();
    expect(input).toHaveAccessibleDescription(TRY_HINT);
  });

  it('puts the tester’s refusal of an unsaved rule on that rule, without saving', async () => {
    const user = userEvent.setup();
    const detail = "rule 1: invalid regex '(?i)AQUANORTH(': missing ), unterminated subpattern at position 10";
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === URL) return jsonResponse(rules());
      if (method === 'POST' && url === TEST_URL) return jsonResponse({ detail }, 422);
      return undefined;
    });

    await renderPanel();
    const pattern1 = screen.getByLabelText('Pattern for rule 1');
    await user.clear(pattern1);
    await user.type(pattern1, '(?i)AQUANORTH(');
    await user.type(screen.getByLabelText('Statement description'), 'AQUANORTH WATER{Enter}');

    await waitFor(() => expect(pattern1).toHaveAttribute('aria-invalid', 'true'));
    expect(pattern1).toHaveAccessibleDescription(detail);
    expect(screen.getByRole('alert')).toHaveTextContent(detail);
    expect(screen.queryByRole('status', { name: 'Test result' })).not.toBeInTheDocument();
    expect(tests(calls)).toHaveLength(1);
    expect(puts(calls)).toHaveLength(0);
  });

  it('marks the control a rule’s refusal is about: its category, claim type or target account', async () => {
    const user = userEvent.setup();
    const refusals = [
      "rule 2: category 'Transfers:Investment' is not in the configured taxonomy",
      "rule 2: transfer_to_account 'acc_invest_robinhood' is not an account",
      'rule 1: unknown claim_type',
    ];
    let attempt = 0;
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === URL) return jsonResponse(rules());
      if (method === 'PUT' && url === URL) return jsonResponse({ detail: refusals[attempt++] }, 422);
      return undefined;
    });

    await renderPanel();
    const merchant2 = screen.getByLabelText('Merchant for rule 2');
    await user.type(merchant2, ' Markets');
    await user.click(saveButton());

    const category2 = screen.getByLabelText('Category for rule 2');
    await waitFor(() => expect(category2).toHaveAttribute('aria-invalid', 'true'));
    // The description is the value the button shows, then the refusal.
    expect(category2).toHaveAccessibleDescription(expect.stringContaining(refusals[0]));
    expect(screen.getByLabelText('Pattern for rule 2')).not.toHaveAttribute('aria-invalid');

    await user.type(merchant2, '!');
    await user.click(saveButton());
    const account2 = screen.getByLabelText('Transfer account for rule 2');
    await waitFor(() => expect(account2).toHaveAttribute('aria-invalid', 'true'));
    expect(account2).toHaveAccessibleDescription(refusals[1]);
    expect(category2).not.toHaveAttribute('aria-invalid');

    await user.type(merchant2, '!');
    await user.click(saveButton());
    const claim1 = screen.getByLabelText('Claim type for rule 1');
    await waitFor(() => expect(claim1).toHaveAttribute('aria-invalid', 'true'));
    expect(claim1).toHaveAccessibleDescription(refusals[2]);
  });

  it('keeps a target account the config no longer has, rather than showing a blank', async () => {
    mockRules(rules({ rules: [rule({ is_internal_transfer: true, transfer_to_account: 'acc_closed_isa' })] }));

    await renderPanel();

    const account = screen.getByLabelText('Transfer account for rule 1');
    expect(account).toHaveValue('acc_closed_isa');
    expect(optionLabels(account)).toContain(`acc_closed_isa ${UNKNOWN_ACCOUNT_SUFFIX}`);
    expect(saveButton()).toBeDisabled();
  });

  it('refreshes the config after a save', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url, body }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method === 'GET' && url === URL) return jsonResponse(rules());
      if (method === 'PUT' && url === URL) return jsonResponse({ ...rules(), ...(body as RulesUpdate) });
      return undefined;
    });
    const configFetches = () => calls.filter((c) => c.method === 'GET' && c.url === '/api/config').length;

    renderWithProviders(
      <ConfigProvider>
        <RulesPanel />
      </ConfigProvider>,
    );
    await screen.findByLabelText('Pattern for rule 1');
    expect(configFetches()).toBe(1);

    await user.selectOptions(screen.getByLabelText('Claim type for rule 1'), 'shared_equal');
    await user.click(saveButton());

    expect(await screen.findByRole('status')).toHaveTextContent(RULES_SAVED_MESSAGE);
    await waitFor(() => expect(configFetches()).toBe(2));
    expect(puts(calls)[0].body).toEqual({ rules: [{ ...WATER, claim_type: 'shared_equal' }, ROBINHOOD] });
  });

  it('shows a 422 beside the rule, the payment pattern or the number it names', async () => {
    const user = userEvent.setup();
    const refusals = [
      "rule 2: invalid regex '(?i)ROBIN(HOOD': missing ), unterminated subpattern at position 8",
      "payment pattern 1: invalid regex '(': missing ), unterminated subpattern at position 0",
      'match_window_days must be between 0 and 60',
      'the taxonomy could not be applied',
    ];
    let attempt = 0;
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === URL) return jsonResponse(rules());
      if (method === 'PUT' && url === URL) return jsonResponse({ detail: refusals[attempt++] }, 422);
      return undefined;
    });

    await renderPanel();
    const pattern2 = screen.getByLabelText('Pattern for rule 2');
    await user.type(pattern2, 'X');
    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(refusals[0]);
    expect(pattern2).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Pattern for rule 1')).not.toHaveAttribute('aria-invalid');
    expect(saveButton()).toBeEnabled();
    // Editing anything clears the server's complaint.
    await user.type(pattern2, 'Y');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(saveButton());
    const pattern1 = screen.getByLabelText('Payment pattern 1');
    await waitFor(() => expect(pattern1).toHaveAttribute('aria-invalid', 'true'));
    expect(within(pattern1.closest('li') as HTMLElement).getByRole('alert')).toHaveTextContent(refusals[1]);
    expect(pattern2).not.toHaveAttribute('aria-invalid');

    await user.type(pattern2, 'Z');
    await user.click(saveButton());
    const window = screen.getByLabelText('Match window');
    await waitFor(() => expect(window).toHaveAttribute('aria-invalid', 'true'));
    expect(window).toHaveAccessibleDescription(refusals[2]);

    // A refusal that names nothing on the form is a plain error.
    await user.type(pattern2, 'W');
    await user.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(refusals[3]);
    expect(puts(calls)).toHaveLength(4);
  });

  it('refuses a match window outside 0–60 and a blank payment pattern before sending', async () => {
    const user = userEvent.setup();
    const { calls } = mockRules(rules());

    await renderPanel();
    const window = screen.getByLabelText('Match window');
    await user.clear(window);
    await user.type(window, '90');
    expect(screen.getByText(WINDOW_MESSAGE)).toBeInTheDocument();
    await user.click(saveButton());
    expect(window).toHaveFocus();
    await user.clear(window);
    await user.type(window, '7');

    await user.click(screen.getByRole('button', { name: 'Add pattern' }));
    const pattern3 = screen.getByLabelText('Payment pattern 3');
    expect(pattern3).toHaveValue('');
    expect(screen.getByText(BLANK_PATTERN_MESSAGE)).toBeInTheDocument();
    await user.click(saveButton());
    expect(pattern3).toHaveFocus();
    expect(puts(calls)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Remove payment pattern 3' }));
    expect(screen.queryByText(BLANK_PATTERN_MESSAGE)).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Remove payment pattern 2' }));
    await user.click(saveButton());
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toEqual({ payment_patterns: ['(?i)PAYMENT\\s+RECEIVED\\s*-?\\s*THANK\\s*YOU'] });
  });

  it('discards edits back to the saved rules', async () => {
    const user = userEvent.setup();
    const { calls } = mockRules(rules());

    await renderPanel();
    await user.click(screen.getByRole('button', { name: 'Remove rule 1' }));
    await user.type(screen.getByLabelText('Payment pattern 1'), 'X');
    expect(saveButton()).toBeEnabled();

    await user.click(discardButton());

    expect(screen.getByLabelText('Pattern for rule 1')).toHaveValue('(?i)AQUANORTH\\s*WATER');
    expect(screen.getByLabelText('Pattern for rule 2')).toHaveValue('(?i)ROBINHOOD');
    expect(screen.getByLabelText('Payment pattern 1')).toHaveValue('(?i)PAYMENT\\s+RECEIVED\\s*-?\\s*THANK\\s*YOU');
    expect(saveButton()).toBeDisabled();
    expect(discardButton()).toBeDisabled();

    // A change that cannot be sent can still be put back.
    const window = screen.getByLabelText('Match window');
    await user.clear(window);
    await user.type(window, '90');
    // Save stays pressable too, and would point at the window.
    expect(saveButton()).toBeEnabled();
    expect(discardButton()).toBeEnabled();
    await user.click(discardButton());
    expect(window).toHaveValue(7);
    expect(discardButton()).toBeDisabled();
    expect(puts(calls)).toHaveLength(0);
  });

  it('shows a load error with a retry that fetches again', async () => {
    const user = userEvent.setup();
    let failed = false;
    const { calls } = mockFetch(({ method, url }) => {
      if (method !== 'GET' || url !== URL) return undefined;
      if (failed) return jsonResponse(rules());
      failed = true;
      return jsonResponse({ detail: 'database unavailable' }, 500);
    });

    renderWithProviders(<RulesPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent('database unavailable');
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByLabelText('Pattern for rule 1')).toBeInTheDocument();
    expect(calls.filter((c) => c.url === URL)).toHaveLength(2);
  });
});
