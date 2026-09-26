import { useState } from 'react';
import { api, editErrorMessage, type ClaimOut } from '../api';
import { useAuth } from '../auth/AuthContext';
import { Card } from '../components/Card';
import { ClaimForm } from '../components/ClaimForm';
import { ClaimList } from '../components/ClaimList';
import { ErrorMessage } from '../components/ErrorMessage';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { SettlementNetLine } from '../components/SettlementNetLine';
import { useAsync } from '../hooks/useAsync';
import { periodKeyForDate, periodLabel, todayIso } from '../lib/dates';

/** Mobile-first claim logger, available to both roles. */
export function ClaimPage() {
  const { session } = useAuth();
  // The page follows the month of the date chosen in the form, not the calendar month.
  const [claimDate, setClaimDate] = useState(todayIso());
  const period = periodKeyForDate(claimDate);
  const [refreshKey, setRefreshKey] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const recent = useAsync(() => api.listClaims({ period }), `claims:${period}:${refreshKey}`);

  const mine = (recent.data ?? []).filter((c) => !session || c.paid_by === session.user_id || session.role === 'primary');

  // The API lets the primary user delete anything and the secondary user only their own unsettled claims.
  const canDelete = (claim: ClaimOut) =>
    !!session && (session.role === 'primary' || (claim.paid_by === session.user_id && !claim.is_settled));

  async function remove(claim: ClaimOut) {
    setErrors((prev) => {
      const next = { ...prev };
      delete next[claim.id];
      return next;
    });
    try {
      await api.deleteClaim(claim.id);
      recent.setData((prev) => (prev ? prev.filter((c) => c.id !== claim.id) : prev));
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setErrors((prev) => ({ ...prev, [claim.id]: editErrorMessage(err) }));
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <PageHeader
        title="Log a claim"
        description={`Something you paid for that should be shared or settled. It counts towards ${periodLabel(period)}.`}
      />
      <Card>
        <ClaimForm
          onCreated={() => {
            setRefreshKey((k) => k + 1);
          }}
          onDateChange={setClaimDate}
        />
      </Card>
      <SettlementNetLine period={period} refreshKey={refreshKey} />
      <Card
        flush
        title="Your recent claims"
        description={periodLabel(period)}
        actions={recent.loading && <LoadingState inline />}
      >
        {recent.error && (
          <div className="p-5 sm:p-6">
            <ErrorMessage message={recent.error.message} onRetry={recent.reload} />
          </div>
        )}
        {!recent.data && !recent.error && (
          <div className="px-5 py-5 sm:px-6">
            <LoadingState rows={3} />
          </div>
        )}
        {recent.data && (
          <div className="px-5 sm:px-6">
            <ClaimList
              compact
              claims={mine}
              onDelete={remove}
              canDelete={canDelete}
              errors={errors}
              emptyTitle={`No claims logged for ${periodLabel(period)}`}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
