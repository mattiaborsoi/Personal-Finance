import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { NavLinks } from '../components/NavLinks';
import { account, systemInfo } from '../test/fixtures';
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
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Accounts', 'System']);
    expect(within(tabs).getByRole('tab', { name: 'Accounts' })).toHaveAttribute('aria-selected', 'true');
    expect(within(tabs).getByRole('tab', { name: 'System' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel', { name: 'Accounts' })).toBeInTheDocument();

    expect(await screen.findByRole('button', { name: 'Edit HSBC Premier' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Accounts' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Version' })).not.toBeInTheDocument();
    // Only the Accounts tab's data is requested.
    expect(urls(calls)).toEqual(['/api/accounts']);
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

  it('puts the chosen tab in the URL', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/accounts') return jsonResponse([hsbc]);
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

    // The arrow keys move between tabs too, and select as they go.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=system');
    expect(screen.getByRole('tab', { name: 'System' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'System' })).toHaveAttribute('aria-selected', 'true');
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
