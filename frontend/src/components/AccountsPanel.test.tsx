import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AccountOut } from '../api';
import { ConfigProvider } from '../config/ConfigProvider';
import { SettingsPage } from '../pages/SettingsPage';
import { account } from '../test/fixtures';
import { fixtureConfig, jsonResponse, mockFetch, renderWithProviders, type RecordedCall } from '../test/utils';
import { AccountsPanel, HAS_TRANSACTIONS_TITLE } from './AccountsPanel';

const hsbc = account({ id: 'acc_checking_hsbc', transaction_count: 12 });

/** No label, so the table falls back to institution and type; billed to the primary user. */
const amexSupp = account({
  id: 'acc_cc_amex_supp',
  institution: 'Amex',
  label: null,
  account_type: 'credit_supplementary',
  owner_user_id: 'user_secondary',
  identifier_last4: '3348',
  default_claim_type: 'shared_proportional',
  billed_to: 'user_primary',
  transaction_count: 0,
  created_at: '2026-02-11T14:20:00Z',
});

const virgin = account({
  id: 'acc_cc_virgin',
  institution: 'Virgin',
  label: 'Virgin Money credit card',
  account_type: 'credit',
  identifier_last4: '5502',
  is_active: false,
  transaction_count: 3,
  created_at: '2025-11-30T08:00:00Z',
});

/** The panel under the real ConfigProvider, so `useReloadConfig()` really re-fetches GET /api/config. */
function renderPanel() {
  return renderWithProviders(
    <ConfigProvider>
      <AccountsPanel />
    </ConfigProvider>,
  );
}

function rowFor(name: string): HTMLElement {
  const row = screen.getByRole('button', { name: `Edit ${name}` }).closest('tr');
  if (!row) throw new Error(`No row for ${name}`);
  return row;
}

function configFetches(calls: RecordedCall[]): number {
  return calls.filter((c) => c.method === 'GET' && c.url === '/api/config').length;
}

function byMethod(calls: RecordedCall[], method: string): RecordedCall[] {
  return calls.filter((c) => c.method === method);
}

async function openAddDialog(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'Add account' }));
  return screen.findByRole('dialog', { name: 'Add account' });
}

