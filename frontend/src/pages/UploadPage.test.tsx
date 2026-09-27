import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { writeSession } from '../api';
import { AuthProvider } from '../auth/AuthProvider';
import { ConfigContext } from '../config/ConfigContext';
import { fixtureConfig, jsonResponse, mockFetch, primarySession, renderWithProviders } from '../test/utils';
import { UploadPage } from './UploadPage';

describe('<UploadPage /> submit', () => {
  it('explains a missing file instead of silently disabling the button, and clears it once one is chosen', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) =>
      method === 'GET' && url === '/api/statements' ? jsonResponse([]) : undefined,
    );

    renderWithProviders(<UploadPage />, { route: '/upload' });
    const submit = screen.getByRole('button', { name: 'Upload and import' });
    expect(submit).toBeEnabled();

    await user.click(submit);
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a statement file first.');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    fireEvent.change(screen.getByLabelText(/choose a file/i), { target: { files: [new File(['x'], 'amex-july.pdf')] } });
    expect(screen.queryByText('Choose a statement file first.')).not.toBeInTheDocument();
  });
});

const UNCLEAR = 'Settl could not tell which account this statement is from. Choose it in the Account list and upload again.';
const NO_MATCH = 'No account matches this statement. Add the account under Settings, Accounts, then upload it again.';

function chooseFile() {
  fireEvent.change(screen.getByLabelText(/choose a file/i), { target: { files: [new File(['x'], 'amex-july.pdf')] } });
}

describe('<UploadPage /> accounts', () => {
  it('says what it skips in the subtitle', () => {
    mockFetch(({ method, url }) => (method === 'GET' && url === '/api/statements' ? jsonResponse([]) : undefined));
    renderWithProviders(<UploadPage />, { route: '/upload' });

    expect(
      screen.getByText(/The same file, or lines already imported from another export, are skipped\./),
    ).toBeInTheDocument();
  });

  it('points to Settings when there are no accounts, and explains on press instead of uploading', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) =>
      method === 'GET' && url === '/api/statements' ? jsonResponse([]) : undefined,
    );
    writeSession(primarySession);
    render(
      <MemoryRouter initialEntries={['/upload']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider initialSession={primarySession}>
          <ConfigContext.Provider value={{ ...fixtureConfig, accounts: [] }}>
            <UploadPage />
          </ConfigContext.Provider>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText(/There are no accounts to upload to yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'add your accounts in Settings' })).toHaveAttribute('href', '/settings?tab=accounts');

    chooseFile();
    await user.click(screen.getByRole('button', { name: 'Upload and import' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Add the account this statement comes from under Settings, Accounts first.');
    expect(within(alert).getByRole('link', { name: 'Go to Settings, Accounts' })).toHaveAttribute('href', '/settings?tab=accounts');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('when the server cannot tell the account, shows its message and offers only the accounts it could be', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/statements') return jsonResponse([]);
      if (method === 'POST' && url === '/api/statements/upload') {
        return jsonResponse({ detail: { message: UNCLEAR, candidates: ['acc_cc_amex', 'acc_cc_amex_supp'] } }, 422);
      }
      return undefined;
    });
    renderWithProviders(<UploadPage />, { route: '/upload' });

    chooseFile();
    await user.click(screen.getByRole('button', { name: 'Upload and import' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(UNCLEAR);
    const select = screen.getByRole('combobox', { name: 'Account' });
    await waitFor(() => expect(select).toHaveFocus());
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Choose an account',
      'Amex Platinum ··7715',
      'Amex Platinum (supplementary) ··3348',
    ]);
    expect(select).toHaveAccessibleDescription('Choose the account this statement is from.');
  });

  it('when no account matches at all, shows the message with the way to Settings', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/statements') return jsonResponse([]);
      if (method === 'POST' && url === '/api/statements/upload') {
        return jsonResponse({ detail: { message: NO_MATCH, candidates: [] } }, 422);
      }
      return undefined;
    });
    renderWithProviders(<UploadPage />, { route: '/upload' });

    chooseFile();
    await user.click(screen.getByRole('button', { name: 'Upload and import' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(NO_MATCH);
    expect(within(alert).getByRole('link', { name: 'Go to Settings, Accounts' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Account' })).not.toHaveFocus();
  });
});
