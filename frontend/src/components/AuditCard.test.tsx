import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { auditReport } from '../test/fixtures';
import { jsonResponse, mockFetch, renderWithProviders } from '../test/utils';
import { AuditCard, RunAuditButton, useAuditReport } from './AuditCard';

/** The dashboard's wiring: the button in the header, the card only once a report exists. */
function Harness({ period = '2026-03' }: { period?: string }) {
  const audit = useAuditReport(period);
  return (
    <>
      <div data-testid="actions">
        <RunAuditButton period={period} audit={audit} />
      </div>
      <AuditCard audit={audit} />
    </>
  );
}

describe('<AuditCard /> with <RunAuditButton />', () => {
  it('treats a null report as "not run yet": no card, no error, nothing on the console', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/audit/2026-03') return jsonResponse(null);
      return undefined;
    });

    renderWithProviders(<Harness />);

    expect(await screen.findByRole('button', { name: 'Run audit' })).toBeEnabled();
    await waitFor(() => expect(calls.some((c) => c.url === '/api/audit/2026-03')).toBe(true));
    expect(screen.queryByRole('region', { name: 'Audit' })).not.toBeInTheDocument();
    expect(screen.queryByText('No audit yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('runs the first audit from the header button and then shows the report card', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/audit/2026-03') return jsonResponse(null);
      if (method === 'POST' && url === '/api/audit/2026-03/run') return jsonResponse(auditReport());
      return undefined;
    });

    renderWithProviders(<Harness />);
    await user.click(await screen.findByRole('button', { name: 'Run audit' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(await screen.findByText(auditReport().summary_sentence)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Audit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run audit again' })).toBeInTheDocument();
    expect(screen.getByText('Last run 1 Apr 2026, 08:00')).toBeInTheDocument();
    // Screen readers hear that the run finished, with its headline.
    expect(screen.getByRole('status')).toHaveTextContent(`Audit complete. ${auditReport().summary_sentence}`);
  });

  it('shows an existing report straight away', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/audit/2026-03') return jsonResponse(auditReport());
      return undefined;
    });

    renderWithProviders(<Harness />);

    expect(await screen.findByText(auditReport().summary_sentence)).toBeInTheDocument();
    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run audit again' })).toBeInTheDocument();
  });

  it('still reports a real failure as an error, in the card, not as "no audit yet"', async () => {
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/audit/2026-03') return jsonResponse({ detail: 'database unavailable' }, 500);
      return undefined;
    });

    renderWithProviders(<Harness />);

    expect(await screen.findByRole('alert')).toHaveTextContent('database unavailable');
    expect(screen.getByRole('region', { name: 'Audit' })).toBeInTheDocument();
    expect(screen.queryByText('No audit yet')).not.toBeInTheDocument();
  });

  it('shows a failed run beside the button', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => {
      if (method === 'GET' && url === '/api/audit/2026-03') return jsonResponse(null);
      if (method === 'POST' && url === '/api/audit/2026-03/run') return jsonResponse({ detail: 'no lines' }, 409);
      return undefined;
    });

    renderWithProviders(<Harness />);
    await user.click(await screen.findByRole('button', { name: 'Run audit' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('no lines');
    expect(screen.queryByRole('region', { name: 'Audit' })).not.toBeInTheDocument();
  });
});
