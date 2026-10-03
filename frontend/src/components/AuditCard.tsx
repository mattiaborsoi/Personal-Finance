import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage, type AuditReportOut } from '../api';
import { useAsync, type AsyncResult } from '../hooks/useAsync';
import { formatDateTime } from '../lib/dates';
import { btnSecondary, btnSmall, cx, eyebrow } from '../lib/ui';
import { AuditAnomalies } from './AuditAnomalies';
import { AuditComparisonTable } from './AuditComparisonTable';
import { Card } from './Card';
import { ErrorMessage } from './ErrorMessage';
import { LoadingState } from './LoadingState';

/**
 * The latest report for the period. The server answers a period that has never
 * been audited with a JSON null: an ordinary, successful "nothing yet", not an error.
 */
export function useAuditReport(period: string, refreshKey = 0): AsyncResult<AuditReportOut | null> {
  return useAsync(() => api.getAudit(period), `audit:${period}:${refreshKey}`, period !== '');
}

interface ButtonProps {
  period: string;
  audit: AsyncResult<AuditReportOut | null>;
}

/** "Run audit" for the page header: runs it and hands the report to the shared loader; an error shows beside it. */
export function RunAuditButton({ period, audit }: ButtonProps) {
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  /** Read out by the always-mounted status region once a run finishes. */
  const [announcement, setAnnouncement] = useState('');
  const report = audit.data;

  async function runAudit() {
    setRunning(true);
    setRunError(null);
    setAnnouncement('');
    try {
      const result = await api.runAudit(period);
      audit.setData(() => result);
      setAnnouncement(`Audit complete. ${result.summary_sentence}`);
    } catch (err) {
      setRunError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={cx(btnSecondary, btnSmall)}
        onClick={runAudit}
        disabled={running}
        title="Compares this month against its baseline"
      >
        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
        {running ? 'Running…' : report ? 'Run audit again' : 'Run audit'}
      </button>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {runError && <ErrorMessage message={runError} onDismiss={() => setRunError(null)} className="basis-full" />}
    </>
  );
}

interface CardProps {
  audit: AsyncResult<AuditReportOut | null>;
}

/** The audit report, shown only once one exists (or the request failed); "not run yet" is no card at all. */
export function AuditCard({ audit }: CardProps) {
  const report = audit.data;
  if (!report && !audit.error) return null;
  return (
    <Card
      icon={Sparkles}
      title="Audit"
      description={report ? `Last run ${formatDateTime(report.created_at)}` : 'Compares this month against its baseline'}
      actions={audit.loading && <LoadingState inline />}
    >
      {audit.error && <ErrorMessage message={audit.error.message} onRetry={audit.reload} />}
      {report && (
        <div className="space-y-6">
          <blockquote className="border-l-2 border-brand pl-4 text-base leading-relaxed text-ink-2">
            {report.summary_sentence}
          </blockquote>
          <section aria-labelledby="audit-anomalies">
            <h3 id="audit-anomalies" className={cx(eyebrow, 'mb-3')}>
              Anomalies
            </h3>
            <AuditAnomalies anomalies={report.anomalies} />
          </section>
          <section aria-labelledby="audit-comparison">
            <h3 id="audit-comparison" className={cx(eyebrow, 'mb-3')}>
              Category comparison
            </h3>
            <div className="overflow-hidden rounded-xl border border-hairline">
              <AuditComparisonTable rows={report.category_comparison} />
            </div>
          </section>
        </div>
      )}
    </Card>
  );
}
