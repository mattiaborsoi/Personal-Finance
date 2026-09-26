import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SystemInfo } from '../api';
import { COMMIT_LATEST, systemInfo } from '../test/fixtures';
import { jsonResponse, mockFetch, renderWithProviders, type RecordedCall } from '../test/utils';
import {
  MANUAL_UPDATE_COMMANDS,
  SystemPanel,
  UPDATE_ALREADY_RUNNING_MESSAGE,
  UPDATER_UNAVAILABLE_MESSAGE,
} from './SystemPanel';

const LATEST = { commit: COMMIT_LATEST, short: 'f9e8d7c', date: '2026-09-25T09:30:00Z', message: 'Add the Settings page' };
const STARTED_AT = '2026-09-26T10:00:00Z';

/** The server is one commit behind GitHub and idle. */
const behind = systemInfo({ latest: LATEST, update_available: true });

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
    expect(screen.getByText('f9e8d7c')).toBeInTheDocument();
    expect(screen.getByText(/· Add the Settings page$/)).toBeInTheDocument();
    expect(screen.getByText('Update available')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Version' })).toHaveTextContent('Settl 0.1.0 · example/personal-finance (main)');
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Update now' })).toBeEnabled();
    expect(screen.getByRole('region', { name: 'Update' })).toHaveTextContent('Nothing is running now.');
  });

  it('says Up to date when the running commit is the latest', async () => {
    mockFetch(({ method, url }) => (method === 'GET' && url === '/api/system' ? jsonResponse(systemInfo()) : undefined));

    renderPanel();

    expect(await screen.findByText('Up to date')).toBeInTheDocument();
    expect(screen.getAllByText('a1b2c3d')).toHaveLength(2);
    expect(screen.queryByText('Update available')).not.toBeInTheDocument();
  });

  it('says Unknown when the server cannot tell', async () => {
    mockFetch(({ method, url }) =>
      method === 'GET' && url === '/api/system'
        ? jsonResponse(systemInfo({ running: { commit: null, short: null }, latest: null, update_available: null }))
        : undefined,
    );

    renderPanel();

    expect(await screen.findByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
    expect(screen.getByText('Not checked')).toBeInTheDocument();
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
    expect(screen.getByText('f9e8d7c')).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Update now' })).toBeEnabled();

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
    expect(screen.getByRole('button', { name: 'Update now' })).toBeEnabled();
    expect(systemGets(calls)).toBe(polls);
  });
});
