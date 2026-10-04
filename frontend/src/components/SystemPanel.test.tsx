import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ResetCounts, SystemInfo } from '../api';
import { App } from '../App';
import { ReloadConfigContext } from '../config/ConfigContext';
import { backupItem, backupsSummary, COMMIT_LATEST, systemInfo } from '../test/fixtures';
import { fixtureConfig, jsonResponse, mockFetch, renderWithProviders, type RecordedCall } from '../test/utils';
import {
  ALREADY_UP_TO_DATE_TITLE,
  BackupsCard,
  MANUAL_UPDATE_COMMANDS,
  SystemPanel,
  UPDATE_ALREADY_RUNNING_MESSAGE,
  UPDATER_UNAVAILABLE_MESSAGE,
} from './SystemPanel';

const LATEST = { commit: COMMIT_LATEST, short: 'f9e8d7c', date: '2026-09-25T09:30:00Z', message: 'Add the Settings page' };
const MIDDLE = { commit: 'b2c3d4e5f6a70819203b4c5d6e7f8091a2b3c4d5', short: 'b2c3d4e', date: '2026-09-23T12:00:00Z', message: 'Split transactions' };
const STARTED_AT = '2026-09-26T10:00:00Z';

/** The server is two commits behind GitHub and idle. */
const behind = systemInfo({ latest: LATEST, changes: [LATEST, MIDDLE], update_available: true });

const running: SystemInfo = systemInfo({
  latest: LATEST,
  update_available: true,
  updater: {
    available: true,
    state: 'running',
    started_at: STARTED_AT,
    finished_at: null,
    log: 'Pulling origin/main… done\nBuilding app image…',
    error: null,
  },
});

/** After the restart the server reports the new commit as the running one. */
const succeeded: SystemInfo = systemInfo({
  running: { commit: COMMIT_LATEST, short: 'f9e8d7c' },
  latest: LATEST,
  update_available: false,
  updater: {
    available: true,
    state: 'succeeded',
    started_at: STARTED_AT,
    finished_at: '2026-09-26T10:02:30Z',
    log: 'Pulling origin/main… done\nBuilding app image… done\nRestarting… done',
    error: null,
  },
});

function renderPanel() {
  return renderWithProviders(<SystemPanel pollIntervalMs={10} />);
}

function systemGets(calls: RecordedCall[]): number {
  return calls.filter((c) => c.method === 'GET' && c.url === '/api/system').length;
}

/** Arms "Update now" and confirms it. */
async function confirmUpdate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Update now' }));
  const group = screen.getByRole('group', { name: 'Update Settl now? The app will restart.' });
  await user.click(within(group).getByRole('button', { name: 'Confirm' }));
}

