import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, mockFetch, renderWithProviders } from '../test/utils';
import { LoginPage } from './LoginPage';

function stubPointer(fine: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: query === '(pointer: fine)' ? fine : false, media: query })),
  );
}

describe('<LoginPage />', () => {
  it('has a single h1', () => {
    mockFetch(() => undefined);
    renderWithProviders(<LoginPage />, { session: null, route: '/login' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome back');
  });

  it('focuses the password on load with a precise pointer only', () => {
    mockFetch(() => undefined);
    stubPointer(true);
    const { unmount } = renderWithProviders(<LoginPage />, { session: null, route: '/login' });
    expect(screen.getByLabelText('Password')).toHaveFocus();
    unmount();

    stubPointer(false);
    renderWithProviders(<LoginPage />, { session: null, route: '/login' });
    expect(screen.getByLabelText('Password')).not.toHaveFocus();
  });

  it('marks the field invalid, ties it to the error and returns focus to it after a failed sign-in', async () => {
    const user = userEvent.setup();
    stubPointer(false);
    mockFetch(({ method, url }) =>
      method === 'POST' && url === '/api/auth/login' ? jsonResponse({ detail: 'Invalid password' }, 401) : undefined,
    );
    renderWithProviders(<LoginPage />, { session: null, route: '/login' });

    const password = screen.getByLabelText('Password');
    expect(password).not.toHaveAttribute('aria-invalid');

    await user.type(password, 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That password was not recognised.');
    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(password).toHaveAccessibleDescription('That password was not recognised.');
    await waitFor(() => expect(password).toHaveFocus());
  });

  it('flags an empty submit on the field as well', async () => {
    const user = userEvent.setup();
    stubPointer(false);
    mockFetch(() => undefined);
    renderWithProviders(<LoginPage />, { session: null, route: '/login' });

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const password = screen.getByLabelText('Password');
    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(password).toHaveAccessibleDescription('Enter your password.');
    expect(password).toHaveFocus();
  });
});
