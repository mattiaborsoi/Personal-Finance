import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { StatementOut } from '../api';
import { UploadPage } from '../pages/UploadPage';
import { statement, uploadResult } from '../test/fixtures';
import { jsonResponse, mockFetch, renderWithProviders } from '../test/utils';
import { NOT_DELETABLE_TITLE, UploadHistory } from './UploadHistory';
import { UploadResultCard } from './UploadResultCard';

const JULY_ID = 'b7e1d2c3-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
const JUNE_ID = 'c8f2e3d4-5a6b-4c7d-9e8f-0a1b2c3d4e5f';

describe('statement period labels', () => {
  it('shows the months a statement spans in the previous uploads list', () => {
    mockFetch(() => undefined);
    renderWithProviders(
      <UploadHistory
        statements={[
          statement({ id: 'a', filename: 'quarter.pdf', period_key: '2026-07', period_from: '2026-05', period_to: '2026-07' }),
          statement({ id: 'b', filename: 'july.pdf', period_key: '2026-07', period_from: '2026-07', period_to: '2026-07' }),
          statement({ id: 'c', filename: 'legacy.csv', period_key: '2026-06', period_from: null, period_to: null }),
        ]}
      />,
    );

    expect(screen.getByText('May–Jul 2026')).toBeInTheDocument();
    expect(screen.getByText('July 2026')).toBeInTheDocument();
    expect(screen.getByText('June 2026')).toBeInTheDocument();
  });

  it('shows the span on the upload result card and links the review to the statement period', () => {
    mockFetch(() => undefined);
    renderWithProviders(<UploadResultCard result={uploadResult({ period_from: '2026-05', period_to: '2026-07' })} />);

    expect(screen.getByRole('status')).toHaveTextContent('Into Amex Platinum ··7715 for May–Jul 2026');
    expect(screen.getByRole('link', { name: /review the 3 pending/i })).toHaveAttribute('href', '/review?period=2026-07');
  });
});

describe('deleting an upload', () => {
  it('deletes after confirmation, refreshes the list and clears the import summary it belongs to', async () => {
    const user = userEvent.setup();
    let stored: StatementOut[] = [statement({ id: JUNE_ID, filename: 'amex-june.pdf', transaction_count: 9 })];
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/statements') return jsonResponse(stored);
      if (method === 'POST' && url === '/api/statements/upload') {
        stored = [statement({ id: JULY_ID, filename: 'amex-july.pdf' }), ...stored];
        return jsonResponse(uploadResult({ upload_id: JULY_ID }));
      }
      if (method === 'DELETE' && url === `/api/statements/${JULY_ID}`) {
        stored = stored.filter((s) => s.id !== JULY_ID);
        return new Response(null, { status: 204 });
      }
      return undefined;
    });

    renderWithProviders(<UploadPage />, { route: '/upload' });
    await screen.findByText('amex-june.pdf');

    // Import July, which shows its summary and joins the list.
    fireEvent.change(screen.getByLabelText(/choose a file/i), { target: { files: [new File(['x'], 'amex-july.pdf')] } });
    await user.click(screen.getByRole('button', { name: 'Upload and import' }));
    expect(await screen.findByText('Statement imported')).toBeInTheDocument();
    expect(await screen.findByText('amex-july.pdf')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete upload amex-july.pdf' }));
    // Nothing is sent until the inline confirmation.
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const confirm = screen.getByRole('group', { name: 'Delete this upload and the 12 lines it added?' });
    await user.click(within(confirm).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')?.url).toBe(`/api/statements/${JULY_ID}`);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Deleted amex-july.pdf and the 12 lines it added. You can upload it again.',
    );
    // Its import summary went with it; the June upload stays, and the list was fetched again.
    expect(screen.queryByText('Statement imported')).not.toBeInTheDocument();
    expect(screen.queryByText('amex-july.pdf')).not.toBeInTheDocument();
    expect(screen.getByText('amex-june.pdf')).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'GET' && c.url === '/api/statements').length).toBe(3),
    );
  });

  it('keeps the import summary when another upload is deleted', async () => {
    const user = userEvent.setup();
    let stored: StatementOut[] = [statement({ id: JUNE_ID, filename: 'amex-june.pdf', transaction_count: 1 })];
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/statements') return jsonResponse(stored);
      if (method === 'POST' && url === '/api/statements/upload') {
        stored = [statement({ id: JULY_ID, filename: 'amex-july.pdf' }), ...stored];
        return jsonResponse(uploadResult({ upload_id: JULY_ID }));
      }
      if (method === 'DELETE' && url === `/api/statements/${JUNE_ID}`) {
        stored = stored.filter((s) => s.id !== JUNE_ID);
        return new Response(null, { status: 204 });
      }
      return undefined;
    });

    renderWithProviders(<UploadPage />, { route: '/upload' });
    await screen.findByText('amex-june.pdf');
    fireEvent.change(screen.getByLabelText(/choose a file/i), { target: { files: [new File(['x'], 'amex-july.pdf')] } });
    await user.click(screen.getByRole('button', { name: 'Upload and import' }));
    await screen.findByText('amex-july.pdf');

    await user.click(screen.getByRole('button', { name: 'Delete upload amex-june.pdf' }));
    const confirm = screen.getByRole('group', { name: 'Delete this upload and the 1 line it added?' });
    await user.click(within(confirm).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(screen.queryByText('amex-june.pdf')).not.toBeInTheDocument());
    expect(screen.getByText('Statement imported')).toBeInTheDocument();
    expect(screen.getByText('amex-july.pdf')).toBeInTheDocument();
  });

  it('disables Delete, saying why, for an upload whose lines cannot be told apart', () => {
    mockFetch(() => undefined);
    renderWithProviders(
      <UploadHistory
        statements={[
          statement({ id: JULY_ID, filename: 'amex-july.pdf' }),
          statement({ id: JUNE_ID, filename: 'legacy.csv', deletable: false }),
        ]}
      />,
    );

    const legacy = screen.getByRole('button', { name: 'Delete upload legacy.csv' });
    expect(legacy).toBeDisabled();
    expect(legacy).toHaveAttribute('title', NOT_DELETABLE_TITLE);
    expect(screen.getByRole('button', { name: 'Delete upload amex-july.pdf' })).toBeEnabled();
  });

  it('shows the server’s refusal and keeps the row', async () => {
    const user = userEvent.setup();
    const onDeleted = vi.fn();
    mockFetch(({ method, url }) => {
      if (method === 'DELETE' && url === `/api/statements/${JULY_ID}`) {
        return jsonResponse({ detail: 'period 2026-08 is closed; reopen it first' }, 409);
      }
      return undefined;
    });

    renderWithProviders(
      <UploadHistory statements={[statement({ id: JULY_ID, filename: 'amex-july.pdf' })]} onDeleted={onDeleted} />,
    );
    await user.click(screen.getByRole('button', { name: 'Delete upload amex-july.pdf' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'amex-july.pdf was not deleted: period 2026-08 is closed; reopen it first',
    );
    expect(screen.getByText('amex-july.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();
    // The row can be tried again once the period is reopened.
    expect(screen.getByRole('button', { name: 'Delete upload amex-july.pdf' })).toBeEnabled();
  });
});