describe('<SystemPanel />', () => {
  it('shows the running and latest commits with an Update available badge when they differ', async () => {
    const { calls } = mockFetch(({ method, url }) => (method === 'GET' && url === '/api/system' ? jsonResponse(behind) : undefined));

    renderPanel();

    expect(await screen.findByText('a1b2c3d')).toBeInTheDocument();
    expect(calls[0].headers.Authorization).toBe('Bearer primary-token');
    expect(screen.getAllByText('f9e8d7c').length).toBeGreaterThan(0);
    expect(screen.getByText(/· Add the Settings page$/)).toBeInTheDocument();
    expect(screen.getByText('Update available')).toBeInTheDocument();
    const version = screen.getByRole('region', { name: 'Version' });
    expect(version).toHaveTextContent('Settl 2026.09.25 · example/personal-finance (main)');
    // The repository and every commit hash open on GitHub.
    expect(within(version).getByRole('link', { name: 'example/personal-finance (main)' })).toHaveAttribute(
      'href',
      'https://github.com/example/personal-finance/tree/main',
    );
    expect(within(version).getByRole('link', { name: 'f9e8d7c' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^https:\/\/github\.com\/example\/personal-finance\/commit\/f9e8d7c/),
    );
    // Every commit skipped is listed, newest first, so a missed update is not lost behind the latest one.
    expect(screen.getByText('2 commits behind')).toBeInTheDocument();
    const rows = within(screen.getByRole('list', { name: 'Changes' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('f9e8d7c Add the Settings page 25 Sep 2026');
    expect(rows[1]).toHaveTextContent('b2c3d4e Split transactions 23 Sep 2026');
    expect(screen.queryByText(/Only the newest/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Update now' })).toBeEnabled();
    expect(screen.getByRole('region', { name: 'Update' })).toHaveTextContent('Nothing is running now.');
  });

  it('says when the list is cut short because the running version is older than everything fetched', async () => {
    mockFetch(({ method, url }) =>
      method === 'GET' && url === '/api/system' ? jsonResponse({ ...behind, changes_truncated: true }) : undefined,
    );

    renderPanel();

    expect(await screen.findByText('More than 2 commits behind')).toBeInTheDocument();
    expect(screen.getByText('Only the newest 2 are listed; the running version is older than all of them.')).toBeInTheDocument();
  });

  it('says Up to date when the running commit is the latest', async () => {
    mockFetch(({ method, url }) => (method === 'GET' && url === '/api/system' ? jsonResponse(systemInfo()) : undefined));

    renderPanel();

    expect(await screen.findByText('Up to date')).toBeInTheDocument();
    expect(screen.getAllByText('a1b2c3d')).toHaveLength(2);
    expect(screen.queryByText('Update available')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Changes' })).not.toBeInTheDocument();
  });

  it('says Unknown when the server cannot tell, and offers the newest commits as recent changes', async () => {
    mockFetch(({ method, url }) =>
      method === 'GET' && url === '/api/system'
        ? jsonResponse(
            systemInfo({ running: { commit: null, short: null }, latest: LATEST, changes: [LATEST, MIDDLE], update_available: null }),
          )
        : undefined,
    );

    renderPanel();

    expect(await screen.findByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
    expect(screen.getByText('Recent changes on GitHub')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Changes' })).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText(/behind/)).not.toBeInTheDocument();
  });

  it('says Not checked when GitHub has not answered', async () => {
    mockFetch(({ method, url }) =>
      method === 'GET' && url === '/api/system'
        ? jsonResponse(systemInfo({ running: { commit: null, short: null }, latest: null, update_available: null }))
        : undefined,
    );

    renderPanel();

    expect(await screen.findByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('Not checked')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Changes' })).not.toBeInTheDocument();
  });

  it('does not keep asking to reload for an update that finished before the page was opened', async () => {
    // The updater reports "succeeded" until its next run; only an update followed from this page earns the banner.
    mockFetch(({ method, url }) => (method === 'GET' && url === '/api/system' ? jsonResponse(succeeded) : undefined));

    renderPanel();

    expect(await screen.findByText('Up to date')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Reload to use the new version/)).not.toBeInTheDocument();
    expect(screen.getByText(/The last update finished/)).toHaveTextContent('running f9e8d7c');
    expect(screen.getByText('Last update log')).toBeInTheDocument();
  });

  it('announces what Check again found, which the badge alone does not', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/system') return jsonResponse(systemInfo());
      if (method === 'POST' && url === '/api/system/check') return jsonResponse(behind);
      return undefined;
    });

    const { container } = renderPanel();
    await screen.findByText('Up to date');
    const region = container.querySelector('p[aria-live="polite"].sr-only');
    expect(region).toBeEmptyDOMElement();

    await user.click(screen.getByRole('button', { name: 'Check again' }));

    await waitFor(() => expect(region).toHaveTextContent('Update available: 2 commits behind.'));
    expect(screen.getByText('Update available')).toBeInTheDocument();
  });

  it('disables Check again and says so when update checks are off on the server', async () => {
    mockFetch(({ method, url }) =>
      method === 'GET' && url === '/api/system'
        ? jsonResponse(systemInfo({ latest: null, update_available: null, update_check_enabled: false }))
        : undefined,
    );

    renderPanel();

    expect(await screen.findByText('Checks disabled')).toBeInTheDocument();
    const check = screen.getByRole('button', { name: 'Check again' });
    expect(check).toBeDisabled();
    expect(check).toHaveAttribute('title', 'Update checks are disabled on the server');
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('turns self-update off and shows the manual commands when the updater is unreachable', async () => {
    mockFetch(({ method, url }) =>
      method === 'GET' && url === '/api/system'
        ? jsonResponse(systemInfo({ latest: LATEST, update_available: true, updater: { ...behind.updater, available: false } }))
        : undefined,
    );

    renderPanel();

    const update = await screen.findByRole('button', { name: 'Update now' });
    expect(update).toBeDisabled();
    expect(update).toHaveAttribute('title', 'Self-update is off: the updater is not reachable');
    expect(screen.getByText(MANUAL_UPDATE_COMMANDS)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Update' })).toHaveTextContent(
      'Self-update is off because the updater container is not reachable. Update from the server instead:',
    );
    expect(screen.getByText('Update available')).toBeInTheDocument();
  });

  it('asks the server for a fresh look at GitHub on Check again', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/system') return jsonResponse(systemInfo());
      if (method === 'POST' && url === '/api/system/check') return jsonResponse(behind);
      return undefined;
    });

    renderPanel();
    expect(await screen.findByText('Up to date')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check again' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.url).toBe('/api/system/check');
    expect(await screen.findByText('Update available')).toBeInTheDocument();
    expect(screen.getAllByText('f9e8d7c').length).toBeGreaterThan(0);
    expect(screen.getByText('2 commits behind')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
    expect(systemGets(calls)).toBe(1);
  });

  it('starts an update after confirmation, shows its log while it runs and offers a reload when it is done', async () => {
    const user = userEvent.setup();
    let started = false;
    let finished = false;
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/system') {
        if (!started) return jsonResponse(behind);
        return jsonResponse(finished ? succeeded : running);
      }
      if (method === 'POST' && url === '/api/system/update') {
        started = true;
        return jsonResponse({ state: 'running', started_at: STARTED_AT }, 202);
      }
      return undefined;
    });

    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Update now' }));
    // Nothing is sent until the inline confirmation.
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    const group = screen.getByRole('group', { name: 'Update Settl now? The app will restart.' });
    await user.click(within(group).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.url).toBe('/api/system/update');

    // The 202 alone puts the panel into the running state; the polls then bring the log in.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/^Updating Settl, started .+\. The app will restart when it is done\.$/),
    );
    await waitFor(() => expect(screen.getByLabelText('Update log')).toHaveTextContent('Pulling origin/main… done Building app image…'));
    const update = screen.getByRole('button', { name: 'Update now' });
    expect(update).toBeDisabled();
    expect(update).toHaveAttribute('title', UPDATE_ALREADY_RUNNING_MESSAGE);
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
    await waitFor(() => expect(systemGets(calls)).toBeGreaterThanOrEqual(3));

    finished = true;

    expect(await screen.findByText(/Reload to use the new version/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Updated to f9e8d7c. Reload to use the new version.');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    // The log is kept behind a disclosure, and the version card reflects the new build.
    expect(screen.getByText('Update log')).toBeInTheDocument();
    expect(screen.getByLabelText('Update log')).toHaveTextContent('Restarting… done');
    expect(screen.getByText('Up to date')).toBeInTheDocument();
    // Nothing newer to install, so Update now rests until GitHub moves on.
    expect(screen.getByRole('button', { name: 'Update now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Update now' })).toHaveAttribute('title', ALREADY_UP_TO_DATE_TITLE);

    // Polling stops once the update has ended.
    const polls = systemGets(calls);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(systemGets(calls)).toBe(polls);
  });

  it('says an update is already running on 409 and follows that one instead', async () => {
    const user = userEvent.setup();
    let refused = false;
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/system') return jsonResponse(refused ? running : behind);
      if (method === 'POST' && url === '/api/system/update') {
        refused = true;
        return jsonResponse({ detail: 'an update is already running' }, 409);
      }
      return undefined;
    });

    renderPanel();
    await confirmUpdate(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(UPDATE_ALREADY_RUNNING_MESSAGE);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Updating Settl/));
    expect(screen.getByLabelText('Update log')).toHaveTextContent('Building app image…');
    expect(screen.getByRole('button', { name: 'Update now' })).toBeDisabled();
  });

  it('explains a 503 as the updater being unreachable', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/system') return jsonResponse(behind);
      if (method === 'POST' && url === '/api/system/update') return jsonResponse({ detail: 'updater unavailable' }, 503);
      return undefined;
    });

    renderPanel();
    await confirmUpdate(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(UPDATER_UNAVAILABLE_MESSAGE);
    expect(screen.getByRole('region', { name: 'Update' })).toHaveTextContent('Nothing is running now.');
    expect(screen.getByRole('button', { name: 'Update now' })).toBeEnabled();
    expect(systemGets(calls)).toBe(1);
  });

  it('keeps polling through the restart and picks up the result once the app is back', async () => {
    let polls = 0;
    // The test moves the server along, so every state is seen before the next one arrives.
    let phase: 'running' | 'restarting' | 'back' = 'running';
    const { calls } = mockFetch(({ method, url }) => {
      if (method !== 'GET' || url !== '/api/system') return undefined;
      polls += 1;
      if (phase === 'running') return jsonResponse(running);
      if (phase === 'back') return jsonResponse(succeeded);
      // While the app restarts the gateway answers nothing at all, or a bare 502 page.
      if (polls % 2 === 0) throw new TypeError('Failed to fetch');
      return new Response('<html><body>502 Bad Gateway</body></html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      });
    });

    renderPanel();

    // An update found running on load is followed without anyone pressing anything.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Updating Settl/));
    await waitFor(() => expect(polls).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole('button', { name: 'Update now' })).toBeDisabled();

    phase = 'restarting';

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Restarting… the app is coming back up.'));
    // Not an error: the last log is kept and no complaint is raised.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Update log')).toHaveTextContent('Building app image…');
    // Both a dropped connection and a 502 page are shrugged off, and it keeps trying.
    const failingSince = polls;
    await waitFor(() => expect(polls).toBeGreaterThanOrEqual(failingSince + 3));
    expect(screen.getByRole('status')).toHaveTextContent('Restarting… the app is coming back up.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    phase = 'back';

    expect(await screen.findByText(/Reload to use the new version/)).toBeInTheDocument();
    expect(screen.queryByText('Restarting… the app is coming back up.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    // Back up to date, so there is nothing left to install.
    expect(screen.getByRole('button', { name: 'Update now' })).toBeDisabled();
    expect(systemGets(calls)).toBe(polls);
  });
});

describe('<SystemPanel /> Update now', () => {
  it('rests when the running commit is already the latest, and says why', async () => {
    mockFetch(({ url }) => (url === '/api/system' ? jsonResponse(systemInfo({ latest: LATEST, update_available: false })) : undefined));
    renderPanel();
    const button = await screen.findByRole('button', { name: 'Update now' });
    expect(screen.getByText('Up to date')).toBeInTheDocument();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', ALREADY_UP_TO_DATE_TITLE);
  });

  it('stays available when it is not known whether an update exists', async () => {
    mockFetch(({ url }) =>
      url === '/api/system'
        ? jsonResponse(systemInfo({ running: { commit: null, short: null }, latest: LATEST, update_available: null }))
        : undefined,
    );
    renderPanel();
    expect(await screen.findByRole('button', { name: 'Update now' })).toBeEnabled();
  });
});

const NONE: ResetCounts = { transactions: 0, uploads: 0, claims: 0, periods: 0, memory: 0, accounts: 0, settings: 0 };

/** Shows where the router is, since a MemoryRouter never touches window.location. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function resets(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === 'POST' && c.url === '/api/system/reset');
}

/** The panel with a spy for `useReloadConfig()`, and a probe of the router's location. */
function renderDangerZone(reload = vi.fn(() => Promise.resolve())) {
  renderWithProviders(
    <ReloadConfigContext.Provider value={reload}>
      <SystemPanel pollIntervalMs={10} />
      <LocationProbe />
    </ReloadConfigContext.Provider>,
    { route: '/settings?tab=system' },
  );
  return reload;
}

describe('<SystemPanel /> danger zone', () => {
  it('sits at the foot of the panel, quiet, with the way to remove one statement instead', async () => {
    mockFetch(({ method, url }) => (method === 'GET' && url === '/api/system' ? jsonResponse(systemInfo()) : undefined));

    renderDangerZone();
    await screen.findByText('Up to date');

    const zone = screen.getByRole('region', { name: 'Danger zone' });
    expect(within(zone).getByRole('button', { name: 'Delete all transactions' })).toHaveAttribute('aria-expanded', 'false');
    expect(within(zone).getByRole('button', { name: 'Reset Settl to day one' })).toHaveAttribute('aria-expanded', 'false');
    expect(within(zone).queryByRole('textbox')).not.toBeInTheDocument();
    expect(zone).toHaveTextContent('To remove one statement, use Delete under Previous uploads on the Upload page.');
    expect(within(zone).getByRole('link', { name: 'Upload page' })).toHaveAttribute('href', '/upload');
    // Last on the page.
    const regions = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(regions[regions.length - 1]).toBe('Danger zone');
  });

  it('is there even when the version information does not load', async () => {
    mockFetch(({ method, url }) =>
      method === 'GET' && url === '/api/system' ? jsonResponse({ detail: 'GitHub is down' }, 500) : undefined,
    );

    renderDangerZone();

    expect(await screen.findByRole('alert')).toHaveTextContent('GitHub is down');
    expect(screen.getByRole('button', { name: 'Delete all transactions' })).toBeEnabled();
  });

  it('deletes all transactions once the phrase is typed exactly, then shows the counts and reloads the config', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/system') return jsonResponse(systemInfo());
      if (method === 'POST' && url === '/api/system/reset') {
        return jsonResponse({ scope: 'transactions', deleted: { ...NONE, transactions: 412, uploads: 9, periods: 3 } });
      }
      return undefined;
    });

    const reload = renderDangerZone();
    await user.click(await screen.findByRole('button', { name: 'Delete all transactions' }));
    expect(screen.getByRole('button', { name: 'Delete all transactions' })).toHaveAttribute('aria-expanded', 'true');

    const form = screen.getByRole('form', { name: 'Confirm: Delete all transactions' });
    // It says exactly what goes and what stays.
    expect(form).toHaveTextContent('Every transaction, split part and transfer leg');
    expect(form).toHaveTextContent('Every statement upload');
    expect(form).toHaveTextContent('Periods with no partner claims in them');
    expect(form).toHaveTextContent('Partner claims, and the periods they are in');
    expect(form).toHaveTextContent('Merchant memory');
    expect(form).toHaveTextContent('Settings: household, categories, rules and AI');

    const phrase = within(form).getByLabelText('Type DELETE TRANSACTIONS to confirm');
    const confirm = within(form).getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    await user.type(phrase, 'delete transactions');
    expect(confirm).toBeDisabled();
    await user.clear(phrase);
    await user.type(phrase, 'DELETE TRANSACTION');
    expect(confirm).toBeDisabled();
    await user.type(phrase, 'S');
    expect(confirm).toBeEnabled();
    expect(resets(calls)).toEqual([]);

    await user.click(confirm);

    expect(await screen.findByRole('status')).toHaveTextContent('Deleted 412 transactions, 9 uploads and 3 periods.');
    expect(resets(calls)).toHaveLength(1);
    expect(resets(calls)[0].body).toEqual({ scope: 'transactions', confirm: 'DELETE TRANSACTIONS' });
    expect(resets(calls)[0].headers.Authorization).toBe('Bearer primary-token');
    expect(reload).toHaveBeenCalledTimes(1);
    // The confirmation closes; this scope stays on the page.
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=system');
  });

  it('shows the server’s 422 when it does not accept the phrase, and keeps the confirmation open', async () => {
    const user = userEvent.setup();
    const reload = vi.fn(() => Promise.resolve());
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/system') return jsonResponse(systemInfo());
      if (method === 'POST' && url === '/api/system/reset') {
        return jsonResponse({ detail: 'type DELETE EVERYTHING to confirm' }, 422);
      }
      return undefined;
    });

    renderDangerZone(reload);
    await user.click(await screen.findByRole('button', { name: 'Reset Settl to day one' }));
    const form = screen.getByRole('form', { name: 'Confirm: Reset Settl to day one' });
    await user.type(within(form).getByLabelText('Type DELETE EVERYTHING to confirm'), 'DELETE EVERYTHING{Enter}');

    expect(await within(form).findByRole('alert')).toHaveTextContent('Type DELETE EVERYTHING to confirm');
    expect(within(form).getByRole('button', { name: 'Confirm' })).toBeEnabled();
    expect(reload).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=system');
  });

  it('cancels without a request, and opening one action closes the other', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => (method === 'GET' && url === '/api/system' ? jsonResponse(systemInfo()) : undefined));

    renderDangerZone();
    await user.click(await screen.findByRole('button', { name: 'Delete all transactions' }));
    await user.type(screen.getByLabelText('Type DELETE TRANSACTIONS to confirm'), 'DELETE TRANSACTIONS');
    await user.click(screen.getByRole('button', { name: 'Reset Settl to day one' }));

    expect(screen.queryByLabelText('Type DELETE TRANSACTIONS to confirm')).not.toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Confirm: Reset Settl to day one' });
    expect(form).toHaveTextContent('Both logins: the passwords live in .env');
    expect(within(form).getByRole('button', { name: 'Confirm' })).toBeDisabled();
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(resets(calls)).toEqual([]);
  });

  it('resets everything, reloads the config and lands on the dashboard with the counts', async () => {
    const user = userEvent.setup();
    let wiped = false;
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/config') return jsonResponse(fixtureConfig);
      if (method === 'GET' && url === '/api/system') return jsonResponse(systemInfo());
      if (method === 'GET' && url === '/api/periods') return jsonResponse([]);
      if (method === 'POST' && url === '/api/system/reset') {
        wiped = true;
        return jsonResponse({
          scope: 'everything',
          deleted: { transactions: 412, uploads: 9, claims: 4, periods: 6, memory: 30, accounts: 6, settings: 4 },
        });
      }
      return undefined;
    });

    renderWithProviders(<App />, { route: '/settings?tab=system' });
    await user.click(await screen.findByRole('button', { name: 'Reset Settl to day one' }));
    await user.type(screen.getByLabelText('Type DELETE EVERYTHING to confirm'), 'DELETE EVERYTHING');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(wiped).toBe(true);
    expect(resets(calls)[0].body).toEqual({ scope: 'everything', confirm: 'DELETE EVERYTHING' });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Settl is back to day one. Deleted 412 transactions, 9 uploads, 4 partner claims, 6 periods, 30 remembered merchants, 6 accounts and 4 saved settings. The accounts in config.yaml are set up again.',
    );
    // The config was fetched again after the reset, before leaving Settings.
    const configFetches = calls.filter((c) => c.method === 'GET' && c.url === '/api/config');
    expect(configFetches).toHaveLength(2);
    expect(calls.indexOf(configFetches[1])).toBeGreaterThan(calls.indexOf(resets(calls)[0]));
    expect(await screen.findByText('Upload a statement to get started.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('stays on Settings and says so when the config cannot be reloaded after a reset', async () => {
    const user = userEvent.setup();
    const reload = vi.fn(() => Promise.reject(new Error('Could not reach the server.')));
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/system') return jsonResponse(systemInfo());
      if (method === 'POST' && url === '/api/system/reset') {
        return jsonResponse({ scope: 'everything', deleted: { ...NONE, transactions: 2, accounts: 6 } });
      }
      return undefined;
    });

    renderDangerZone(reload);
    await user.click(await screen.findByRole('button', { name: 'Reset Settl to day one' }));
    await user.type(screen.getByLabelText('Type DELETE EVERYTHING to confirm'), 'DELETE EVERYTHING');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Settl is back to day one. Deleted 2 transactions and 6 accounts.');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Reset, but the rest of Settl shows the old settings until you reload the page: Could not reach the server.',
    );
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=system');
  });
});

