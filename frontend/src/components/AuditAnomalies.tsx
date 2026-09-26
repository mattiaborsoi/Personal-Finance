import { ShieldCheck } from 'lucide-react';
import type { AuditAnomaly } from '../api';
import { deviationToPercent, formatSignedPercent } from '../lib/format';
import { Badge, type BadgeTone } from './Badge';
import { MoneyText } from './MoneyText';
import { Notice } from './Notice';

interface Props {
  anomalies: AuditAnomaly[];
}

/** Deviation is a fraction of the baseline: over 15 % is worth a look, over 50 % is red. */
function deviationTone(pct: number): BadgeTone {
  if (!Number.isFinite(pct)) return 'neutral';
  const abs = Math.abs(pct);
  if (abs > 50) return 'red';
  if (abs > 15) return 'amber';
  return 'neutral';
}

export function AuditAnomalies({ anomalies }: Props) {
  if (anomalies.length === 0) {
    return (
      <Notice tone="good" icon={ShieldCheck}>
        No anomalies flagged this period.
      </Notice>
    );
  }
  return (
    <ul className="divide-y divide-hairline" aria-label="Anomalies">
      {anomalies.map((a) => {
        const pct = deviationToPercent(a.deviation);
        return (
          <li key={`${a.transaction_id}-${a.merchant}`} className="flex gap-3 py-3 first:pt-0 last:pb-0">
            <span aria-hidden="true" className="mt-2 h-2 w-2 shrink-0 rounded-full bg-warning" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-ink">{a.merchant}</span>
                <Badge tone={deviationTone(pct)} title="Deviation from baseline" className="tabular">
                  {formatSignedPercent(pct, 0)}
                </Badge>
              </div>
              <p className="mt-0.5 text-sm text-ink-2">{a.issue}</p>
              <p className="mt-1 text-xs text-ink-3 tabular">
                Now <MoneyText value={a.current_amount} /> vs median <MoneyText value={a.baseline_amount} />
                {a.baseline_stddev !== null && a.baseline_stddev !== undefined && (
                  <span title="Standard deviation of the prior periods">
                    {' '}
                    ± <MoneyText value={a.baseline_stddev} />
                  </span>
                )}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
