import { CircleAlert, History, Upload } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { FILE_TOO_LARGE_MESSAGE, api, describeDetail, errorMessage, isApiError, type UploadResult } from '../api';
import { Card } from '../components/Card';
import { ErrorMessage } from '../components/ErrorMessage';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { SUPPORTED_FORMATS, UploadDropzone } from '../components/UploadDropzone';
import { UploadHistory } from '../components/UploadHistory';
import { UploadResultCard } from '../components/UploadResultCard';
import { useConfig } from '../config/ConfigContext';
import { useRefreshReviewBadge } from '../hooks/reviewBadge';
import { useAsync } from '../hooks/useAsync';
import { accountLabel } from '../lib/format';
import { btnPrimary, btnSecondary, btnSmall, cardInset, cx, labelBase, selectBase } from '../lib/ui';

interface UploadError {
  message: string;
  candidates: string[];
}

function toUploadError(err: unknown): UploadError {
  // nginx rejects oversized bodies with an HTML page before the backend sees them.
  if (isApiError(err, 413)) {
    return { message: FILE_TOO_LARGE_MESSAGE, candidates: [] };
  }
  if (isApiError(err, 422)) {
    const detail = err.detail;
    let candidates: string[] = [];
    let message = 'The account could not be determined from this file. Choose one and try again.';
    if (Array.isArray(detail)) {
      candidates = detail.map((c) => (typeof c === 'string' ? c : describeDetail(c)));
    } else if (detail && typeof detail === 'object') {
      const obj = detail as Record<string, unknown>;
      const list = obj.candidates ?? obj.candidate_accounts ?? obj.accounts;
      if (Array.isArray(list)) {
        candidates = list.map((c) =>
          typeof c === 'string' ? c : String((c as { id?: unknown }).id ?? describeDetail(c)),
        );
      }
      if (typeof obj.message === 'string') message = obj.message;
      else if (typeof obj.detail === 'string') message = obj.detail;
    } else if (typeof detail === 'string') {
      message = detail;
    }
    return { message, candidates };
  }
  if (isApiError(err, 409)) {
    return { message: err.message || 'This statement was already uploaded, or its period is closed.', candidates: [] };
  }
  return { message: errorMessage(err), candidates: [] };
}

export function UploadPage() {
  const config = useConfig();
  // Archived accounts stay in the config for history but take no new statements.
  const activeAccounts = config.accounts.filter((a) => a.is_active !== false);
  const history = useAsync(() => api.listStatements(), 'statements');
  const refreshReviewBadge = useRefreshReviewBadge();
  const [file, setFile] = useState<File | null>(null);
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<UploadError | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) {
      setError({ message: 'Choose a statement file first.', candidates: [] });
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.uploadStatement(file, accountId || undefined);
      setResult(res);
      setFile(null);
      history.reload();
      refreshReviewBadge();
    } catch (err) {
      setError(toUploadError(err));
    } finally {
      setBusy(false);
    }
  }

  /** A deleted upload leaves the list, and takes its import summary with it. */
  function uploadDeleted(id: string) {
    history.reload();
    refreshReviewBadge();
    setResult((prev) => (prev && prev.upload_id === id ? null : prev));
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Upload statement"
        description={`${SUPPORTED_FORMATS}, up to 25 MB. Duplicates are detected by file hash.`}
      />
      <Card icon={Upload} title="New statement">
        <form onSubmit={submit} className="space-y-4">
          <UploadDropzone file={file} onFile={setFile} disabled={busy} />
          <div className={cx(cardInset, 'flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between')}>
            <div>
              <label htmlFor="upload-account" className={labelBase}>
                Account
              </label>
              <p className="text-xs text-ink-3">Optional, overrides auto-detection.</p>
            </div>
            <select
              id="upload-account"
              className={cx(selectBase, 'sm:w-72')}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              disabled={busy}
            >
              <option value="">Detect automatically</option>
              {activeAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {accountLabel(config.accounts, a.id)}
                </option>
              ))}
            </select>
          </div>
          {error && (
            <div role="alert" className="rounded-xl bg-critical/10 px-4 py-3 text-sm text-critical-ink">
              <p className="flex items-center gap-2">
                <CircleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                {error.message}
              </p>
              {error.candidates.length > 0 && (
                <ul className="mt-2.5 flex flex-wrap gap-2 pl-6">
                  {error.candidates.map((c) => (
                    <li key={c}>
                      <button type="button" className={cx(btnSecondary, btnSmall)} onClick={() => setAccountId(c)}>
                        {accountLabel(config.accounts, c)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <button type="submit" className={btnPrimary} disabled={busy || !file}>
            <Upload className="h-4 w-4" aria-hidden="true" />
            {busy ? 'Uploading…' : 'Upload and import'}
          </button>
        </form>
        {result && (
          <div className="mt-5">
            <UploadResultCard result={result} />
          </div>
        )}
      </Card>
      <Card flush icon={History} title="Previous uploads" actions={history.loading && <LoadingState inline />}>
        {history.error && (
          <div className="p-5 sm:p-6">
            <ErrorMessage message={history.error.message} onRetry={history.reload} />
          </div>
        )}
        {!history.data && !history.error && (
          <div className="px-5 py-5 sm:px-6">
            <LoadingState rows={4} />
          </div>
        )}
        {history.data && <UploadHistory statements={history.data} onDeleted={uploadDeleted} />}
      </Card>
    </div>
  );
}
