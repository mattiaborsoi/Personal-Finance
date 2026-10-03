import { ArrowRight, LoaderCircle, MessageCircleQuestion, Sparkles } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage, isApiError, type AskOut } from '../api';
import { useConfig } from '../config/ConfigContext';
import { categoryLabel } from '../lib/format';
import { formatDate, periodLabel } from '../lib/dates';
import { accountLabel } from '../lib/format';
import { btnPrimary, btnSmall, cardInset, cx, eyebrow, inputBase, linkBase, tableBase, tdBase, thBase } from '../lib/ui';
import { Card } from './Card';
import { ErrorMessage } from './ErrorMessage';
import { MoneyText } from './MoneyText';

export const ASK_PLACEHOLDER = 'How much did we spend on travel this year?';
export const ASK_HINT =
  'Only the question leaves for the AI, with names and numbers masked; the answer is worked out here from your ledger.';
export const ASK_EXAMPLES = ['How much did we spend on groceries last month?', 'What did we spend by category in August?'];
export const CANNOT_ANSWER_PREFIX = 'That cannot be turned into a query';
export const AI_OFF_MESSAGE = 'AI is off, so questions cannot be asked. Turn it on under Settings, AI.';

/** How a grouped label reads: a month as "August 2026", an account by its name, a category with its group. */
function rowLabel(row: Record<string, string | number | null>, groupBy: string | null, accounts: ReturnType<typeof useConfig>['accounts']): string {
  const label = String(row.label ?? '');
  if (groupBy === 'month') return periodLabel(label);
  if (groupBy === 'account') return accountLabel(accounts, label);
  if (groupBy === 'category') return categoryLabel(label);
  return label || '(no name)';
}

/**
 * The Ask box: a question in plain English, answered from the ledger at home.
 * Rendered by the Transactions page only while `config.ai_enabled` is true.
 */
export function AskBox() {
  const config = useConfig();
  const id = useId();
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskOut | null>(null);

  if (config.ai_enabled !== true) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || asking) return;
    setAsking(true);
    setError(null);
    try {
      setResult(await api.ask(text));
    } catch (err) {
      setResult(null);
      if (isApiError(err, 422)) setError(`${CANNOT_ANSWER_PREFIX}: ${errorMessage(err)}`);
      else if (isApiError(err, 409)) setError(AI_OFF_MESSAGE);
      else setError(errorMessage(err));
    } finally {
      setAsking(false);
    }
  }

  const grouped = result && result.query.group_by && result.query.metric !== 'list' ? result.rows : [];
  const listed = result && result.query.metric === 'list' ? result.rows : [];

  return (
    <Card icon={MessageCircleQuestion} title="Ask" description={ASK_HINT}>
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="sr-only">
          Your question
        </label>
        <input
          id={id}
          type="text"
          className={cx(inputBase, 'min-w-0 flex-1 basis-72')}
          placeholder={ASK_PLACEHOLDER}
          value={question}
          maxLength={300}
          autoComplete="off"
          disabled={asking}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button type="submit" className={btnPrimary} disabled={asking || !question.trim()}>
          {asking ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}
          {asking ? 'Asking…' : 'Ask'}
        </button>
      </form>
      {!result && !error && (
        <p className="mt-2 text-xs text-ink-3">
          Try:{' '}
          {ASK_EXAMPLES.map((example, i) => (
            <span key={example}>
              {i > 0 && ' · '}
              <button type="button" className={cx(linkBase, 'text-xs')} onClick={() => setQuestion(example)}>
                {example}
              </button>
            </span>
          ))}
        </p>
      )}
      <ErrorMessage message={error} onDismiss={() => setError(null)} className="mt-3" />
      <div aria-live="polite">
        {result && (
          <div className={cx(cardInset, 'mt-3 space-y-3')} role="status" aria-label="Answer">
            <p className="text-lg font-semibold tracking-tight text-ink">{result.answer}</p>
            <p className="text-xs text-ink-3">{result.interpreted}</p>
            {grouped.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-hairline bg-surface">
                <table className={cx(tableBase, 'tabular')}>
                  <thead>
                    <tr>
                      <th scope="col" className={thBase}>
                        {result.query.group_by}
                      </th>
                      <th scope="col" className={cx(thBase, 'text-right')}>
                        Amount
                      </th>
                      <th scope="col" className={cx(thBase, 'text-right')}>
                        Lines
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {grouped.map((row) => (
                      <tr key={String(row.label)}>
                        <td className={tdBase}>{rowLabel(row, result.query.group_by, config.accounts)}</td>
                        <td className={cx(tdBase, 'text-right font-medium')}>
                          <MoneyText value={String(row.amount ?? '0')} />
                        </td>
                        <td className={cx(tdBase, 'text-right text-ink-2')}>{String(row.count ?? '')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {listed.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-hairline bg-surface">
                <table className={tableBase}>
                  <thead>
                    <tr>
                      <th scope="col" className={thBase}>
                        Date
                      </th>
                      <th scope="col" className={thBase}>
                        Merchant
                      </th>
                      <th scope="col" className={cx(thBase, 'hidden sm:table-cell')}>
                        Category
                      </th>
                      <th scope="col" className={cx(thBase, 'text-right')}>
                        Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {listed.map((row, i) => (
                      <tr key={`${String(row.date)}-${i}`}>
                        <td className={cx(tdBase, 'whitespace-nowrap text-ink-2')}>{formatDate(String(row.date ?? ''))}</td>
                        <td className={cx(tdBase, 'font-medium')}>{String(row.merchant ?? '')}</td>
                        <td className={cx(tdBase, 'hidden text-ink-2 sm:table-cell')}>{categoryLabel(String(row.category ?? ''))}</td>
                        <td className={cx(tdBase, 'text-right tabular')}>
                          <MoneyText value={String(row.amount ?? '0')} tone />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {result.link && (
              <Link to={result.link} className={cx(btnPrimary, btnSmall)}>
                {result.query.kind === 'settlement' ? 'Open the month' : 'Open in Transactions'}
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            )}
            <p className={cx(eyebrow, 'pt-1')}>Worked out on this server; the AI only saw the question.</p>
          </div>
        )}
      </div>
    </Card>
  );
}
