import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '../api';
import { useAsync } from '../hooks/useAsync';
import { formatDateTime } from '../lib/dates';
import { btnPrimary, btnSmall, cx, eyebrow } from '../lib/ui';
import { AuditAnomalies } from './AuditAnomalies';
import { AuditComparisonTable } from './AuditComparisonTable';
import { Card } from './Card';
import { EmptyState } from './EmptyState';
import { ErrorMessage } from './ErrorMessage';
import { LoadingState } from './LoadingState';

interface Props {
  period: string;
  refreshKey?: number;
}

export function AuditCard({ period, refreshKey = 0 }: Props) {
  const audit = useAsync(() => api.getAudit(period), `audit:${period}:${refreshKey}`);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  /** Read out by the always-mounted status region once a run finishes. */
  const [announcement, setAnnouncement] = useState('');

  const report = audit.data;
  // The server answers a period that has never been audited with a JSON null:
  // an ordinary, successful "nothing yet", not an error.
  const noAuditYet = !audit.loading && !audit.error && report === null;

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
    <Card
      icon={Sparkles}
      title="Audit"
      description={report ? `Last run ${formatDateTime(report.created_at)}` : 'Compares this period against its baseline'}
      actions={
        <>
          {audit.loading && <LoadingState inline />}
          <button type="button" className={cx(btnPrimary, btnSmall)} onClick={runAudit} disabled={running}>
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            {running ? 'Running…' : report ? 'Run audit again' : 'Run audit'}
          </button>
        </>
      }
    >
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {audit.error && <ErrorMessage message={audit.error.message} onRetry={audit.reload} />}
      <ErrorMessage message={runError} onDismiss={() => setRunError(null)} className="mb-3" />
      {audit.loading && !report && !audit.error && <LoadingState label="Loading audit" rows={3} />}
      {noAuditYet && (
        <EmptyState icon={Sparkles} title="No audit yet" hint="Run one to compare this period against its baseline." />
      )}
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
