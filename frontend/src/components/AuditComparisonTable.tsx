import type { AuditCategoryComparison } from '../api';
import { useConfig } from '../config/ConfigContext';
import { categoryEmojiLabel } from '../lib/categories';
import { formatSignedPercent } from '../lib/format';
import { cx, tableBase, tdBase, thBase, trHover } from '../lib/ui';
import { Badge, type BadgeTone } from './Badge';
import { EmptyState } from './EmptyState';
import { MoneyText } from './MoneyText';

interface Props {
  rows: AuditCategoryComparison[];
}

/** More spend than the baseline reads as critical, less as good; small moves stay neutral. */
function changeTone(pct: number): BadgeTone {
  if (!Number.isFinite(pct) || Math.abs(pct) < 5) return 'neutral';
  return pct > 0 ? 'red' : 'green';
}

/** A null change means there was no baseline: the category is new this period. */
function isNewCategory(row: AuditCategoryComparison): boolean {
  return row.change_pct === null || row.change_pct === undefined || row.change_pct === '';
}

export function AuditComparisonTable({ rows }: Props) {
  const emojis = useConfig().category_emojis;
  if (rows.length === 0) return <EmptyState title="No category comparison available" />;
  return (
    <div className="overflow-x-auto">
      <table className={cx(tableBase, 'tabular')}>
        <thead>
          <tr>
            <th scope="col" className={thBase}>
              Category
            </th>
            <th scope="col" className={cx(thBase, 'text-right')}>
              This period
            </th>
            <th scope="col" className={cx(thBase, 'text-right')}>
              Baseline
            </th>
            <th scope="col" className={cx(thBase, 'text-right')}>
              Change
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {rows.map((row) => {
            const isNew = isNewCategory(row);
            const pct = isNew ? Number.NaN : Number(row.change_pct);
            return (
              <tr key={row.category} className={trHover}>
                <td className={cx(tdBase, 'font-medium')}>{categoryEmojiLabel(row.category, emojis)}</td>
                <td className={cx(tdBase, 'text-right')}>
                  <MoneyText value={row.current} />
                </td>
                <td className={cx(tdBase, 'text-right text-ink-2')}>
                  <MoneyText value={row.baseline_average} />
                </td>
                <td className={cx(tdBase, 'text-right')}>
                  {isNew ? (
                    <Badge tone="neutral" title="No baseline: this category had no spend in the comparison periods">
                      new
                    </Badge>
                  ) : (
                    <Badge tone={changeTone(pct)} className="tabular">
                      {formatSignedPercent(row.change_pct, 0)}
                    </Badge>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
