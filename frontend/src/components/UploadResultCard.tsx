import { ArrowRight, CircleCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { UploadResult } from '../api';
import { useConfig } from '../config/ConfigContext';
import { periodRangeLabel } from '../lib/dates';
import { accountLabel } from '../lib/format';
import { btnSecondary, btnSmall, cx } from '../lib/ui';
import { Notice } from './Notice';
import { StatTile } from './StatTile';

interface Props {
  result: UploadResult;
}

export function UploadResultCard({ result }: Props) {
  const config = useConfig();
  const stats = [
    { label: 'Inserted', value: result.inserted },
    { label: 'Skipped duplicates', value: result.skipped_duplicates },
    { label: 'Pending review', value: result.pending_review },
    { label: 'Auto-approved', value: result.auto_approved },
    { label: 'Transfers matched', value: result.transfers_matched },
  ];
  return (
    <div role="status" className="rounded-2xl border border-good/20 bg-good/10 p-5">
      <div className="flex items-start gap-3">
        <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-good-ink" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-base font-semibold text-ink">Statement imported</p>
          <p className="mt-0.5 text-sm text-ink-2">
            Into {accountLabel(config.accounts, result.account_id)} for{' '}
            {periodRangeLabel(result.period_from, result.period_to, result.period_key)}{' '}
            <span className="text-ink-3">· parser {result.parser}</span>
          </p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map((s) => (
          <StatTile key={s.label} as="dl-item" surface="raised" label={s.label} value={s.value} />
        ))}
      </dl>
      {result.warnings.length > 0 && (
        <Notice tone="warning" className="mt-3">
          <ul className="list-inside list-disc space-y-0.5" aria-label="Warnings">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}
      {result.pending_review > 0 && (
        <Link
          to={`/?period=${encodeURIComponent(result.period_key)}`}
          className={cx(btnSecondary, btnSmall, 'mt-4')}
        >
          Review the {result.pending_review} pending on the dashboard
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      )}
    </div>
  );
}
