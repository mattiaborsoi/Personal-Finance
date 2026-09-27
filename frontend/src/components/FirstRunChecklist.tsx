import { ArrowRight, CircleCheck, Circle, Rocket } from 'lucide-react';
import { Link } from 'react-router-dom';
import { setupIncomplete, type SetupStep } from '../lib/setup';
import { cx, linkBase } from '../lib/ui';
import { Card } from './Card';

/** A compact first-run checklist; renders nothing once every step is done. */
export function FirstRunChecklist({ steps }: { steps: SetupStep[] }) {
  if (!setupIncomplete(steps)) return null;
  const done = steps.filter((s) => s.done).length;
  return (
    <Card icon={Rocket} title="Get started" description={`${done} of ${steps.length} done`}>
      <ol className="space-y-1">
        {steps.map((step) => (
          <li key={step.id} className="flex items-center gap-3 rounded-lg py-1.5 text-sm">
            {step.done ? (
              <CircleCheck className="h-4 w-4 shrink-0 text-good-ink" aria-hidden="true" />
            ) : (
              <Circle className="h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
            )}
            {step.done ? (
              <span className="text-ink-3">
                <span className="line-through">{step.label}</span>
                <span className="sr-only"> (done)</span>
              </span>
            ) : (
              <Link to={step.to} className={cx(linkBase, 'inline-flex items-center gap-1')}>
                {step.label}
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
