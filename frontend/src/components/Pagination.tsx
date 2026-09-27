import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatCount } from '../lib/money';
import { btnSecondary, btnSmall, cx } from '../lib/ui';

interface Props {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}

export function Pagination({ total, limit, offset, onChange }: Props) {
  if (total === 0) return null;
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 text-xs text-ink-3">
      <span className="tabular">
        Showing {formatCount(from)}&ndash;{formatCount(to)} of {formatCount(total)}
      </span>
      <span className="flex items-center gap-2">
        <button
          type="button"
          className={cx(btnSecondary, btnSmall)}
          onClick={() => onChange(Math.max(0, offset - limit))}
          disabled={offset === 0}
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Previous
        </button>
        <span aria-current="page" className="tabular px-1">
          Page {formatCount(page)} of {formatCount(pages)}
        </span>
        <button
          type="button"
          className={cx(btnSecondary, btnSmall)}
          onClick={() => onChange(offset + limit)}
          disabled={offset + limit >= total}
        >
          Next
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </span>
    </nav>
  );
}
