import { HandCoins, Trash2 } from 'lucide-react';
import type { ClaimOut } from '../api';
import { useConfig, useNames } from '../config/ConfigContext';
import { formatDate } from '../lib/dates';
import { claimTypeLabel } from '../lib/format';
import { cx, tableBase, tableFlush, tdBase, thBase, trHover } from '../lib/ui';
import { Badge } from './Badge';
import { ConfirmButton } from './ConfirmButton';
import { EmptyState } from './EmptyState';
import { InitialsChip } from './InitialsChip';
import { MerchantAvatar } from './MerchantAvatar';
import { MoneyText } from './MoneyText';

interface Props {
  claims: ClaimOut[];
  onDelete?: (claim: ClaimOut) => Promise<void>;
  /** Hides the delete button for claims this user may not remove (defaults to all deletable). */
  canDelete?: (claim: ClaimOut) => boolean;
  /** Shows delete buttons but disables them, e.g. while the period is closed. */
  deleteDisabled?: boolean;
  errors?: Record<string, string>;
  emptyTitle?: string;
  /** Stacked list rows for phones instead of the table. */
  compact?: boolean;
}

/** Partner claims as a table (desktop) or compact list (phones), with an optional confirmed delete. */
export function ClaimList({
  claims,
  onDelete,
  canDelete,
  deleteDisabled = false,
  errors = {},
  emptyTitle = 'No claims yet',
  compact = false,
}: Props) {
  const config = useConfig();
  const names = useNames();
  if (claims.length === 0) {
    return <EmptyState icon={HandCoins} title={emptyTitle} hint="Log something you paid for and it will appear here." />;
  }

  const paidByName = (id: string) =>
    id === config.users.primary.id ? names.primary : id === config.users.secondary.id ? names.secondary : id;

  const deleteButton = (claim: ClaimOut) =>
    onDelete && (canDelete?.(claim) ?? true) ? (
      <ConfirmButton
        confirmLabel="Delete this claim?"
        onConfirm={() => onDelete(claim)}
        tone="danger"
        icon={Trash2}
        iconOnly
        disabled={deleteDisabled}
        ariaLabel={`Delete ${claim.merchant}`}
      >
        Delete
      </ConfirmButton>
    ) : null;

  const statusBadge = (claim: ClaimOut) =>
    claim.is_settled ? (
      <Badge tone="green" dot>
        Settled
      </Badge>
    ) : (
      <Badge tone="amber" dot>
        Unsettled
      </Badge>
    );

  if (compact) {
    return (
      <ul className="divide-y divide-hairline">
        {claims.map((claim) => (
          <li key={claim.id} className="flex items-start gap-3 py-3">
            <MerchantAvatar name={claim.merchant} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 truncate font-semibold text-ink">{claim.merchant}</p>
                <MoneyText value={claim.amount} className="shrink-0 font-semibold" />
              </div>
              {claim.description && <p className="text-sm text-ink-2 [overflow-wrap:anywhere]">{claim.description}</p>}
              <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-3">
                <InitialsChip name={paidByName(claim.paid_by)} />
                <span>{paidByName(claim.paid_by)}</span>
                <span aria-hidden="true">·</span>
                <span className="tabular">{formatDate(claim.claim_date)}</span>
                <span aria-hidden="true">·</span>
                <span>{claimTypeLabel(claim.claim_type, names)}</span>
              </p>
              <div className="mt-2 flex items-center justify-between gap-2">
                {statusBadge(claim)}
                {deleteButton(claim)}
              </div>
              {errors[claim.id] && (
                <p role="alert" className="mt-1 text-xs text-critical-ink">
                  {errors[claim.id]}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className={cx(tableBase, tableFlush)}>
        <thead>
          <tr>
            <th scope="col" className={thBase}>
              Claim
            </th>
            <th scope="col" className={thBase}>
              Paid by
            </th>
            <th scope="col" className={thBase}>
              Split
            </th>
            <th scope="col" className={cx(thBase, 'text-right')}>
              {names.primary}
            </th>
            <th scope="col" className={cx(thBase, 'text-right')}>
              {names.secondary}
            </th>
            <th scope="col" className={cx(thBase, 'text-right')}>
              Amount
            </th>
            <th scope="col" className={thBase}>
              Status
            </th>
            <th scope="col" className={thBase}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {claims.map((claim) => (
            <tr key={claim.id} className={trHover}>
              <td className={cx(tdBase, 'min-w-[14rem] align-middle')}>
                <div className="flex items-start gap-3">
                  <MerchantAvatar name={claim.merchant} className="mt-0.5" />
                  <div className="min-w-0">
                    <p className="font-semibold text-ink [overflow-wrap:anywhere]">{claim.merchant}</p>
                    {claim.description && <p className="text-xs text-ink-2 [overflow-wrap:anywhere]">{claim.description}</p>}
                    <p className="mt-0.5 text-xs text-ink-3 tabular">{formatDate(claim.claim_date)}</p>
                    {errors[claim.id] && (
                      <p role="alert" className="mt-1 text-xs text-critical-ink">
                        {errors[claim.id]}
                      </p>
                    )}
                  </div>
                </div>
              </td>
              <td className={cx(tdBase, 'whitespace-nowrap align-middle')}>
                <span className="flex items-center gap-2 text-ink-2">
                  <InitialsChip name={paidByName(claim.paid_by)} />
                  {paidByName(claim.paid_by)}
                </span>
              </td>
              <td className={cx(tdBase, 'whitespace-nowrap align-middle')}>
                <Badge tone="neutral">{claimTypeLabel(claim.claim_type, names)}</Badge>
              </td>
              <td className={cx(tdBase, 'whitespace-nowrap text-right align-middle text-ink-2 tabular')}>
                <MoneyText value={claim.primary_owes} />
              </td>
              <td className={cx(tdBase, 'whitespace-nowrap text-right align-middle text-ink-2 tabular')}>
                <MoneyText value={claim.secondary_owes} />
              </td>
              <td className={cx(tdBase, 'whitespace-nowrap text-right align-middle font-semibold tabular')}>
                <MoneyText value={claim.amount} />
              </td>
              <td className={cx(tdBase, 'align-middle')}>{statusBadge(claim)}</td>
              <td className={cx(tdBase, 'text-right align-middle')}>{deleteButton(claim)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
