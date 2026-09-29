import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { writeSession, type AppConfig, type Session } from '../api';
import { AuthContext } from '../auth/AuthContext';
import { ConfigContext, ReloadConfigContext } from '../config/ConfigContext';
import { fixtureConfig, jsonResponse, mockFetch, primarySession, secondarySession, type RecordedCall } from '../test/utils';
import { CategoryPicker } from './CategoryPicker';

const config: AppConfig = {
  ...fixtureConfig,
  categories: ['Housing:Mortgage', 'Housing:Council tax', 'Groceries', 'Dining', 'Bills:Water', 'Bills:Energy', 'Transport:Taxi', 'Uncategorized'],
  category_emojis: { Housing: '🏠', Groceries: '🛒', Bills: '💡' },
};

const SUGGESTIONS = '/api/categories/suggestions?merchant=Ocado&limit=3';

interface Options {
  value?: string;
  session?: Session;
  allowAdd?: boolean;
  merchant?: string | null;
  reload?: () => Promise<void>;
}

/** The picker in a row that keeps what was picked, under a static config and a stub reload. */
function renderPicker({ value = 'Groceries', session = primarySession, allowAdd, merchant = 'Ocado', reload }: Options = {}) {
  const onChange = vi.fn();
  const reloadConfig = reload ?? vi.fn(() => Promise.resolve());
  writeSession(session);
  function Row() {
    const [current, setCurrent] = useState(value);
    return (
      <>
        <button type="button">Before</button>
        <CategoryPicker
          label="Category for Ocado"
          merchant={merchant}
          allowAdd={allowAdd}
          value={current}
          onChange={(next) => {
            onChange(next);
            setCurrent(next);
          }}
        />
        <button type="button">After</button>
      </>
    );
  }
  render(
    <AuthContext.Provider value={{ session, login: vi.fn(), logout: vi.fn() }}>
      <ConfigContext.Provider value={config}>
        <ReloadConfigContext.Provider value={reloadConfig}>
          <Row />
        </ReloadConfigContext.Provider>
      </ConfigContext.Provider>
    </AuthContext.Provider>,
  );
  return { onChange, reloadConfig, button: screen.getByRole('button', { name: 'Category for Ocado' }) };
}

const listbox = () => screen.getByRole('listbox', { name: 'Categories' });
const search = () => screen.getByRole('combobox', { name: 'Search categories' });
const optionTexts = () =>
  within(listbox())
    .getAllByRole('option')
    .map((o) => o.textContent);
const suggestionCalls = (calls: RecordedCall[]) => calls.filter((c) => c.url.startsWith('/api/categories/suggestions'));

