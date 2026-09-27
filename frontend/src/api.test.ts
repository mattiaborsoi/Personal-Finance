import { describe, expect, it } from 'vitest';
import {
  ApiError,
  FILE_TOO_LARGE_MESSAGE,
  PERIOD_CLOSED_MESSAGE,
  api,
  editErrorMessage,
  errorMessage,
  writeSession,
} from './api';
import { jsonResponse, mockFetch, primarySession } from './test/utils';

const NGINX_413 =
  '<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>';

function htmlResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
}

describe('request error mapping', () => {
  it('turns an nginx HTML 413 into "File too large" instead of raw markup', async () => {
    writeSession(primarySession);
    mockFetch(() => htmlResponse(NGINX_413, 413));

    const file = new File(['x'], 'statement.pdf', { type: 'application/pdf' });
    await expect(api.uploadStatement(file)).rejects.toMatchObject({ status: 413, message: FILE_TOO_LARGE_MESSAGE });
  });

  it('also maps the backend JSON 413 to the same message', async () => {
    mockFetch(() => jsonResponse({ detail: 'file larger than 25 MB' }, 413));
    const file = new File(['x'], 'statement.csv', { type: 'text/csv' });
    await expect(api.uploadStatement(file)).rejects.toMatchObject({ message: FILE_TOO_LARGE_MESSAGE });
  });

  it('never surfaces a non-JSON gateway page as the message', async () => {
    mockFetch(() => htmlResponse('<html><body><h1>502 Bad Gateway</h1></body></html>', 502));
    await expect(api.listPeriods()).rejects.toMatchObject({ status: 502, message: 'The server had a problem (502). Try again in a moment.' });
  });

  it('still uses a FastAPI detail when there is one', async () => {
    mockFetch(() => jsonResponse({ detail: 'period must be YYYY-MM' }, 422));
    await expect(api.getMetrics('nope')).rejects.toMatchObject({ status: 422, message: 'period must be YYYY-MM' });
  });
});

describe('editErrorMessage', () => {
  it('replaces a 409 (period closed) with a plain sentence and passes everything else through', () => {
    expect(editErrorMessage(new ApiError(409, 'period 2026-03 is closed', 'period 2026-03 is closed'))).toBe(
      PERIOD_CLOSED_MESSAGE,
    );
    expect(editErrorMessage(new ApiError(404, null, 'transaction not found'))).toBe('transaction not found');
    expect(editErrorMessage(new Error('offline'))).toBe(errorMessage(new Error('offline')));
  });
});

describe('query building', () => {
  it('passes ending= to the trends endpoint and omits it when unset', async () => {
    const { calls } = mockFetch(() => jsonResponse([]));
    await api.getTrends(6, '2026-03');
    await api.getTrends(6);
    expect(calls[0].url).toBe('/api/metrics/trends?periods=6&ending=2026-03');
    expect(calls[1].url).toBe('/api/metrics/trends?periods=6');
  });
});

describe('split endpoints', () => {
  it('PUTs the parts to /split and DELETEs the same path to unsplit', async () => {
    const { calls } = mockFetch(() => jsonResponse({ id: 'abc', is_split: true, parts: [] }));
    const parts = [
      { amount: '-6.00', category: 'Groceries', claim_type: 'shared_proportional' as const },
      { amount: '-4.00', category: 'Household', claim_type: 'personal' as const },
    ];
    await api.splitTransaction('abc', parts);
    await api.unsplitTransaction('abc');

    expect(calls[0]).toMatchObject({ method: 'PUT', url: '/api/transactions/abc/split', body: { parts } });
    expect(calls[1]).toMatchObject({ method: 'DELETE', url: '/api/transactions/abc/split', body: null });
  });
});