describe('<BackupsCard />', () => {
  it('shows the newest backup with how long ago, its kind and size, and the recent ones', async () => {
    const older = backupItem(30, 'pre-update', 1_900_000);
    mockFetch(() => undefined);

    renderWithProviders(<BackupsCard summary={backupsSummary({ recent: [backupItem(6), older] })} />);

    const card = screen.getByRole('region', { name: 'Backups' });
    expect(card).toHaveTextContent('Last backup 6 hours ago (nightly, 2.1 MB)');
    const rows = within(screen.getByRole('list', { name: 'Recent backups' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent('before an update');
    expect(rows[1]).toHaveTextContent('1.9 MB');
    expect(card).toHaveTextContent('2 backups on the server.');
    expect(screen.queryByText(/more than a day and a half ago/)).not.toBeInTheDocument();
  });

  it('warns when there is no backup yet', () => {
    mockFetch(() => undefined);

    renderWithProviders(<BackupsCard summary={backupsSummary({ recent: [] })} />);

    expect(screen.getByRole('status')).toHaveTextContent('There is no backup of the database yet. Back up now.');
    expect(screen.getByText('No backups yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download latest' })).toBeDisabled();
  });

  it('warns when the newest backup is stale, and says when nightly backups are off', () => {
    mockFetch(() => undefined);
    const old = backupItem(40);

    renderWithProviders(<BackupsCard summary={backupsSummary({ recent: [old], stale: true, enabled: false })} />);

    expect(screen.getByRole('status')).toHaveTextContent('more than a day and a half ago');
    expect(screen.getByText(/Nightly backups are turned off on this server/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Backups' })).toHaveTextContent('Last backup 1 day ago (nightly, 2.1 MB)');
  });

  it('backs up now with a spinner, then shows the new backup and clears the warning', async () => {
    const user = userEvent.setup();
    const made = backupItem(0, 'manual', 2_200_000);
    let finish: (() => void) | undefined;
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'POST' && url === '/api/system/backups') {
        return new Promise<Response>((resolve) => {
          finish = () => resolve(jsonResponse(made, 201));
        });
      }
      if (method === 'GET' && url === '/api/system/backups') return jsonResponse([made]);
      return undefined;
    });

    renderWithProviders(<BackupsCard summary={backupsSummary({ recent: [], stale: true })} />);
    await user.click(screen.getByRole('button', { name: 'Back up now' }));

    expect(await screen.findByRole('button', { name: 'Backing up…' })).toBeDisabled();
    finish?.();
    expect(await screen.findByText('Last backup just now (manual, 2.2 MB)')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeEnabled();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/system/backups', 'GET /api/system/backups']);
    expect(calls[0].headers.Authorization).toBe('Bearer primary-token');
  });

  it('shows the reason when a backup fails', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) =>
      method === 'POST' && url === '/api/system/backups'
        ? jsonResponse({ detail: 'The backup failed: pg_dump failed: could not connect' }, 500)
        : undefined,
    );

    renderWithProviders(<BackupsCard summary={backupsSummary()} />);
    await user.click(screen.getByRole('button', { name: 'Back up now' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The backup failed: pg_dump failed: could not connect');
  });

  it('downloads the latest backup with the session header and saves it under its own name', async () => {
    const user = userEvent.setup();
    const latest = backupItem(6);
    const createObjectURL = vi.fn((blob: Blob) => (blob.size > 0 ? 'blob:settl-backup' : ''));
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true, writable: true });
    const saved: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ href: this.href, download: this.download });
    });
    const { calls } = mockFetch(({ method, url }) =>
      method === 'GET' && url === `/api/system/backups/${latest.name}`
        ? new Response(new Blob(['PGDMP synthetic']), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
        : undefined,
    );

    renderWithProviders(<BackupsCard summary={backupsSummary({ recent: [latest] })} />);
    await user.click(screen.getByRole('button', { name: 'Download latest' }));

    await waitFor(() => expect(saved).toEqual([{ href: 'blob:settl-backup', download: latest.name }]));
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe('Bearer primary-token');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('asks before deleting a backup, then deletes it and refreshes the list', async () => {
    const user = userEvent.setup();
    const newest = backupItem(6);
    const older = backupItem(30, 'manual');
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'DELETE' && url === `/api/system/backups/${older.name}`) return new Response(null, { status: 204 });
      if (method === 'GET' && url === '/api/system/backups') return jsonResponse([newest]);
      return undefined;
    });

    renderWithProviders(<BackupsCard summary={backupsSummary({ recent: [newest, older] })} />);
    const rows = within(screen.getByRole('list', { name: 'Recent backups' })).getAllByRole('listitem');
    await user.click(within(rows[1]).getByRole('button', { name: /^Delete the backup from/ }));

    const prompt = within(rows[1]).getByRole('group', { name: 'Delete this backup?' });
    expect(calls).toHaveLength(0); // nothing deleted before confirming
    await user.click(within(prompt).getByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(within(screen.getByRole('list', { name: 'Recent backups' })).getAllByRole('listitem')).toHaveLength(1),
    );
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `DELETE /api/system/backups/${older.name}`,
      'GET /api/system/backups',
    ]);
  });

  it('is part of the System tab', async () => {
    mockFetch(({ method, url }) => (method === 'GET' && url === '/api/system' ? jsonResponse(systemInfo()) : undefined));

    renderPanel();

    expect(await screen.findByRole('region', { name: 'Backups' })).toHaveTextContent('Last backup 6 hours ago (nightly, 2.1 MB)');
  });
});

describe('<SystemPanel /> update with a pre-update backup', () => {
  it('explains a failed backup instead of "already running", and can update without one after confirming', async () => {
    const user = userEvent.setup();
    const detail = 'The backup before updating failed, so the update was not started: pg_dump failed: disk full';
    let posts = 0;
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/system') return jsonResponse(behind);
      if (method === 'POST' && url.startsWith('/api/system/update')) {
        posts += 1;
        return posts === 1 ? jsonResponse({ detail }, 409) : jsonResponse({ state: 'running', started_at: STARTED_AT }, 202);
      }
      return undefined;
    });

    renderPanel();
    await confirmUpdate(user);

    expect(await screen.findByText(detail)).toBeInTheDocument();
    expect(screen.queryByText(UPDATE_ALREADY_RUNNING_MESSAGE)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Update without a backup' }));
    const group = screen.getByRole('group', { name: /^Update without a backup\?/ });
    await user.click(within(group).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(posts).toBe(2));
    const updates = calls.filter((c) => c.method === 'POST').map((c) => c.url);
    expect(updates).toEqual(['/api/system/update', '/api/system/update?skip_backup=true']);
  });
});
