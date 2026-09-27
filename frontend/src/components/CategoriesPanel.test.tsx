import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS_MESSAGE, type CategoriesOut } from '../api';
import { ConfigProvider } from '../config/ConfigProvider';
import { inUseTitle } from '../lib/categories';
import { categories } from '../test/fixtures';
import { fixtureConfig, jsonResponse, mockFetch, renderWithProviders, type RecordedCall } from '../test/utils';
import { ADD_HINT, CategoriesPanel, DUPLICATE_MESSAGE, RENAME_NOTE } from './CategoriesPanel';

const URL = '/api/settings/categories';
const UNUSED = { transactions: 0, memory: 0, rules: 0 };

/** GET answers the current document; PUT replaces the list (keeping each name's usage); POST /rename renames in place. */
function mockCategories(initial: CategoriesOut) {
  let current = initial;
  return mockFetch(({ method, url, body }) => {
    if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
    if (method === 'GET' && url === URL) return jsonResponse(current);
    if (method === 'PUT' && url === URL) {
      const names = (body as { categories: string[] }).categories;
      current = {
        categories: names.map((name) => current.categories.find((c) => c.name === name) ?? { name, in_use: UNUSED }),
        stored: true,
      };
      return jsonResponse(current);
    }
    if (method === 'POST' && url === `${URL}/rename`) {
      const { from, to } = body as { from: string; to: string };
      current = { categories: current.categories.map((c) => (c.name === from ? { ...c, name: to } : c)), stored: true };
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
      <CategoriesPanel />
    </ConfigProvider>,
  );
  return screen.findByRole('button', { name: 'Rename Bills:Water' });
}

/** The list item holding a category, found by a control that names it. */
function rowFor(name: string): HTMLElement {
  const row = screen.getByRole('button', { name: `Move ${name} up` }).closest('li');
  if (!row) throw new Error(`No row for ${name}`);
  return row;
}

const groupHeadings = () => screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);

describe('<CategoriesPanel />', () => {
  it('lists the categories in menu order, grouped by the part before the colon, with what uses each', async () => {
    const { calls } = mockCategories(categories());

    await renderPanel();

    const load = calls.find((c) => c.url === URL);
    expect(load?.headers.Authorization).toBe('Bearer primary-token');
    // Bare names need no heading; Uncategorized reads the British way.
    expect(groupHeadings()).toEqual(['Bills', 'Transport']);
    expect(within(rowFor('Bills:Water')).getByText('Water')).toBeInTheDocument();
    expect(within(rowFor('Bills:Water')).getByText('12 transactions · 3 merchants · 1 rule')).toBeInTheDocument();
    expect(within(rowFor('Bills:Energy')).getByText('1 rule')).toBeInTheDocument();
    expect(within(rowFor('Groceries')).getByText('40 transactions · 6 merchants')).toBeInTheDocument();
    expect(within(rowFor('Dining')).getByText('unused')).toBeInTheDocument();
    expect(within(rowFor('Transport:Taxi')).getByText('Taxi')).toBeInTheDocument();
    // Its controls use the British spelling too.
    const uncategorised = rowFor('Uncategorised');
    expect(within(uncategorised).getByText('Uncategorised')).toBeInTheDocument();
    expect(within(uncategorised).getByText('Always kept')).toBeInTheDocument();
    expect(within(uncategorised).queryByRole('button', { name: /Rename/ })).not.toBeInTheDocument();
    expect(within(uncategorised).queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();

    // Removing is only offered for a category nothing uses.
    const removeWater = screen.getByRole('button', { name: 'Remove Bills:Water' });
    expect(removeWater).toBeDisabled();
    expect(removeWater).toHaveAttribute('title', inUseTitle({ transactions: 12, memory: 3, rules: 1 }));
    expect(removeWater).toHaveAttribute('title', 'Still in use (12 transactions · 3 merchants · 1 rule); move those to another category first.');
    expect(screen.getByRole('button', { name: 'Remove Bills:Energy' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Dining' })).toBeEnabled();

    // The ends cannot move further.
    expect(screen.getByRole('button', { name: 'Move Bills:Water up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Bills:Water down' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Move Uncategorised down' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Uncategorised up' })).toBeEnabled();

    expect(screen.getByLabelText('New category')).toHaveAccessibleDescription(ADD_HINT);
    expect(screen.getByRole('button', { name: 'Add category' })).toBeDisabled();
    expect(screen.queryByText(CONFIG_DEFAULTS_MESSAGE)).not.toBeInTheDocument();
  });

  it('says when nothing has been saved yet', async () => {
    mockCategories(categories({ stored: false }));

    await renderPanel();

    expect(screen.getByText(CONFIG_DEFAULTS_MESSAGE)).toBeInTheDocument();
  });

  it('renames a category everywhere through the rename endpoint and refreshes the config', async () => {
    const user = userEvent.setup();
    const { calls } = mockCategories(categories());

    await renderPanel();
    await user.click(screen.getByRole('button', { name: 'Rename Bills:Water' }));

    const input = screen.getByLabelText('New name for Bills:Water');
    expect(input).toHaveValue('Bills:Water');
    expect(input).toHaveFocus();
    expect(input).toHaveAccessibleDescription(RENAME_NOTE);
    // Unchanged, so nothing to save yet.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    // Nor is a blank name.
    await user.clear(input);
    await user.type(input, '   ');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(input);
    await user.type(input, 'Bills:Tap water{Enter}');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename Bills:Tap water' })).toBeInTheDocument());
    const rename = calls.filter((c) => c.method === 'POST');
    expect(rename).toHaveLength(1);
    expect(rename[0].url).toBe(`${URL}/rename`);
    expect(rename[0].body).toEqual({ from: 'Bills:Water', to: 'Bills:Tap water' });
    expect(within(rowFor('Bills:Tap water')).getByText('Tap water')).toBeInTheDocument();
    expect(within(rowFor('Bills:Tap water')).getByText('12 transactions · 3 merchants · 1 rule')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Renamed Bills:Water to Bills:Tap water everywhere.');
    expect(screen.queryByLabelText(/New name for/)).not.toBeInTheDocument();
    await waitFor(() => expect(configFetches(calls)).toBe(2));

    // Escape puts the row back without a request.
    await user.click(screen.getByRole('button', { name: 'Rename Bills:Energy' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByLabelText('New name for Bills:Energy')).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('shows the server’s refusal of a rename beside the row and keeps the editor open', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method === 'GET' && url === URL) return jsonResponse(categories());
      if (method === 'POST' && url === `${URL}/rename`) return jsonResponse({ detail: "category 'Dining' already exists" }, 409);
      return undefined;
    });

    await renderPanel();
    await user.click(screen.getByRole('button', { name: 'Rename Bills:Energy' }));
    const input = screen.getByLabelText('New name for Bills:Energy');
    await user.clear(input);
    await user.type(input, 'Dining');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent("category 'Dining' already exists");
    expect(screen.getByLabelText('New name for Bills:Energy')).toHaveValue('Dining');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('removes an unused category after confirmation, sending the whole list without it', async () => {
    const user = userEvent.setup();
    const { calls } = mockCategories(categories());

    await renderPanel();
    await user.click(screen.getByRole('button', { name: 'Remove Dining' }));
    expect(puts(calls)).toHaveLength(0);
    await user.click(within(screen.getByRole('group', { name: 'Remove Dining?' })).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Move Dining up' })).not.toBeInTheDocument());
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0].body).toEqual({ categories: ['Bills:Water', 'Bills:Energy', 'Groceries', 'Transport:Taxi', 'Uncategorized'] });
    expect(screen.getByRole('status')).toHaveTextContent('Removed Dining.');
    await waitFor(() => expect(configFetches(calls)).toBe(2));
  });

  it('shows a 409 for a removal the server refuses beside the row', async () => {
    const user = userEvent.setup();
    const detail = "category 'Transport:Taxi' is still used by 2 transactions, 0 remembered merchants and 0 rules";
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method === 'GET' && url === URL) return jsonResponse(categories());
      if (method === 'PUT' && url === URL) return jsonResponse({ detail }, 409);
      return undefined;
    });

    await renderPanel();
    await user.click(screen.getByRole('button', { name: 'Remove Transport:Taxi' }));
    await user.click(within(screen.getByRole('group', { name: 'Remove Transport:Taxi?' })).getByRole('button', { name: 'Confirm' }));

    const row = rowFor('Transport:Taxi');
    expect(await within(row).findByRole('alert')).toHaveTextContent(detail);
    expect(screen.getByRole('button', { name: 'Remove Transport:Taxi' })).toBeEnabled();
    expect(configFetches(calls)).toBe(1);
  });

  it('moves a category up or down and sends the new order, showing a split group twice', async () => {
    const user = userEvent.setup();
    const { calls } = mockCategories(categories());

    await renderPanel();
    await user.click(screen.getByRole('button', { name: 'Move Groceries up' }));

    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toEqual({
      categories: ['Bills:Water', 'Groceries', 'Bills:Energy', 'Dining', 'Transport:Taxi', 'Uncategorized'],
    });
    // The flat order is what the menus show, so Bills now appears in two runs rather than being regrouped.
    await waitFor(() => expect(groupHeadings()).toEqual(['Bills', 'Bills', 'Transport']));
    await waitFor(() => expect(configFetches(calls)).toBe(2));

    await user.click(screen.getByRole('button', { name: 'Move Groceries down' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(puts(calls)[1].body).toEqual({
      categories: ['Bills:Water', 'Bills:Energy', 'Groceries', 'Dining', 'Transport:Taxi', 'Uncategorized'],
    });
    await waitFor(() => expect(groupHeadings()).toEqual(['Bills', 'Transport']));
  });

  it('adds a category to the end of the list, and refuses a duplicate before asking the server', async () => {
    const user = userEvent.setup();
    const { calls } = mockCategories(categories());

    await renderPanel();
    const input = screen.getByLabelText('New category');
    await user.type(input, 'Bills:Phone');
    await user.click(screen.getByRole('button', { name: 'Add category' }));

    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toEqual({
      categories: ['Bills:Water', 'Bills:Energy', 'Groceries', 'Dining', 'Transport:Taxi', 'Uncategorized', 'Bills:Phone'],
    });
    expect(await screen.findByRole('button', { name: 'Move Bills:Phone up' })).toBeInTheDocument();
    expect(within(rowFor('Bills:Phone')).getByText('Phone')).toBeInTheDocument();
    expect(within(rowFor('Bills:Phone')).getByText('unused')).toBeInTheDocument();
    expect(input).toHaveValue('');
    expect(screen.getByRole('status')).toHaveTextContent('Added Bills:Phone.');
    await waitFor(() => expect(configFetches(calls)).toBe(2));

    await user.type(input, 'Dining');
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    expect(screen.getByText(DUPLICATE_MESSAGE)).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(DUPLICATE_MESSAGE);
    expect(puts(calls)).toHaveLength(1);
    // Typing again clears the complaint.
    await user.type(input, ' out');
    expect(screen.queryByText(DUPLICATE_MESSAGE)).not.toBeInTheDocument();

    // The server ignores case when it compares names, and so does the form.
    await user.clear(input);
    await user.type(input, '  bills:water ');
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    expect(screen.getByText(DUPLICATE_MESSAGE)).toBeInTheDocument();
    expect(puts(calls)).toHaveLength(1);
  });

  it('shows the server’s 422 for a new category under the input', async () => {
    const user = userEvent.setup();
    const detail = 'category 7 is longer than 128 characters';
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method === 'GET' && url === URL) return jsonResponse(categories());
      if (method === 'PUT' && url === URL) return jsonResponse({ detail }, 422);
      return undefined;
    });

    await renderPanel();
    const input = screen.getByLabelText('New category');
    await user.type(input, 'Bills:Phone');
    await user.click(screen.getByRole('button', { name: 'Add category' }));

    await waitFor(() => expect(input).toHaveAccessibleDescription(detail));
    expect(input).toHaveValue('Bills:Phone');
    expect(screen.queryByRole('button', { name: 'Move Bills:Phone up' })).not.toBeInTheDocument();
  });

  it('shows a load error with a retry that fetches again', async () => {
    const user = userEvent.setup();
    let failed = false;
    const { calls } = mockFetch(({ method, url }) => {
      if (method !== 'GET' || url !== URL) return undefined;
      if (failed) return jsonResponse(categories());
      failed = true;
      return jsonResponse({ detail: 'database unavailable' }, 500);
    });

    renderWithProviders(<CategoriesPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent('database unavailable');
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('button', { name: 'Rename Bills:Water' })).toBeInTheDocument();
    expect(calls.filter((c) => c.url === URL)).toHaveLength(2);
  });
});
