import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { LEAVE_UNSAVED_PROMPT } from '../hooks/useUnsavedChanges';
import { NavLinks } from '../components/NavLinks';
import { account, aiSettings, categories, household, rules, systemInfo } from '../test/fixtures';
import { fixtureConfig, jsonResponse, mockFetch, renderWithProviders, type RecordedCall } from '../test/utils';
import { SettingsPage } from './SettingsPage';

/** Shows where the router is, since a MemoryRouter never touches window.location. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function urls(calls: RecordedCall[]): string[] {
  return calls.map((c) => c.url);
}

const hsbc = account({ id: 'acc_checking_hsbc', transaction_count: 12 });

describe('<SettingsPage />', () => {
  it('opens on the Accounts tab by default', async () => {
    const { calls } = mockFetch(({ method, url }) => (method === 'GET' && url === '/api/accounts' ? jsonResponse([hsbc]) : undefined));

    renderWithProviders(<SettingsPage />, { route: '/settings' });

    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    const tabs = screen.getByRole('tablist', { name: 'Settings sections' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Accounts',
      'Household',
      'Categories',
      'Rules',
      'AI',
      'System',
    ]);
    expect(within(tabs).getByRole('tab', { name: 'Accounts' })).toHaveAttribute('aria-selected', 'true');
    for (const name of ['Household', 'Categories', 'Rules', 'AI', 'System']) {
      expect(within(tabs).getByRole('tab', { name })).toHaveAttribute('aria-selected', 'false');
    }
    expect(screen.getByRole('tabpanel', { name: 'Accounts' })).toBeInTheDocument();

    expect(await screen.findByRole('button', { name: 'Edit HSBC Premier' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Accounts' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Version' })).not.toBeInTheDocument();
    // Only the Accounts tab's data is requested.
    expect(urls(calls)).toEqual(['/api/accounts']);
  });

  it('falls back to Accounts for a tab it does not know', async () => {
    const { calls } = mockFetch(({ method, url }) => (method === 'GET' && url === '/api/accounts' ? jsonResponse([hsbc]) : undefined));

    renderWithProviders(<SettingsPage />, { route: '/settings?tab=budgets' });

    expect(screen.getByRole('tab', { name: 'Accounts' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('button', { name: 'Edit HSBC Premier' })).toBeInTheDocument();
    expect(urls(calls)).toEqual(['/api/accounts']);
  });

  it('renders the Household tab from ?tab=household', async () => {
    const { calls } = mockFetch(({ method, url }) =>
      method === 'GET' && url === '/api/settings/household' ? jsonResponse(household()) : undefined,
    );

    renderWithProviders(<SettingsPage />, { route: '/settings?tab=household' });

    expect(screen.getByRole('tab', { name: 'Household' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Accounts' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel', { name: 'Household' })).toBeInTheDocument();

    expect(await screen.findByRole('region', { name: 'Alex' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Sam' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'How shared costs are split' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Settlement' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Currency' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Accounts' })).not.toBeInTheDocument();
    expect(urls(calls)).toEqual(['/api/settings/household']);
  });

  it('renders the Categories tab from ?tab=categories', async () => {
    const { calls } = mockFetch(({ method, url }) =>
      method === 'GET' && url === '/api/settings/categories' ? jsonResponse(categories()) : undefined,
    );

    renderWithProviders(<SettingsPage />, { route: '/settings?tab=categories' });

    expect(screen.getByRole('tab', { name: 'Categories' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Categories' })).toBeInTheDocument();

    expect(await screen.findByRole('button', { name: 'Rename Bills:Water' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Categories' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add category' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Accounts' })).not.toBeInTheDocument();
    expect(urls(calls)).toEqual(['/api/settings/categories']);
  });

  it('renders the Rules tab from ?tab=rules', async () => {
    const { calls } = mockFetch(({ method, url }) => (method === 'GET' && url === '/api/settings/rules' ? jsonResponse(rules()) : undefined));

    renderWithProviders(<SettingsPage />, { route: '/settings?tab=rules' });

    expect(screen.getByRole('tab', { name: 'Rules' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Rules' })).toBeInTheDocument();

    expect(await screen.findByLabelText('Pattern for rule 1')).toHaveValue('(?i)AQUANORTH\\s*WATER');
    expect(screen.getByRole('region', { name: 'Rules' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Card payments' })).toBeInTheDocument();
    expect(screen.getByLabelText('Statement description')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Accounts' })).not.toBeInTheDocument();
    expect(urls(calls)).toEqual(['/api/settings/rules']);
  });

  it('renders the System tab from ?tab=system', async () => {
    const { calls } = mockFetch(({ method, url }) => (method === 'GET' && url === '/api/system' ? jsonResponse(systemInfo()) : undefined));

    renderWithProviders(<SettingsPage />, { route: '/settings?tab=system' });

    expect(screen.getByRole('tab', { name: 'System' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Accounts' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel', { name: 'System' })).toBeInTheDocument();

    expect(await screen.findByText('Up to date')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Version' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Update' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Accounts' })).not.toBeInTheDocument();
    expect(urls(calls)).toEqual(['/api/system']);
  });

  it('renders the AI tab from ?tab=ai', async () => {
    const { calls } = mockFetch(({ method, url }) => (method === 'GET' && url === '/api/ai' ? jsonResponse(aiSettings()) : undefined));

    renderWithProviders(<SettingsPage />, { route: '/settings?tab=ai' });

    expect(screen.getByRole('tab', { name: 'AI' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Accounts' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel', { name: 'AI' })).toBeInTheDocument();

    expect(await screen.findByRole('switch', { name: 'Use AI' })).toBeChecked();
    expect(screen.getByRole('region', { name: 'AI' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Proxy' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Which model does what' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Fine-tuning' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Accounts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Version' })).not.toBeInTheDocument();
    expect(urls(calls)).toEqual(['/api/ai']);
  });

  it('puts the chosen tab in the URL', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/accounts') return jsonResponse([hsbc]);
      if (method === 'GET' && url === '/api/settings/household') return jsonResponse(household());
      if (method === 'GET' && url === '/api/settings/categories') return jsonResponse(categories());
      if (method === 'GET' && url === '/api/settings/rules') return jsonResponse(rules());
      if (method === 'GET' && url === '/api/ai') return jsonResponse(aiSettings());
      if (method === 'GET' && url === '/api/system') return jsonResponse(systemInfo());
      return undefined;
    });

    renderWithProviders(
      <>
        <SettingsPage />
        <LocationProbe />
      </>,
      { route: '/settings' },
    );
    await screen.findByRole('button', { name: 'Edit HSBC Premier' });
    expect(screen.getByTestId('location')).toHaveTextContent('/settings');

    await user.click(screen.getByRole('tab', { name: 'System' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=system');
    expect(screen.getByRole('tab', { name: 'System' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Up to date')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Version' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Accounts' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Accounts' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=accounts');
    expect(await screen.findByRole('button', { name: 'Edit HSBC Premier' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Accounts' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Version' })).not.toBeInTheDocument();

    // The arrow keys move between tabs too, and select as they go, through the new tabs in order.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=household');
    expect(screen.getByRole('tab', { name: 'Household' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Household' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('region', { name: 'How shared costs are split' })).toBeInTheDocument();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=categories');
    expect(screen.getByRole('tab', { name: 'Categories' })).toHaveFocus();
    expect(await screen.findByRole('button', { name: 'Rename Bills:Water' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'How shared costs are split' })).not.toBeInTheDocument();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=rules');
    expect(screen.getByRole('tab', { name: 'Rules' })).toHaveFocus();
    expect(await screen.findByRole('region', { name: 'Card payments' })).toBeInTheDocument();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=ai');
    expect(screen.getByRole('tab', { name: 'AI' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'AI' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('switch', { name: 'Use AI' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Card payments' })).not.toBeInTheDocument();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=system');
    expect(screen.getByRole('tab', { name: 'System' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'System' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('region', { name: 'AI' })).not.toBeInTheDocument();

    // Home goes back to the start; ArrowLeft from there wraps to the end.
    await user.keyboard('{Home}');
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=accounts');
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=system');
  });

  it('asks before a tab switch or a page unload would lose unsaved edits', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/settings/household') return jsonResponse(household());
      if (method === 'GET' && url === '/api/settings/rules') return jsonResponse(rules());
      return undefined;
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };

    renderWithProviders(
      <>
        <SettingsPage />
        <LocationProbe />
      </>,
      { route: '/settings?tab=household' },
    );
    const alex = await screen.findByRole('region', { name: 'Alex' });

    // Nothing edited: no question either way.
    expect(unload()).toBe(false);
    await user.click(screen.getByRole('tab', { name: 'Rules' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=rules');
    await user.click(screen.getByRole('tab', { name: 'Household' }));
    const name = within(await screen.findByRole('region', { name: 'Alex' })).getByLabelText('Name');
    expect(alex).not.toBeInTheDocument();

    await user.type(name, 'andra');
    expect(unload()).toBe(true);

    // Cancelling keeps the tab and the edit.
    await user.click(screen.getByRole('tab', { name: 'Rules' }));
    expect(confirm).toHaveBeenCalledWith(LEAVE_UNSAVED_PROMPT);
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=household');
    expect(name).toHaveValue('Alexandra');

    // Confirming leaves, and with the form gone there is nothing left to warn about.
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('tab', { name: 'Rules' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=rules');
    expect(await screen.findByLabelText('Pattern for rule 1')).toBeInTheDocument();
    expect(unload()).toBe(false);
    confirm.mockRestore();
  });

  it('is reachable from the main navigation for the primary user', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method === 'GET' && url === '/api/accounts') return jsonResponse([]);
      return undefined;
    });

    renderWithProviders(<App />, { route: '/settings' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const link = within(nav).getByRole('link', { name: 'Settings' });
    expect(link).toHaveAttribute('href', '/settings');
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
    expect(await screen.findByText('No accounts yet')).toBeInTheDocument();
  });

  it('is not offered to the partner', () => {
    mockFetch(() => undefined);

    renderWithProviders(<NavLinks role="secondary" />);

    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['Log a claim']);
  });
});