describe('<CategoryPicker />', () => {
  it('reads like the select it replaces: the emoji, then "Group › Name", with the full label as a tooltip', () => {
    mockFetch(() => undefined);
    const { button } = renderPicker({ value: 'Housing:Mortgage' });

    expect(button).toHaveTextContent('🏠 Housing › Mortgage');
    expect(button).toHaveAttribute('title', '🏠 Housing › Mortgage');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-haspopup', 'listbox');
    // The name stays the select's label; the value is its description.
    expect(button).toHaveAccessibleName('Category for Ocado');
    expect(button).toHaveAccessibleDescription('Housing › Mortgage');
  });

  it('shows a bare name with its own emoji, and no emoji where the group has none', () => {
    mockFetch(() => undefined);
    renderPicker({ value: 'Groceries' });
    expect(screen.getByRole('button', { name: 'Category for Ocado' })).toHaveTextContent('🛒 Groceries');
  });

  it('opens a search box wired to a grouped listbox, the current value ticked', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    const { button } = renderPicker({ value: 'Bills:Water' });

    await user.click(button);

    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(search()).toHaveFocus();
    expect(search()).toHaveAttribute('aria-expanded', 'true');
    expect(search()).toHaveAttribute('aria-controls', listbox().id);
    // The highlight starts on the current value.
    const active = document.getElementById(search().getAttribute('aria-activedescendant') ?? '');
    expect(active).toHaveTextContent('Water');
    expect(within(listbox()).getByRole('group', { name: 'Housing' })).toBeInTheDocument();
    const bills = within(listbox()).getByRole('group', { name: 'Bills' });
    // Under a group header the option is the plain leaf name.
    expect(within(bills).getByRole('option', { name: 'Water' })).toHaveAttribute('aria-selected', 'true');
    expect(within(bills).getByRole('option', { name: 'Energy' })).toHaveAttribute('aria-selected', 'false');
    // Uncategorised is still offered, last and labelled as ever.
    expect(optionTexts().slice(-1)).toEqual(['Uncategorised']);
  });

  it('filters as you type, tolerant of case and separators, best match first', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    const { button } = renderPicker();

    await user.click(button);
    await user.type(search(), 'bills');
    expect(optionTexts()).toEqual(['💡Bills › Water', '💡Bills › Energy']);

    await user.clear(search());
    await user.type(search(), 'hou mor');
    expect(optionTexts()[0]).toBe('🏠Housing › Mortgage');

    await user.clear(search());
    await user.type(search(), 'GRO');
    expect(optionTexts()[0]).toBe('🛒Groceries');

    await user.clear(search());
    await user.type(search(), 'housing:council');
    expect(optionTexts()[0]).toBe('🏠Housing › Council tax');
  });

  it('moves with the arrow keys and picks with Enter, returning focus to the button', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    const { button, onChange } = renderPicker();

    await user.click(button);
    await user.type(search(), 'bills');
    await user.keyboard('{ArrowDown}');
    expect(document.getElementById(search().getAttribute('aria-activedescendant') ?? '')).toHaveTextContent('Bills › Energy');
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowDown}');
    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenCalledWith('Bills:Energy');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    expect(button).toHaveTextContent('💡 Bills › Energy');
  });

  it('opens from the keyboard, and typing on the closed button starts a search', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    const { button } = renderPicker();

    button.focus();
    await user.keyboard('{ArrowDown}');
    expect(search()).toHaveFocus();
    await user.keyboard('{Escape}');

    await user.keyboard('d');
    expect(search()).toHaveValue('d');
    expect(optionTexts()[0]).toBe('Dining');
  });

  it('closes on Escape with focus back on the button, and on Tab moving on from it', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    const { button, onChange } = renderPicker();

    await user.click(button);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await user.click(button);
    await user.tab();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes on a click elsewhere without choosing anything', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    const { button, onChange } = renderPicker();

    await user.click(button);
    await user.click(screen.getByRole('button', { name: 'Before' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('opens below the button, or above it when there is not room below', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    const { button } = renderPicker();
    const rect = (top: number) => ({ top, bottom: top + 32, left: 40, right: 216, width: 176, height: 32, x: 40, y: top, toJSON: () => ({}) });

    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(rect(100));
    await user.click(button);
    let popover = listbox().parentElement as HTMLElement;
    expect(popover.style.top).toBe('136px');
    expect(popover.style.bottom).toBe('');
    expect(popover.style.maxHeight).toBe('320px');
    // At least 16rem wide, however narrow the button.
    expect(popover.style.width).toBe('256px');
    await user.keyboard('{Escape}');

    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(rect(window.innerHeight - 60));
    await user.click(button);
    popover = listbox().parentElement as HTMLElement;
    expect(popover.style.top).toBe('');
    expect(popover.style.bottom).toBe('64px');
    // Rendered into the page body, so no table's overflow can clip it.
    expect(popover.parentElement).toBe(document.body);
  });

  it('picks with the mouse', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    const { button, onChange } = renderPicker();

    await user.click(button);
    await user.click(within(listbox()).getByRole('option', { name: 'Mortgage' }));
    expect(onChange).toHaveBeenCalledWith('Housing:Mortgage');
  });

  it('suggests the merchant’s past categories, then the most used, once each and only ones that exist', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ url }) => {
      if (url === SUGGESTIONS) {
        return jsonResponse({
          merchant: [
            { category: 'Groceries', count: 9 },
            { category: 'Gone:Away', count: 3 },
            { category: 'Dining', count: 1 },
          ],
          frequent: [
            { category: 'Groceries', count: 40 },
            { category: 'Bills:Water', count: 12 },
            { category: 'Transport:Taxi', count: 8 },
            { category: 'Housing:Mortgage', count: 6 },
            { category: 'Bills:Energy', count: 5 },
          ],
        });
      }
      return undefined;
    });
    const { button } = renderPicker({ value: 'Dining' });

    await user.click(button);
    const suggested = await within(listbox()).findByRole('group', { name: 'Suggested' });
    expect(within(suggested).getAllByRole('option').map((o) => o.textContent)).toEqual(['🛒Groceries', 'Dining']);
    const frequent = within(listbox()).getByRole('group', { name: 'Most used' });
    expect(within(frequent).getAllByRole('option').map((o) => o.textContent)).toEqual([
      '💡Bills › Water',
      'Transport › Taxi',
      '🏠Housing › Mortgage',
    ]);
    expect(within(suggested).getByRole('option', { name: 'Dining' })).toHaveAttribute('aria-selected', 'true');

    // Typing replaces the shortcuts with the results.
    await user.type(search(), 'wat');
    expect(within(listbox()).queryByRole('group', { name: 'Suggested' })).not.toBeInTheDocument();

    // Asked once per merchant for the session, however often the menu opens.
    await user.keyboard('{Escape}');
    await user.click(button);
    await within(listbox()).findByRole('group', { name: 'Suggested' });
    expect(suggestionCalls(calls)).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe('Bearer primary-token');
  });

  it('carries on without shortcuts when the suggestions cannot be had, and does not ask again', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ url }) => (url === SUGGESTIONS ? jsonResponse({ detail: 'boom' }, 500) : undefined));
    const first = renderPicker();

    await user.click(first.button);
    await waitFor(() => expect(suggestionCalls(calls)).toHaveLength(1));
    // Let the failed request settle, then the list is just the categories.
    await act(async () => {});
    expect(within(listbox()).queryByRole('group', { name: 'Suggested' })).not.toBeInTheDocument();
    expect(within(listbox()).getByRole('option', { name: 'Mortgage' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(first.button);
    expect(suggestionCalls(calls)).toHaveLength(1);
  });

  it('asks nothing without a merchant (a rule)', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(() => undefined);
    const { button } = renderPicker({ merchant: null });
    await user.click(button);
    expect(listbox()).toBeInTheDocument();
    expect(suggestionCalls(calls)).toHaveLength(0);
  });

  it('asks nothing for the secondary user', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(() => undefined);
    const { button } = renderPicker({ session: secondarySession });
    await user.click(button);
    expect(suggestionCalls(calls)).toHaveLength(0);
  });

  it('adds a category typed as "Group:Name" beside its group, reloads the config and picks it', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url, body }) =>
      method === 'PUT' && url === '/api/settings/categories'
        ? jsonResponse({ categories: (body as { categories: string[] }).categories.map((name) => ({ name, in_use: {} })), stored: true })
        : undefined,
    );
    const { button, onChange, reloadConfig } = renderPicker();

    await user.click(button);
    await user.type(search(), 'Housing › Rent');
    const add = within(listbox()).getByRole('option', { name: 'Add “Rent” under Housing' });
    await user.click(add);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('Housing:Rent'));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({
      categories: ['Housing:Mortgage', 'Housing:Council tax', 'Housing:Rent', 'Groceries', 'Dining', 'Bills:Water', 'Bills:Energy', 'Transport:Taxi', 'Uncategorized'],
    });
    expect(reloadConfig).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('adds a bare name ungrouped from the keyboard, and shows a refusal inside the menu', async () => {
    const user = userEvent.setup();
    let refuse = true;
    const { calls } = mockFetch(({ method }) => {
      if (method !== 'PUT') return undefined;
      return refuse ? jsonResponse({ detail: 'category name too long' }, 422) : jsonResponse({ categories: [], stored: true });
    });
    const { button, onChange } = renderPicker();

    await user.click(button);
    await user.type(search(), 'Takeaway');
    expect(optionTexts()).toEqual(['Add “Takeaway”']);
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent('category name too long');
    expect(listbox()).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    refuse = false;
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('Takeaway'));
    expect(calls.filter((c) => c.method === 'PUT').slice(-1)[0]?.body).toEqual({
      categories: [...config.categories.slice(0, -1), 'Takeaway', 'Uncategorized'],
    });
  });

  it('offers nothing to add for a name that exists', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    const { button } = renderPicker();
    await user.click(button);
    await user.type(search(), 'bills › water');
    expect(optionTexts()).toEqual(['💡Bills › Water']);
  });

  it('offers nothing to add where the parent says not to', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    const noAdd = renderPicker({ allowAdd: false });
    await user.click(noAdd.button);
    await user.type(search(), 'Takeaway');
    expect(within(listbox()).queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByText('No categories match.')).toBeInTheDocument();
  });

  it('offers nothing to add to the secondary user', async () => {
    const user = userEvent.setup();
    mockFetch(() => undefined);
    const { button } = renderPicker({ session: secondarySession });
    await user.click(button);
    await user.type(search(), 'Takeaway');
    expect(within(listbox()).queryByRole('option')).not.toBeInTheDocument();
    expect(search()).toHaveAttribute('placeholder', 'Search…');
  });
});
