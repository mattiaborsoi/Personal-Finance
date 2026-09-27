import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { auditReport } from '../test/fixtures';
import { jsonResponse, mockFetch, renderWithProviders } from '../test/utils';
import { AuditCard } from './AuditCard';

describe('<AuditCard />', () => {
  it('treats a null report as "not run yet": an empty state, no error, nothing on the console', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/audit/2026-03') return jsonResponse(null);
      return undefined;
    });

    renderWithProviders(<AuditCard period="2026-03" />);

    expect(await screen.findByText('No audit yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run audit' })).toBeEnabled();
    expect(screen.getByText('Compares this period against its baseline')).toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('runs the first audit from the empty state and shows the report it returns', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/audit/2026-03') return jsonResponse(null);
      if (method === 'POST' && url === '/api/audit/2026-03/run') return jsonResponse(auditReport());
      return undefined;
    });

    renderWithProviders(<AuditCard period="2026-03" />);
    await user.click(await screen.findByRole('button', { name: 'Run audit' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(await screen.findByText(auditReport().summary_sentence)).toBeInTheDocument();
    expect(screen.queryByText('No audit yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run audit again' })).toBeInTheDocument();
    expect(screen.getByText('Last run 1 Apr 2026, 08:00')).toBeInTheDocument();
  });

  it('shows an existing report straight away', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/audit/2026-03') return jsonResponse(auditReport());
      return undefined;
    });

    renderWithProviders(<AuditCard period="2026-03" />);

    expect(await screen.findByText(auditReport().summary_sentence)).toBeInTheDocument();
    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.queryByText('No audit yet')).not.toBeInTheDocument();
  });

  it('still reports a real failure as an error, not as "no audit yet"', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/audit/2026-03') return jsonResponse({ detail: 'database unavailable' }, 500);
      return undefined;
    });

    renderWithProviders(<AuditCard period="2026-03" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('database unavailable');
    expect(screen.queryByText('No audit yet')).not.toBeInTheDocument();
  });
});
