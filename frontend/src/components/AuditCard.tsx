import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage, isApiError } from '../api';
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

  const noAuditYet = isApiError(audit.error, 404);
  const report = audit.data;

  async function runAudit() {
    setRunning(true);
    setRunError(null);
    try {
      const result = await api.runAudit(period);
      audit.setData(() => result);
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
      {audit.error && !noAuditYet && <ErrorMessage message={audit.error.message} onRetry={audit.reload} />}
      <ErrorMessage message={runError} onDismiss={() => setRunError(null)} className="mb-3" />
      {!report && !audit.error && <LoadingState label="Loading audit" rows={3} />}
      {noAuditYet && !report && (
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
