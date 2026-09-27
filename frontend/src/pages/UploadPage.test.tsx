import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { jsonResponse, mockFetch, renderWithProviders } from '../test/utils';
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
