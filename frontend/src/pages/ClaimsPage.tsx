import { CirclePlus, HandCoins, Lock } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, editErrorMessage, type ClaimOut } from '../api';
import { Card } from '../components/Card';
import { ClaimList } from '../components/ClaimList';
import { ErrorMessage } from '../components/ErrorMessage';
import { LoadingState } from '../components/LoadingState';
import { Notice } from '../components/Notice';
import { PageHeader } from '../components/PageHeader';
import { PeriodSelector } from '../components/PeriodSelector';
import { useAsync } from '../hooks/useAsync';
import { currentPeriodKey, defaultPeriodKey, isPeriodKey, periodLabel } from '../lib/dates';
import { plural } from '../lib/format';
import { btnPrimary } from '../lib/ui';

export function ClaimsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const periods = useAsync(() => api.listPeriods(), 'periods');
  const requested = searchParams.get('period');
  const period =
    requested && isPeriodKey(requested)
      ? requested
      : (periods.data ? defaultPeriodKey(periods.data) : null) ?? currentPeriodKey();
  const periodInfo = periods.data?.find((p) => p.period_key === period) ?? null;
  const closed = periodInfo?.is_closed ?? false;
  const claims = useAsync(() => api.listClaims({ period }), `claims:${period}`);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function remove(claim: ClaimOut) {
    setErrors((prev) => {
      const next = { ...prev };
      delete next[claim.id];
      return next;
    });
    try {
      await api.deleteClaim(claim.id);
      claims.setData((prev) => (prev ? prev.filter((c) => c.id !== claim.id) : prev));
    } catch (err) {
      setErrors((prev) => ({ ...prev, [claim.id]: editErrorMessage(err) }));
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Partner claims"
        description={claims.data ? `${plural(claims.data.length, 'claim')} in ${periodLabel(period)}` : undefined}
        actions={
          <Link to="/claim" className={btnPrimary}>
            <CirclePlus className="h-4 w-4" aria-hidden="true" />
            Log a claim
          </Link>
        }
      />
      {periods.error && <ErrorMessage message={periods.error.message} onRetry={periods.reload} />}
      <PeriodSelector periods={periods.data ?? []} value={period} onChange={(p) => setSearchParams({ period: p })} />
      <Card flush icon={HandCoins} title="Claims" actions={claims.loading && <LoadingState inline />}>
        {closed && (
          <div className="px-5 pt-4 sm:px-6">
            <Notice tone="neutral" role="status" icon={Lock}>
              {periodLabel(period)} is closed, so its claims are read-only. Reopen the period from the dashboard to make
              changes.
            </Notice>
          </div>
        )}
        {claims.error && (
          <div className="p-5 sm:p-6">
            <ErrorMessage message={claims.error.message} onRetry={claims.reload} />
          </div>
        )}
        {!claims.data && !claims.error && (
          <div className="px-5 py-5 sm:px-6">
            <LoadingState rows={4} />
          </div>
        )}
        {claims.data && <ClaimList claims={claims.data} onDelete={remove} deleteDisabled={closed} errors={errors} />}
      </Card>
    </div>
  );
}
