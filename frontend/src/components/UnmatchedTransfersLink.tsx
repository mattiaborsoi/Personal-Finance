import { ArrowLeftRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAsync } from '../hooks/useAsync';
import { plural } from '../lib/format';
import { btnSecondary, btnSmall, cx } from '../lib/ui';
import { Badge } from './Badge';

interface Props {
  refreshKey?: number;
}

/** Shortcut to the transfers page with the unmatched count as a badge (amber while something needs a look). */
export function UnmatchedTransfersLink({ refreshKey = 0 }: Props) {
  const unmatched = useAsync(() => api.listUnmatchedTransfers(), `unmatched:${refreshKey}`);
  const count = unmatched.data?.length;
  if (unmatched.error) return null;
  return (
    <Link
      to="/transfers"
      className={cx(btnSecondary, btnSmall)}
      title={count === undefined ? 'Transfers' : plural(count, 'unmatched transfer')}
    >
      <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden="true" />
      Unmatched transfers
      <Badge tone={count ? 'amber' : 'neutral'} className="-my-1 tabular">
        {count === undefined ? '…' : count}
      </Badge>
    </Link>
  );
}