describe('<AccountsPanel />', () => {
  it('lists every account with its owner, digits, default claim type, status and transaction count', async () => {
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/accounts') return jsonResponse([hsbc, amexSupp, virgin]);
      return undefined;
    });

    renderWithProviders(<SettingsPage />, { route: '/settings' });
    await screen.findByRole('button', { name: 'Edit HSBC Premier' });
    expect(calls[0].url).toBe('/api/accounts');
    expect(calls[0].headers.Authorization).toBe('Bearer primary-token');

    const hsbcRow = rowFor('HSBC Premier');
    expect(within(hsbcRow).getByText('acc_checking_hsbc')).toBeInTheDocument();
    expect(within(hsbcRow).getByText('HSBC')).toBeInTheDocument();
    expect(within(hsbcRow).getByText('Current account')).toBeInTheDocument();
    expect(within(hsbcRow).getByText('Alex')).toBeInTheDocument();
    expect(within(hsbcRow).getByText('··4471')).toBeInTheDocument();
    expect(within(hsbcRow).getByText('Personal (not shared)')).toBeInTheDocument();
    expect(within(hsbcRow).getByText('12')).toBeInTheDocument();
    expect(within(hsbcRow).getByText('Active')).toBeInTheDocument();
    expect(within(hsbcRow).getByRole('button', { name: 'Archive HSBC Premier' })).toBeInTheDocument();

    // Without a label the name is institution + type; the owner and the payer are different people here.
    const suppRow = rowFor('Amex Supplementary card');
    const cells = within(suppRow).getAllByRole('cell');
    expect(cells[2]).toHaveTextContent('Supplementary card');
    expect(cells[3]).toHaveTextContent('Sam');
    expect(cells[4]).toHaveTextContent('··3348');
    expect(cells[5]).toHaveTextContent('Split by income');
    expect(cells[6]).toHaveTextContent('Alex');
    expect(cells[7]).toHaveTextContent('0');
    expect(within(suppRow).getByText('Active')).toBeInTheDocument();

    const virginRow = rowFor('Virgin Money credit card');
    expect(within(virginRow).getByText('Archived')).toBeInTheDocument();
    expect(within(virginRow).getByText('3')).toBeInTheDocument();
    expect(within(virginRow).getByRole('button', { name: 'Restore Virgin Money credit card' })).toBeInTheDocument();
    expect(within(virginRow).queryByRole('button', { name: /^Archive / })).not.toBeInTheDocument();
  });

  it('offers to add the first account when there are none', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => (method === 'GET' && url === '/api/accounts' ? jsonResponse([]) : undefined));

    renderWithProviders(<AccountsPanel />);
    expect(await screen.findByText('No accounts yet')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add your first account' }));
    expect(await screen.findByRole('dialog', { name: 'Add account' })).toBeInTheDocument();
  });

  it('adds an account without an id when none was typed, then shows it and refreshes the config', async () => {
    const user = userEvent.setup();
    const created = account({
      id: 'acc_savings_oakfield',
      institution: 'Oakfield',
      label: 'Oakfield Saver',
      account_type: 'savings',
      owner_user_id: 'user_secondary',
      identifier_last4: '8802',
      default_claim_type: 'shared_equal',
      transaction_count: 0,
      created_at: '2026-09-26T09:00:00Z',
    });
    let list = [hsbc];
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method === 'GET' && url === '/api/accounts') return jsonResponse(list);
      if (method === 'POST' && url === '/api/accounts') {
        list = [...list, created];
        return jsonResponse(created, 201);
      }
      return undefined;
    });

    renderPanel();
    await screen.findByRole('button', { name: 'Edit HSBC Premier' });
    expect(configFetches(calls)).toBe(1);

    const dialog = await openAddDialog(user);
    expect(within(dialog).getByLabelText('Label (optional)')).toHaveFocus();
    await user.type(within(dialog).getByLabelText('Label (optional)'), 'Oakfield Saver');
    await user.type(within(dialog).getByLabelText('Institution'), 'Oakfield');
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'savings');
    await user.selectOptions(within(dialog).getByLabelText('Owner'), 'user_secondary');
    await user.type(within(dialog).getByLabelText('Last four digits'), '8802');
    await user.selectOptions(within(dialog).getByLabelText('Default claim type'), 'shared_equal');
    // Revealing the identifier field and leaving it blank still lets the server choose the id.
    await user.click(within(dialog).getByRole('button', { name: 'Set the identifier myself' }));
    expect(within(dialog).getByLabelText('Identifier (optional)')).toHaveValue('');
    await user.click(within(dialog).getByRole('button', { name: 'Add account' }));

    await waitFor(() => expect(byMethod(calls, 'POST')).toHaveLength(1));
    const post = byMethod(calls, 'POST')[0];
    expect(post.url).toBe('/api/accounts');
    expect(post.headers.Authorization).toBe('Bearer primary-token');
    expect(post.body).toEqual({
      institution: 'Oakfield',
      label: 'Oakfield Saver',
      account_type: 'savings',
      owner: 'user_secondary',
      identifier_last4: '8802',
      default_claim_type: 'shared_equal',
    });
    expect(post.body).not.toHaveProperty('id');
    expect(post.body).not.toHaveProperty('billed_to');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const row = rowFor('Oakfield Saver');
    expect(within(row).getByText('acc_savings_oakfield')).toBeInTheDocument();
    expect(within(row).getByText('Savings')).toBeInTheDocument();
    expect(within(row).getByText('Sam')).toBeInTheDocument();
    expect(within(row).getByText('··8802')).toBeInTheDocument();
    expect(within(row).getByText('50/50')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit HSBC Premier' })).toBeInTheDocument();
    // The account dropdowns elsewhere read the config, so it is fetched again after the change.
    await waitFor(() => expect(configFetches(calls)).toBe(2));
  });

  it('sends the identifier only when one was typed', async () => {
    const user = userEvent.setup();
    const created = account({
      id: 'acc_savings_oakfield',
      institution: 'Oakfield',
      label: null,
      account_type: 'savings',
      identifier_last4: '8802',
      transaction_count: 0,
    });
    let list = [hsbc];
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method === 'GET' && url === '/api/accounts') return jsonResponse(list);
      if (method === 'POST' && url === '/api/accounts') {
        list = [...list, created];
        return jsonResponse(created, 201);
      }
      return undefined;
    });

    renderPanel();
    await screen.findByRole('button', { name: 'Edit HSBC Premier' });
    const dialog = await openAddDialog(user);
    await user.type(within(dialog).getByLabelText('Institution'), 'Oakfield');
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'savings');
    await user.type(within(dialog).getByLabelText('Last four digits'), '8802');
    await user.click(within(dialog).getByRole('button', { name: 'Set the identifier myself' }));
    await user.type(within(dialog).getByLabelText('Identifier (optional)'), 'acc_savings_oakfield');
    await user.click(within(dialog).getByRole('button', { name: 'Add account' }));

    await waitFor(() => expect(byMethod(calls, 'POST')).toHaveLength(1));
    expect(byMethod(calls, 'POST')[0].body).toEqual({
      id: 'acc_savings_oakfield',
      institution: 'Oakfield',
      account_type: 'savings',
      owner: 'user_primary',
      identifier_last4: '8802',
      default_claim_type: 'personal',
    });
    expect(await screen.findByRole('button', { name: 'Edit Oakfield Savings' })).toBeInTheDocument();
  });

  it('refuses to submit without an institution and the last four, and sends nothing', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/accounts') return jsonResponse([hsbc]);
      return undefined;
    });

    renderWithProviders(<AccountsPanel />);
    await screen.findByRole('button', { name: 'Edit HSBC Premier' });
    const dialog = await openAddDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Add account' }));

    expect(within(dialog).getByText('Enter the institution as printed on the statement.')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter the digits printed on the statement.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Institution')).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByLabelText('Last four digits')).toHaveAttribute('aria-invalid', 'true');
    expect(byMethod(calls, 'POST')).toHaveLength(0);

    // Typing into a field clears its complaint.
    await user.type(within(dialog).getByLabelText('Institution'), 'Oakfield');
    expect(within(dialog).queryByText('Enter the institution as printed on the statement.')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Enter the digits printed on the statement.')).toBeInTheDocument();
  });

  it('shows a 422 from the server inside the dialog and keeps it open', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method === 'GET' && url === '/api/accounts') return jsonResponse([hsbc]);
      if (method === 'POST' && url === '/api/accounts') {
        return jsonResponse(
          { detail: [{ loc: ['body', 'id'], msg: "String should match pattern '^acc_[a-z0-9_]+$'", type: 'string_pattern_mismatch' }] },
          422,
        );
      }
      return undefined;
    });

    renderPanel();
    await screen.findByRole('button', { name: 'Edit HSBC Premier' });
    const dialog = await openAddDialog(user);
    await user.type(within(dialog).getByLabelText('Institution'), 'Oakfield');
    await user.type(within(dialog).getByLabelText('Last four digits'), '8802');
    await user.click(within(dialog).getByRole('button', { name: 'Set the identifier myself' }));
    await user.type(within(dialog).getByLabelText('Identifier (optional)'), 'oakfield saver');
    await user.click(within(dialog).getByRole('button', { name: 'Add account' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent("id: String should match pattern '^acc_[a-z0-9_]+$'");
    expect(screen.getByRole('dialog', { name: 'Add account' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add account' })).toBeEnabled();
    // What was typed is still there to correct.
    expect(within(dialog).getByLabelText('Institution')).toHaveValue('Oakfield');
    expect(within(dialog).getByLabelText('Identifier (optional)')).toHaveValue('oakfield saver');
    expect(screen.queryByRole('button', { name: /^Edit Oakfield/ })).not.toBeInTheDocument();
    expect(configFetches(calls)).toBe(1);
  });

  it('edits an account and sends only the fields that changed', async () => {
    const user = userEvent.setup();
    let list = [hsbc, amexSupp];
    const { calls } = mockFetch(({ method, url, body }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method === 'GET' && url === '/api/accounts') return jsonResponse(list);
      if (method === 'PATCH' && url === '/api/accounts/acc_checking_hsbc') {
        const updated: AccountOut = { ...hsbc, ...(body as Partial<AccountOut>) };
        list = list.map((a) => (a.id === updated.id ? updated : a));
        return jsonResponse(updated);
      }
      return undefined;
    });

    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Edit HSBC Premier' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit HSBC Premier' });
    expect(dialog).toHaveTextContent('acc_checking_hsbc · 12 transactions');
    expect(within(dialog).getByLabelText('Label (optional)')).toHaveValue('HSBC Premier');
    expect(within(dialog).getByLabelText('Institution')).toHaveValue('HSBC');
    expect(within(dialog).getByLabelText('Type')).toHaveValue('checking');
    expect(within(dialog).getByLabelText('Owner')).toHaveValue('user_primary');
    expect(within(dialog).getByLabelText('Last four digits')).toHaveValue('4471');
    expect(within(dialog).getByLabelText('Default claim type')).toHaveValue('personal');
    expect(within(dialog).getByLabelText('Billed to')).toHaveValue('');
    // The identifier is immutable once created.
    expect(within(dialog).queryByRole('button', { name: 'Set the identifier myself' })).not.toBeInTheDocument();

    await user.clear(within(dialog).getByLabelText('Label (optional)'));
    await user.type(within(dialog).getByLabelText('Label (optional)'), 'HSBC Advance');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(byMethod(calls, 'PATCH')).toHaveLength(1));
    const patch = byMethod(calls, 'PATCH')[0];
    expect(patch.url).toBe('/api/accounts/acc_checking_hsbc');
    expect(patch.body).toEqual({ label: 'HSBC Advance' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const row = rowFor('HSBC Advance');
    expect(within(row).getByText('··4471')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit HSBC Premier' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Amex Supplementary card' })).toBeInTheDocument();
    await waitFor(() => expect(configFetches(calls)).toBe(2));
  });

  it('sends null to clear the label or the payer', async () => {
    const user = userEvent.setup();
    let list = [hsbc, amexSupp];
    const { calls } = mockFetch(({ method, url, body }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method === 'GET' && url === '/api/accounts') return jsonResponse(list);
      if (method === 'PATCH' && url.startsWith('/api/accounts/')) {
        const id = decodeURIComponent(url.slice('/api/accounts/'.length));
        const current = list.find((a) => a.id === id);
        if (!current) return undefined;
        const updated: AccountOut = { ...current, ...(body as Partial<AccountOut>) };
        list = list.map((a) => (a.id === id ? updated : a));
        return jsonResponse(updated);
      }
      return undefined;
    });

    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Edit HSBC Premier' }));
    let dialog = await screen.findByRole('dialog', { name: 'Edit HSBC Premier' });
    await user.clear(within(dialog).getByLabelText('Label (optional)'));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(byMethod(calls, 'PATCH')).toHaveLength(1));
    expect(byMethod(calls, 'PATCH')[0].body).toEqual({ label: null });
    // Without a label the row falls back to institution and type.
    expect(await screen.findByRole('button', { name: 'Edit HSBC Current' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Edit Amex Supplementary card' }));
    dialog = await screen.findByRole('dialog', { name: 'Edit Amex Supplementary card' });
    expect(within(dialog).getByLabelText('Billed to')).toHaveValue('user_primary');
    await user.selectOptions(within(dialog).getByLabelText('Billed to'), '');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(byMethod(calls, 'PATCH')).toHaveLength(2));
    expect(byMethod(calls, 'PATCH')[1].url).toBe('/api/accounts/acc_cc_amex_supp');
    expect(byMethod(calls, 'PATCH')[1].body).toEqual({ billed_to: null });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(within(rowFor('Amex Supplementary card')).getAllByRole('cell')[6]).toHaveTextContent('—'));
  });

  it('closes without a request when nothing was changed', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method === 'GET' && url === '/api/accounts') return jsonResponse([hsbc]);
      return undefined;
    });

    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Edit HSBC Premier' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit HSBC Premier' });
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(byMethod(calls, 'PATCH')).toHaveLength(0);
    expect(configFetches(calls)).toBe(1);
  });

  it('archives with is_active:false and restores with is_active:true', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url, body }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method === 'GET' && url === '/api/accounts') return jsonResponse([hsbc, virgin]);
      if (method === 'PATCH' && url === '/api/accounts/acc_checking_hsbc') {
        return jsonResponse({ ...hsbc, ...(body as Partial<AccountOut>) });
      }
      if (method === 'PATCH' && url === '/api/accounts/acc_cc_virgin') {
        return jsonResponse({ ...virgin, ...(body as Partial<AccountOut>) });
      }
      return undefined;
    });

    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Archive HSBC Premier' }));

    await waitFor(() => expect(within(rowFor('HSBC Premier')).getByText('Archived')).toBeInTheDocument());
    expect(byMethod(calls, 'PATCH')).toHaveLength(1);
    expect(byMethod(calls, 'PATCH')[0].url).toBe('/api/accounts/acc_checking_hsbc');
    expect(byMethod(calls, 'PATCH')[0].body).toEqual({ is_active: false });
    expect(screen.getByRole('button', { name: 'Restore HSBC Premier' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive HSBC Premier' })).not.toBeInTheDocument();
    await waitFor(() => expect(configFetches(calls)).toBe(2));

    await user.click(screen.getByRole('button', { name: 'Restore Virgin Money credit card' }));

    await waitFor(() => expect(within(rowFor('Virgin Money credit card')).getByText('Active')).toBeInTheDocument());
    expect(byMethod(calls, 'PATCH')).toHaveLength(2);
    expect(byMethod(calls, 'PATCH')[1].url).toBe('/api/accounts/acc_cc_virgin');
    expect(byMethod(calls, 'PATCH')[1].body).toEqual({ is_active: true });
    expect(screen.getByRole('button', { name: 'Archive Virgin Money credit card' })).toBeInTheDocument();
    // Only the two archive/restore changes were made: no list reload, one config refresh per change.
    expect(calls.filter((c) => c.method === 'GET' && c.url === '/api/accounts')).toHaveLength(1);
    await waitFor(() => expect(configFetches(calls)).toBe(3));
  });

  it('blocks deleting an account with transactions and deletes a fresh one after confirmation', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method === 'GET' && url === '/api/accounts') return jsonResponse([hsbc, amexSupp]);
      if (method === 'DELETE' && url === '/api/accounts/acc_cc_amex_supp') return jsonResponse(undefined, 204);
      return undefined;
    });

    renderPanel();
    const blocked = await screen.findByRole('button', { name: 'Delete HSBC Premier' });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAttribute('title', HAS_TRANSACTIONS_TITLE);

    const fresh = screen.getByRole('button', { name: 'Delete Amex Supplementary card' });
    expect(fresh).toBeEnabled();
    expect(fresh).toHaveAttribute('title', 'Delete Amex Supplementary card');
    await user.click(fresh);
    // Nothing is sent until the inline confirmation.
    expect(byMethod(calls, 'DELETE')).toHaveLength(0);
    const group = screen.getByRole('group', { name: 'Delete Amex Supplementary card?' });
    await user.click(within(group).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(byMethod(calls, 'DELETE')).toHaveLength(1));
    expect(byMethod(calls, 'DELETE')[0].url).toBe('/api/accounts/acc_cc_amex_supp');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit Amex Supplementary card' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Edit HSBC Premier' })).toBeInTheDocument();
    await waitFor(() => expect(configFetches(calls)).toBe(2));
  });

  it('shows the server’s refusal beside the row when a delete is refused', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method === 'GET' && url === '/api/accounts') return jsonResponse([hsbc, amexSupp]);
      if (method === 'DELETE') return jsonResponse({ detail: 'account acc_cc_amex_supp has uploads; archive it instead' }, 409);
      return undefined;
    });

    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Delete Amex Supplementary card' }));
    const group = screen.getByRole('group', { name: 'Delete Amex Supplementary card?' });
    await user.click(within(group).getByRole('button', { name: 'Confirm' }));

    const row = rowFor('Amex Supplementary card');
    expect(await within(row).findByRole('alert')).toHaveTextContent('account acc_cc_amex_supp has uploads; archive it instead');
    expect(screen.getByRole('button', { name: 'Edit Amex Supplementary card' })).toBeInTheDocument();
    // Back to the plain button, ready for another go.
    expect(screen.getByRole('button', { name: 'Delete Amex Supplementary card' })).toBeEnabled();
    expect(configFetches(calls)).toBe(1);
  });
});
